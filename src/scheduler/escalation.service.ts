import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { instanceToPlain } from 'class-transformer';
import { DataSource, Repository } from 'typeorm';
import { AuditLog } from '../audit/audit-log.entity';
import { AuditActions, AuditEntityTypes } from '../audit/audit-actions';
import { ActorType, TicketPriority, TicketStatus } from '../common/enums';
import { Ticket } from '../tickets/ticket.entity';
import { escalateTicket } from './escalation';

export interface EscalationCycleSummary {
  scanned: number;
  escalated: number;
  criticalMarked: number;
}

@Injectable()
export class EscalationService {
  private readonly logger = new Logger(EscalationService.name);

  // Prevents two concurrent cycles from racing on the same ticket versions.
  // If the cron fires while a previous cycle is still executing (e.g., large
  // ticket volume + short interval), the incoming tick is dropped and the
  // guard resets in the `finally` block so the next tick runs normally.
  private isRunning = false;

  constructor(
    @InjectRepository(Ticket)
    private readonly tickets: Repository<Ticket>,
    private readonly dataSource: DataSource,
  ) {}

  // NOTE ON ENV VAR: @Cron arguments are evaluated at class-definition time
  // (when the module file is first imported), before ConfigModule.forRoot()
  // loads the .env file. ESCALATION_CRON must therefore be exported in the
  // shell environment before starting the process if you want a non-default
  // schedule. The .env.example documents the variable for reference.
  @Cron(process.env['ESCALATION_CRON'] || '*/15 * * * *')
  async handleCron(): Promise<void> {
    this.logger.log('Escalation cycle starting...');
    try {
      const summary = await this.runEscalationCycle();
      this.logger.log(
        `Escalation cycle complete — scanned:${summary.scanned} escalated:${summary.escalated} criticalMarked:${summary.criticalMarked}`,
      );
    } catch (err) {
      this.logger.error('Escalation cycle failed', err);
    }
  }

  async runEscalationCycle(now = new Date()): Promise<EscalationCycleSummary> {
    if (this.isRunning) {
      this.logger.warn('Escalation cycle already running; skipping this tick');
      return { scanned: 0, escalated: 0, criticalMarked: 0 };
    }
    this.isRunning = true;

    const summary: EscalationCycleSummary = {
      scanned: 0,
      escalated: 0,
      criticalMarked: 0,
    };

    try {
      // One query for all eligible candidates:
      //   - deletedAt IS NULL: TypeORM adds this automatically via @DeleteDateColumn.
      //   - dueDate IS NOT NULL: escalation only applies when a due date is set.
      //   - status != DONE: DONE tickets are frozen by the business rule; their
      //     priority must not change. We filter at load time for efficiency and
      //     clarity rather than letting the conditional UPDATE silently skip them.
      //   - NOT (priority = CRITICAL AND isOverdue = true): already at max
      //     escalation state; no further action is possible or needed.
      const candidates = await this.tickets
        .createQueryBuilder('t')
        .where('t.dueDate IS NOT NULL')
        .andWhere('t.status != :done', { done: TicketStatus.DONE })
        .andWhere('(t.priority != :crit OR t.isOverdue = false)', {
          crit: TicketPriority.CRITICAL,
        })
        .getMany();

      summary.scanned = candidates.length;

      for (const ticket of candidates) {
        const result = escalateTicket(ticket, now);
        if (!result.changed) continue;

        const before = { ...ticket };
        const after = {
          ...before,
          priority: result.newPriority,
          isOverdue: result.newIsOverdue,
          version: ticket.version + 1,
        };

        // Atomic UPDATE + audit INSERT in a single transaction.
        // If a user PATCHed this ticket between our SELECT and now, its version
        // has changed and WHERE id=? AND version=? matches zero rows — we skip
        // the audit row too (no state change occurred from our perspective) and
        // the next cycle will re-evaluate with the updated state.
        // Wrapping both operations in a transaction ensures they are
        // all-or-nothing: if the audit INSERT fails after the UPDATE commits,
        // we would have silent system-driven state changes with no audit record.
        const committed = await this.dataSource.transaction(async (em) => {
          const r = await em
            .createQueryBuilder()
            .update(Ticket)
            .set({
              priority: result.newPriority,
              isOverdue: result.newIsOverdue,
              version: () => 'version + 1',
              updatedAt: () => 'now()',
            })
            .where('id = :id AND version = :v', {
              id: ticket.id,
              v: ticket.version,
            })
            .execute();

          if ((r.affected ?? 0) === 0) return false;

          await em.insert(AuditLog, {
            actorType: ActorType.SYSTEM,
            actorId: null,
            action: AuditActions.AUTO_ESCALATE,
            entityType: AuditEntityTypes.TICKET,
            entityId: ticket.id,
            beforeJson: instanceToPlain(before) as Record<string, unknown>,
            afterJson: instanceToPlain(after) as Record<string, unknown>,
          });

          return true;
        });

        if (committed) {
          if (ticket.priority === TicketPriority.CRITICAL) {
            summary.criticalMarked++;
          } else {
            summary.escalated++;
          }
        }
      }
    } finally {
      this.isRunning = false;
    }

    return summary;
  }
}
