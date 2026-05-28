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
import { TicketStatus } from '../common/enums';
import { ProjectsService } from '../projects/projects.service';
import { UsersService } from '../users/users.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { Ticket } from './ticket.entity';
import {
  assertTransitionAllowed,
  InvalidTicketTransitionError,
} from './ticket-state-machine';

function parseIfMatch(ifMatch: string | undefined): number {
  if (ifMatch === undefined || ifMatch === '') {
    throw new HttpException(
      'If-Match header is required for ticket updates (carry the version you loaded, e.g. If-Match: "3")',
      HttpStatus.PRECONDITION_REQUIRED, // 428
    );
  }
  // Tolerate quoted or unquoted, and weak ETags: '"3"', '3', 'W/"3"' all fine.
  const normalized = ifMatch.replace(/^W\//, '').replace(/"/g, '').trim();
  const v = Number(normalized);
  if (!Number.isInteger(v) || v < 0) {
    throw new BadRequestException(
      'If-Match must be a non-negative integer (the ticket version)',
    );
  }
  return v;
}

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
  ) {}

  async create(dto: CreateTicketDto): Promise<Ticket> {
    // Throws 404 if project missing or soft-deleted.
    await this.projects.findOne(dto.projectId);
    if (dto.assigneeId !== undefined) {
      await this.users.findOne(dto.assigneeId);
    }
    const ticket = this.tickets.create({
      title: dto.title,
      description: dto.description ?? null,
      status: dto.status ?? TicketStatus.TODO,
      priority: dto.priority,
      type: dto.type,
      projectId: dto.projectId,
      assigneeId: dto.assigneeId ?? null,
      dueDate: dto.dueDate ?? null,
    });
    return this.tickets.save(ticket);
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
  ): Promise<Ticket> {
    const ticket = await this.findOne(id);

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
      try {
        assertTransitionAllowed(ticket.status, dto.status, {
          // TODO(session-5): replace with real blocker computation from
          // the ticket_dependencies table.
          blockersAllDone: true,
        });
      } catch (e) {
        if (e instanceof InvalidTicketTransitionError) {
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
    return this.findOne(id);
  }

  async softDelete(id: number): Promise<void> {
    const ticket = await this.findOne(id);
    await this.tickets.softRemove(ticket);
  }

  // ADMIN-only ─────────────────────────────────────────────────────────────────

  async listDeleted(projectId: number): Promise<Ticket[]> {
    return this.tickets.find({
      withDeleted: true,
      where: { projectId, deletedAt: Not(IsNull()) },
      order: { deletedAt: 'DESC' },
    });
  }

  async restore(id: number): Promise<void> {
    const ticket = await this.tickets.findOne({
      withDeleted: true,
      where: { id, deletedAt: Not(IsNull()) },
    });
    if (!ticket) {
      throw new NotFoundException(`Soft-deleted ticket ${id} not found`);
    }
    await this.tickets.restore(id);
  }
}
