import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { ActorContext } from '../audit/actor';
import { AuditActions, AuditEntityTypes } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { ActorType, TicketStatus } from '../common/enums';
import { parseIfMatch } from '../common/if-match';
import { ProjectsService } from '../projects/projects.service';
import { WorkloadService } from '../projects/workload.service';
import { UsersService } from '../users/users.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { TicketDependenciesService } from './ticket-dependencies.service';
import { Ticket } from './ticket.entity';
import {
  assertTransitionAllowed,
  InvalidTicketTransitionError,
} from './ticket-state-machine';

// Mirrors the soft-delete pattern documented in projects.service.ts:
//   - standard reads exclude deletedAt IS NOT NULL automatically (TypeORM)
//   - listDeleted: withDeleted: true + Not(IsNull())
//   - restore: confirm soft-deleted exists, then repository.restore()
//
// Update flow (order matters — see README/CLAUDE.md):
//   1. Load (404 if missing — TypeORM auto-hides soft-deleted)
//   2. DONE-frozen guard: if current status is DONE, 409 — terminal/frozen
//      tickets reject ALL field updates, including a no-op same-status
//      update. This check runs BEFORE any version logic because the
//      resource is read-only; a stale-version error would lie about why
//      the write failed.
//   3. Explicit If-Match version check: 412 if mismatch.
//   4. State-machine: if status is changing, assertTransitionAllowed.
//      InvalidTicketTransitionError → 400 with the rule-naming message.
//      blockersAllDone is hard-coded true for now; Session 5 will compute
//      real blocker state from the dependencies table.
//   5. Atomic UPDATE … WHERE id = ? AND version = ?. Second line of
//      defense for races between step 3 and now: Postgres serializes by
//      the row lock, so exactly one concurrent writer's UPDATE finds
//      version = N; the other finds version = N+1 and reports affected = 0,
//      which we map to 412. (We do NOT rely on TypeORM's @VersionColumn
//      to raise OptimisticLockVersionMismatchError on save() — in 0.3.x
//      save() auto-increments the column but does NOT include version in
//      the WHERE clause, so it would silently overwrite a concurrent
//      writer. The explicit conditional UPDATE here is the real lock.)
@Injectable()
export class TicketsService {
  constructor(
    @InjectRepository(Ticket)
    private readonly tickets: Repository<Ticket>,
    private readonly projects: ProjectsService,
    private readonly users: UsersService,
    private readonly deps: TicketDependenciesService,
    private readonly workload: WorkloadService,
    private readonly audit: AuditService,
  ) {}

  async create(dto: CreateTicketDto, actor: ActorContext): Promise<Ticket> {
    // Throws 404 if project missing or soft-deleted.
    await this.projects.findOne(dto.projectId);

    // Auto-assignment: only fires when the caller didn't supply an
    // assigneeId. If supplied, we honor it (after validating it exists).
    // Never on update — Session 4's update flow already accepts assigneeId
    // verbatim from the client.
    let assigneeId: number | null;
    let autoAssigned = false;
    if (dto.assigneeId === undefined) {
      assigneeId = await this.workload.pickAutoAssignee(dto.projectId);
      autoAssigned = assigneeId !== null;
    } else {
      await this.users.findOne(dto.assigneeId);
      assigneeId = dto.assigneeId;
    }

    const ticket = this.tickets.create({
      title: dto.title,
      description: dto.description ?? null,
      status: dto.status ?? TicketStatus.TODO,
      priority: dto.priority,
      type: dto.type,
      projectId: dto.projectId,
      assigneeId,
      dueDate: dto.dueDate ?? null,
    });
    const saved = await this.tickets.save(ticket);

    // TICKET_CREATE always — captures who initiated the creation and the
    // full saved state.
    await this.audit.record({
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: AuditActions.TICKET_CREATE,
      entityType: AuditEntityTypes.TICKET,
      entityId: saved.id,
      after: saved,
    });

    // AUTO_ASSIGN is an ADDITIONAL row when assignee came from the
    // workload picker — kept separate so the operator can distinguish
    // system-driven from user-driven assignment. Carrying both rows means
    // an auto-assigned-on-create ticket has 2 audit entries; a
    // manually-assigned one has just the TICKET_CREATE.
    if (autoAssigned) {
      await this.audit.record({
        actorType: ActorType.SYSTEM,
        actorId: null,
        action: AuditActions.AUTO_ASSIGN,
        entityType: AuditEntityTypes.TICKET,
        entityId: saved.id,
        after: { assigneeId },
      });
    }

    return saved;
  }

  async findByProject(projectId: number): Promise<Ticket[]> {
    // Validates the project exists (and isn't soft-deleted) so the caller
    // gets a clean 404 rather than an empty array for a fictional project.
    await this.projects.findOne(projectId);
    return this.tickets.find({
      where: { projectId },
      order: { id: 'ASC' },
    });
  }

  async findOne(id: number): Promise<Ticket> {
    const ticket = await this.tickets.findOne({ where: { id } });
    if (!ticket) {
      throw new NotFoundException(`Ticket ${id} not found`);
    }
    return ticket;
  }

