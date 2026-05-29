import { TicketPriority } from '../common/enums';

// Pure, framework-free. No DB, no Date.now() — caller always passes `now`.
// This is the single place where the escalation rules live; the cron handler
// and service are plumbing that call this function.

export interface EscalationInput {
  dueDate: Date | null;
  priority: TicketPriority;
  isOverdue: boolean;
}

export interface EscalationResult {
  newPriority: TicketPriority;
  newIsOverdue: boolean;
  changed: boolean;
}

const NEXT_PRIORITY: Record<TicketPriority, TicketPriority> = {
  [TicketPriority.LOW]: TicketPriority.MEDIUM,
  [TicketPriority.MEDIUM]: TicketPriority.HIGH,
  [TicketPriority.HIGH]: TicketPriority.CRITICAL,
  [TicketPriority.CRITICAL]: TicketPriority.CRITICAL, // terminal
};

export function escalateTicket(
  ticket: EscalationInput,
  now: Date,
): EscalationResult {
  const noChange: EscalationResult = {
    newPriority: ticket.priority,
    newIsOverdue: ticket.isOverdue,
    changed: false,
  };

  // No dueDate → escalation does not apply.
  if (ticket.dueDate === null) return noChange;

  // Not yet overdue (now is strictly before dueDate).
  if (now < ticket.dueDate) return noChange;

  // --- Overdue ---
  if (ticket.priority !== TicketPriority.CRITICAL) {
    return {
      newPriority: NEXT_PRIORITY[ticket.priority],
      newIsOverdue: ticket.isOverdue, // isOverdue is not touched during promotion
      changed: true,
    };
  }

  // Already CRITICAL and overdue: mark isOverdue.
  if (ticket.isOverdue) {
    // Already flagged → idempotent no-op.
    return noChange;
  }
  return {
    newPriority: TicketPriority.CRITICAL,
    newIsOverdue: true,
    changed: true,
  };
}
