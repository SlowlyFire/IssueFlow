import {
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { ActorContext } from '../audit/actor';
import { AuditActions, AuditEntityTypes } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { parseIfMatch } from '../common/if-match';
import { Ticket } from '../tickets/ticket.entity';
import { User } from '../users/user.entity';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';
import { extractMentions } from './mention-parser';
import { Mention } from './mention.entity';
import { Comment } from './comment.entity';

export interface MentionedUser {
  id: number;
  username: string;
  fullName: string;
}

export type CommentWithMentions = Comment & { mentionedUsers: MentionedUser[] };

export interface PaginatedComments {
  data: CommentWithMentions[];
  total: number;
  page: number;
}

@Injectable()
export class CommentsService {
  constructor(
    @InjectRepository(Comment) private readonly comments: Repository<Comment>,
    @InjectRepository(Mention) private readonly mentions: Repository<Mention>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Ticket) private readonly tickets: Repository<Ticket>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  // ── Create ────────────────────────────────────────────────────────────────
  // Wrapped in a transaction: comment INSERT + N mention INSERTs together,
  // because a comment whose mentions are partially recorded would leave the
  // mention table inconsistent with the content forever — and inconsistency
  // here is silently wrong (the user sees "@alice" in the text but is not
  // notified). Same reasoning as update().
  async create(
    ticketId: number,
    dto: CreateCommentDto,
    actor: ActorContext,
  ): Promise<CommentWithMentions> {
    await this.assertTicketExists(ticketId);
    await this.assertUserExists(dto.authorId);

    const result = await this.dataSource.transaction(async (mgr) => {
      const saved = await mgr.getRepository(Comment).save(
        mgr.getRepository(Comment).create({
          ticketId,
          authorId: dto.authorId,
          content: dto.content,
        }),
      );
      const mentionedUserIds = await this.resolveMentionsFromContent(
        mgr,
        dto.content,
      );
      if (mentionedUserIds.length > 0) {
        await mgr.getRepository(Mention).insert(
          mentionedUserIds.map((mid) => ({
            commentId: saved.id,
            mentionedUserId: mid,
          })),
        );
      }
      return { saved, mentionedUserIds };
    });

    const enriched = await this.enrichOne(result.saved);

    await this.audit.record({
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: AuditActions.COMMENT_CREATE,
      entityType: AuditEntityTypes.COMMENT,
      entityId: result.saved.id,
      after: { ...result.saved, mentionedUserIds: result.mentionedUserIds },
    });

    return enriched;
  }

  // ── Read (list + single) ─────────────────────────────────────────────────
  async findByTicket(ticketId: number): Promise<CommentWithMentions[]> {
    await this.assertTicketExists(ticketId);
    const comments = await this.comments.find({
      where: { ticketId },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    return this.enrichMany(comments);
  }

  async findOne(
    ticketId: number,
    commentId: number,
  ): Promise<CommentWithMentions> {
    const comment = await this.comments.findOne({
      where: { id: commentId, ticketId },
    });
    if (!comment) {
      throw new NotFoundException(
        `Comment ${commentId} not found on ticket ${ticketId}`,
      );
    }
    return this.enrichOne(comment);
  }

  // ── Update (the diffing one) ──────────────────────────────────────────────
  // The transaction here protects the comment row + the mention table
  // together. Why this is the ONE place we transact (vs the audit calls
  // that are post-commit and not transacted): an audit row that fails to
  // write means we lose a historical entry — recoverable manually, doesn't
  // corrupt user-visible data. A half-applied mention diff means
  // mention rows disagree with the comment content — silently wrong
  // forever, with no observable surface to detect it.
  async update(
    ticketId: number,
    commentId: number,
    dto: UpdateCommentDto,
    ifMatch: string | undefined,
    actor: ActorContext,
  ): Promise<CommentWithMentions> {
    const expectedVersion = parseIfMatch(ifMatch);

    const txResult = await this.dataSource.transaction(async (mgr) => {
      const cRepo = mgr.getRepository(Comment);
      const mRepo = mgr.getRepository(Mention);

      const comment = await cRepo.findOne({
        where: { id: commentId, ticketId },
      });
      if (!comment) {
        throw new NotFoundException(
          `Comment ${commentId} not found on ticket ${ticketId}`,
        );
      }
      if (comment.version !== expectedVersion) {
        throw new HttpException(
          `Comment was modified since you loaded it (current version ${comment.version}, you sent ${expectedVersion}); reload and retry`,
          HttpStatus.PRECONDITION_FAILED,
        );
      }

      const before = { ...comment };

      // Atomic conditional UPDATE (same pattern as Ticket.update — the
      // version-in-WHERE check catches races that slipped past the explicit
      // pre-check above).
      const result = await cRepo
        .createQueryBuilder()
        .update(Comment)
        .set({
          content: dto.content,
          version: () => 'version + 1',
          updatedAt: () => 'now()',
        })
        .where('id = :id AND version = :v', {
          id: commentId,
          v: expectedVersion,
        })
        .execute();

      if (result.affected === 0) {
        throw new HttpException(
          `Comment was modified concurrently (race detected at write); reload and retry`,
          HttpStatus.PRECONDITION_FAILED,
        );
      }

      // ── Diff the mentions ─────────────────────────────────────────────
      // Set old = currently-stored mention user ids.
      // Set new = mentions parsed from the new content, resolved against
      //           the users table.
      // toInsert = new \ old      (rows to add)
      // toDelete = old \ new      (rows to remove)
      // unchanged = new ∩ old     (rows to leave alone — they keep their PKs)
      const existing = await mRepo.find({ where: { commentId } });
      const oldIds = new Set(existing.map((m) => m.mentionedUserId));
      const resolved = await this.resolveMentionsFromContent(mgr, dto.content);
      const newIds = new Set(resolved);

      const toInsert = [...newIds].filter((id) => !oldIds.has(id));
      const toDelete = [...oldIds].filter((id) => !newIds.has(id));
      const unchanged = [...newIds].filter((id) => oldIds.has(id));

      if (toDelete.length > 0) {
        await mRepo.delete({
          commentId,
          mentionedUserId: In(toDelete),
        });
      }
      if (toInsert.length > 0) {
        await mRepo.insert(
          toInsert.map((mid) => ({ commentId, mentionedUserId: mid })),
        );
      }

      const after = await cRepo.findOne({ where: { id: commentId } });
      return {
        before,
        after: after!,
        mentionDiff: { added: toInsert, removed: toDelete, unchanged },
      };
    });

    // Audit OUTSIDE the txn: if the txn rolled back, control never gets
    // here; if it committed, the audit reflects committed state.
    const enriched = await this.enrichOne(txResult.after);
    await this.audit.record({
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: AuditActions.COMMENT_UPDATE,
      entityType: AuditEntityTypes.COMMENT,
      entityId: commentId,
      before: txResult.before,
      after: { ...txResult.after, mentionDiff: txResult.mentionDiff },
    });
    return enriched;
  }

  // ── Delete (transactional — mentions then comment) ────────────────────────
  async remove(
    ticketId: number,
    commentId: number,
    actor: ActorContext,
  ): Promise<void> {
    const before = await this.dataSource.transaction(async (mgr) => {
      const cRepo = mgr.getRepository(Comment);
      const mRepo = mgr.getRepository(Mention);

      const comment = await cRepo.findOne({
        where: { id: commentId, ticketId },
      });
      if (!comment) {
        throw new NotFoundException(
          `Comment ${commentId} not found on ticket ${ticketId}`,
        );
      }
      const snapshot = { ...comment };
      // Delete mention rows first so we don't briefly have orphans pointing
      // at a deleted comment. (No FK constraint exists between mentions
      // and comments — we enforce referential integrity in code.)
      await mRepo.delete({ commentId });
      await cRepo.delete(commentId);
      return snapshot;
    });

    await this.audit.record({
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: AuditActions.COMMENT_DELETE,
      entityType: AuditEntityTypes.COMMENT,
      entityId: commentId,
      before,
      after: null,
    });
  }

  // ── Mentions for a user (the public GET /users/:id/mentions backing) ─────
  async findMentionsForUser(
    userId: number,
    page: number,
    pageSize: number,
  ): Promise<PaginatedComments> {
    // Verify the user exists for a clean 404 (rather than an empty array
    // for a fictional userId).
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }

    // One query for the page of comments. The INNER JOIN to Mention scopes
    // to "comments where this user is mentioned"; ORDER BY createdAt DESC
    // gives newest first per the spec.
    const qb = this.comments
      .createQueryBuilder('c')
      .innerJoin(Mention, 'm', 'm.commentId = c.id')
      .where('m.mentionedUserId = :userId', { userId })
      .orderBy('c.createdAt', 'DESC')
      .addOrderBy('c.id', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    const [comments, total] = await qb.getManyAndCount();
    const data = await this.enrichMany(comments);
    return { data, total, page };
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  private async assertTicketExists(ticketId: number): Promise<void> {
    // Standard findOne hides soft-deleted; this is what we want — comments
    // can't be added to a soft-deleted ticket.
    const ticket = await this.tickets.findOne({ where: { id: ticketId } });
    if (!ticket) {
      throw new NotFoundException(`Ticket ${ticketId} not found`);
    }
  }

  private async assertUserExists(userId: number): Promise<void> {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }
  }

  // Take raw content → extract candidate names → resolve case-insensitively
  // against the users table → return the matching user ids. Unknown @names
  // are silently dropped per the spec.
  private async resolveMentionsFromContent(
    mgr: EntityManager,
    content: string,
  ): Promise<number[]> {
    const candidates = extractMentions(content);
    if (candidates.length === 0) return [];
    const rows = await mgr
      .getRepository(User)
      .createQueryBuilder('u')
      .select(['u.id'])
      .where('LOWER(u.username) IN (:...names)', { names: candidates })
      .getMany();
    return rows.map((r) => r.id);
  }

  private async enrichOne(comment: Comment): Promise<CommentWithMentions> {
    const map = await this.mentionsForComments([comment.id]);
    return { ...comment, mentionedUsers: map.get(comment.id) ?? [] };
  }

  private async enrichMany(
    comments: Comment[],
  ): Promise<CommentWithMentions[]> {
    if (comments.length === 0) return [];
    const map = await this.mentionsForComments(comments.map((c) => c.id));
    return comments.map((c) => ({
      ...c,
      mentionedUsers: map.get(c.id) ?? [],
    }));
  }

  // ONE query to fetch every mentioned user for every comment in the
  // batch — bounded by O(rows), no N+1. The grouping by commentId is done
  // in memory (cheap; comments-per-ticket is small).
  private async mentionsForComments(
    commentIds: number[],
  ): Promise<Map<number, MentionedUser[]>> {
    const map = new Map<number, MentionedUser[]>();
    if (commentIds.length === 0) return map;
    const rows = await this.mentions
      .createQueryBuilder('m')
      .innerJoin(User, 'u', 'u.id = m.mentionedUserId')
      .where('m.commentId IN (:...ids)', { ids: commentIds })
      .select([
        'm."commentId" AS "commentId"',
        'u.id AS "userId"',
        'u.username AS username',
        'u."fullName" AS "fullName"',
      ])
      .orderBy('u.id', 'ASC')
      .getRawMany<{
        commentId: number;
        userId: number;
        username: string;
        fullName: string;
      }>();
    for (const r of rows) {
      const cid = Number(r.commentId);
      const list = map.get(cid) ?? [];
      list.push({
        id: Number(r.userId),
        username: r.username,
        fullName: r.fullName,
      });
      map.set(cid, list);
    }
    return map;
  }
}
