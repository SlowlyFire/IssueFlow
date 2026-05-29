import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ActorContext } from '../audit/actor';
import { AuditActions, AuditEntityTypes } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { TicketStatus } from '../common/enums';
import { TicketDependency } from './ticket-dependency.entity';
import { Ticket } from './ticket.entity';

@Injectable()
export class TicketDependenciesService {
  constructor(
    @InjectRepository(TicketDependency)
    private readonly deps: Repository<TicketDependency>,
    @InjectRepository(Ticket)
    private readonly tickets: Repository<Ticket>,
    private readonly audit: AuditService,
  ) {}

  // ── Public API ──────────────────────────────────────────────────────────────

  async addDependency(
    ticketId: number,
    blockedById: number,
    actor: ActorContext,
  ): Promise<void> {
    if (ticketId === blockedById) {
      throw new BadRequestException(`A ticket cannot block itself`);
    }

    // findOne hides soft-deleted automatically — so a soft-deleted blocker
    // or target naturally becomes a 404, satisfying "soft-deleted tickets
    // cannot be added as blockers".
    const ticket = await this.tickets.findOne({ where: { id: ticketId } });
    if (!ticket) {
      throw new NotFoundException(`Ticket ${ticketId} not found`);
    }
    const blocker = await this.tickets.findOne({ where: { id: blockedById } });
    if (!blocker) {
      throw new NotFoundException(`Ticket ${blockedById} not found`);
    }

    if (ticket.projectId !== blocker.projectId) {
      throw new BadRequestException(
        `Tickets must be in the same project (ticket ${ticketId} is in project ${ticket.projectId}, blocker ${blockedById} is in project ${blocker.projectId})`,
      );
    }

    if (await this.wouldCreateCycle(ticketId, blockedById)) {
      throw new BadRequestException(
        `Adding this dependency would create a cycle (ticket ${blockedById} already transitively depends on ticket ${ticketId})`,
      );
    }

    // Idempotent: re-adding the same pair is a no-op rather than 409 — the
    // unique composite PK in the DB also enforces uniqueness as a backstop.
    // No audit row is written on the no-op path: nothing about the system
    // changed.
    const existing = await this.deps.findOne({
      where: { ticketId, blockedById },
    });
    if (existing) {
      return;
    }
    await this.deps.insert({ ticketId, blockedById });
    await this.audit.record({
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: AuditActions.DEPENDENCY_ADD,
      entityType: AuditEntityTypes.TICKET,
      entityId: ticketId,
      after: { ticketId, blockedById },
    });
  }

  async listDependencies(ticketId: number): Promise<Ticket[]> {
    const ticket = await this.tickets.findOne({ where: { id: ticketId } });
    if (!ticket) {
      throw new NotFoundException(`Ticket ${ticketId} not found`);
    }
    const rows = await this.deps.find({ where: { ticketId } });
    if (rows.length === 0) return [];
    const blockerIds = rows.map((r) => r.blockedById);
    // The In(...) query goes through the default scope, so any blocker
    // ticket that has been soft-deleted since the dependency was added is
    // silently filtered out — exactly what the spec asks for.
    return this.tickets.find({
      where: { id: In(blockerIds) },
      order: { id: 'ASC' },
    });
  }

  async removeDependency(
    ticketId: number,
    blockedById: number,
    actor: ActorContext,
  ): Promise<void> {
    const result = await this.deps.delete({ ticketId, blockedById });
    if (result.affected === 0) {
      throw new NotFoundException(
        `Dependency (ticket ${ticketId} blocked by ${blockedById}) not found`,
      );
    }
    await this.audit.record({
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: AuditActions.DEPENDENCY_REMOVE,
      entityType: AuditEntityTypes.TICKET,
      entityId: ticketId,
      before: { ticketId, blockedById },
      after: null,
    });
  }

  // Returns the ids of blockers that are NOT yet DONE (and not soft-deleted).
  // Used by TicketsService.update to gate transitions to DONE.
  async openBlockerIds(ticketId: number): Promise<number[]> {
    const blockers = await this.listDependencies(ticketId);
    return blockers
      .filter((b) => b.status !== TicketStatus.DONE)
      .map((b) => b.id);
  }

  // ── Cycle detection ────────────────────────────────────────────────────────
  // BFS from the proposed new blocker (`newBlockerId`) along the existing
  // blockedBy edges. A cycle would be created iff the target ticket
  // (`targetTicketId`) is already reachable from `newBlockerId` — because
  // after adding the edge `targetTicketId → newBlockerId`, the path
  // `targetTicketId → newBlockerId → … → targetTicketId` would close.
  //
  // O(V + E) over the project's dependency graph; in practice the graph is
  // tiny so per-step queries are fine (no need to load the whole graph up
  // front).
  private async wouldCreateCycle(
    targetTicketId: number,
    newBlockerId: number,
  ): Promise<boolean> {
    const visited = new Set<number>();
    const queue: number[] = [newBlockerId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      if (current === targetTicketId) return true;
      const rows = await this.deps.find({ where: { ticketId: current } });
      for (const r of rows) {
        if (!visited.has(r.blockedById)) {
          queue.push(r.blockedById);
        }
      }
    }
    return false;
  }
}