  async update(
    id: number,
    dto: UpdateTicketDto,
    ifMatch: string | undefined,
    actor: ActorContext,
  ): Promise<Ticket> {
    const ticket = await this.findOne(id);
    // Snapshot before BEFORE we mutate / throw / lock-check. If a later
    // step throws (409, 412, 400), the audit call at the bottom is never
    // reached so this snapshot is harmless — no row in audit_logs.
    const before = { ...ticket };

    // 1. DONE-frozen: runs FIRST, before any version logic. A frozen
    // resource should report its frozen-ness, not lie about a missing or
    // stale version header.
    if (ticket.status === TicketStatus.DONE) {
      throw new ConflictException(
        'Ticket is DONE (frozen): no field may be updated',
      );
    }

    // 2. Explicit optimistic-lock check — parse + validate the header now
    // that we know the resource is editable.
    const expectedVersion = parseIfMatch(ifMatch);
    if (ticket.version !== expectedVersion) {
      throw new HttpException(
        `Ticket was modified since you loaded it (current version ${ticket.version}, you sent ${expectedVersion}); reload and retry`,
        HttpStatus.PRECONDITION_FAILED,
      );
    }

    // 3. State-machine transition check (only when status is changing).
    if (dto.status !== undefined && dto.status !== ticket.status) {
      // Real blocker computation — replaces Session 4's hard-coded `true`.
      // We compute the list of open (non-DONE, non-soft-deleted) blockers
      // BOTH so the state-machine receives the real boolean AND so the
      // catch path can name them in the rejection message. The state
      // machine remains the single source of truth for the rule; the
      // service merely enriches the error.
      let openBlockerIds: number[] = [];
      let blockersAllDone = true;
      if (dto.status === TicketStatus.DONE) {
        openBlockerIds = await this.deps.openBlockerIds(ticket.id);
        blockersAllDone = openBlockerIds.length === 0;
      }
      try {
        assertTransitionAllowed(ticket.status, dto.status, { blockersAllDone });
      } catch (e) {
        if (e instanceof InvalidTicketTransitionError) {
          if (!blockersAllDone) {
            throw new BadRequestException(
              `Cannot transition to DONE: blocked by tickets [${openBlockerIds.join(', ')}]`,
            );
          }
          throw new BadRequestException(e.message);
        }
        throw e;
      }
    }

    // Validate new assignee references a real user.
    if (dto.assigneeId !== undefined && dto.assigneeId !== ticket.assigneeId) {
      await this.users.findOne(dto.assigneeId);
    }

    // 4. Build the change-set (only the fields the client supplied).
    const changes: QueryDeepPartialEntity<Ticket> = {
      version: () => 'version + 1',
      updatedAt: () => 'now()',
    };
    if (dto.title !== undefined) changes.title = dto.title;
    if (dto.description !== undefined) changes.description = dto.description;
    if (dto.status !== undefined) changes.status = dto.status;
    if (dto.priority !== undefined) changes.priority = dto.priority;
    if (dto.assigneeId !== undefined) changes.assigneeId = dto.assigneeId;
    if (dto.dueDate !== undefined) changes.dueDate = dto.dueDate;

    // 5. Atomic conditional UPDATE. If a concurrent writer slipped past
    // the explicit check above (their save committed between our findOne
    // and this UPDATE), the row's version is now N+1, our WHERE matches
    // zero rows, and we report the race honestly with a 412.
    const result = await this.tickets
      .createQueryBuilder()
      .update(Ticket)
      .set(changes)
      .where('id = :id AND version = :v', { id, v: expectedVersion })
      .execute();

    if (result.affected === 0) {
      throw new HttpException(
        `Ticket was modified concurrently (race detected at write); reload and retry`,
        HttpStatus.PRECONDITION_FAILED,
      );
    }

    // 6. Reload and return so the response carries the new version.
    const after = await this.findOne(id);
    // 7. Audit AFTER the DB write succeeded. Any throw above (404, 409,
    // 412, 400 from the state machine, or the race detection 412) skips
    // this entirely — failed operations never leave a row in audit_logs.
    await this.audit.record({
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: AuditActions.TICKET_UPDATE,
      entityType: AuditEntityTypes.TICKET,
      entityId: id,
      before,
      after,
    });
    return after;
  }

  async softDelete(id: number, actor: ActorContext): Promise<void> {
    const ticket = await this.findOne(id);
    const before = { ...ticket };
    const removed = await this.tickets.softRemove(ticket);
    await this.audit.record({
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: AuditActions.TICKET_DELETE,
      entityType: AuditEntityTypes.TICKET,
      entityId: id,
      before,
      after: removed,
    });
  }

  // ADMIN-only ─────────────────────────────────────────────────────────────────

  async listDeleted(projectId: number): Promise<Ticket[]> {
    return this.tickets.find({
      withDeleted: true,
      where: { projectId, deletedAt: Not(IsNull()) },
      order: { deletedAt: 'DESC' },
    });
  }

  async restore(id: number, actor: ActorContext): Promise<void> {
    const ticket = await this.tickets.findOne({
      withDeleted: true,
      where: { id, deletedAt: Not(IsNull()) },
    });
    if (!ticket) {
      throw new NotFoundException(`Soft-deleted ticket ${id} not found`);
    }
    const before = { ...ticket };
    await this.tickets.restore(id);
    const restored = await this.findOne(id);
    await this.audit.record({
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: AuditActions.TICKET_RESTORE,
      entityType: AuditEntityTypes.TICKET,
      entityId: id,
      before,
      after: restored,
    });
  }
}
