import { TicketPriority, TicketStatus } from '../common/enums';
import { escalateTicket } from './escalation';

// Helper: build a minimal ticket-shaped object for pure-function tests.
// Only the fields escalateTicket actually reads are required.
function ticket(
  opts: Partial<{
    dueDate: Date | null;
    priority: TicketPriority;
    isOverdue: boolean;
    status: TicketStatus;
  }> = {},
) {
  return {
    dueDate: null,
    priority: TicketPriority.LOW,
    isOverdue: false,
    status: TicketStatus.TODO,
    ...opts,
  };
}

const NOW = new Date('2026-06-01T12:00:00Z');
const PAST = new Date('2026-05-01T00:00:00Z');  // before NOW → overdue
const FUTURE = new Date('2026-07-01T00:00:00Z'); // after NOW → not overdue

describe('escalateTicket — pure escalation logic', () => {
  it('dueDate null → no change (escalation does not apply)', () => {
    const r = escalateTicket(ticket({ dueDate: null }), NOW);
    expect(r.changed).toBe(false);
  });

  it('dueDate in the future → no change (not yet overdue)', () => {
    const r = escalateTicket(
      ticket({ dueDate: FUTURE, priority: TicketPriority.LOW }),
      NOW,
    );
    expect(r.changed).toBe(false);
  });

  it('dueDate exactly equal to now → treated as overdue (boundary: not < dueDate)', () => {
    const r = escalateTicket(
      ticket({ dueDate: NOW, priority: TicketPriority.LOW }),
      NOW,
    );
    expect(r.changed).toBe(true);
    expect(r.newPriority).toBe(TicketPriority.MEDIUM);
  });

  it('LOW + overdue → MEDIUM, isOverdue unchanged (false)', () => {
    const r = escalateTicket(
      ticket({ dueDate: PAST, priority: TicketPriority.LOW, isOverdue: false }),
      NOW,
    );
    expect(r.changed).toBe(true);
    expect(r.newPriority).toBe(TicketPriority.MEDIUM);
    expect(r.newIsOverdue).toBe(false);
  });

  it('MEDIUM + overdue → HIGH, isOverdue unchanged', () => {
    const r = escalateTicket(
      ticket({ dueDate: PAST, priority: TicketPriority.MEDIUM }),
      NOW,
    );
    expect(r.changed).toBe(true);
    expect(r.newPriority).toBe(TicketPriority.HIGH);
    expect(r.newIsOverdue).toBe(false);
  });

  it('HIGH + overdue → CRITICAL, isOverdue still false at this step', () => {
    const r = escalateTicket(
      ticket({ dueDate: PAST, priority: TicketPriority.HIGH, isOverdue: false }),
      NOW,
    );
    expect(r.changed).toBe(true);
    expect(r.newPriority).toBe(TicketPriority.CRITICAL);
    expect(r.newIsOverdue).toBe(false);
  });

  it('CRITICAL + overdue + isOverdue false → CRITICAL + isOverdue true, changed: true', () => {
    const r = escalateTicket(
      ticket({ dueDate: PAST, priority: TicketPriority.CRITICAL, isOverdue: false }),
      NOW,
    );
    expect(r.changed).toBe(true);
    expect(r.newPriority).toBe(TicketPriority.CRITICAL);
    expect(r.newIsOverdue).toBe(true);
  });

  it('CRITICAL + overdue + isOverdue true → no change (idempotent)', () => {
    const r = escalateTicket(
      ticket({ dueDate: PAST, priority: TicketPriority.CRITICAL, isOverdue: true }),
      NOW,
    );
    expect(r.changed).toBe(false);
  });

  it('the function is stateless — calling twice gives the same result', () => {
    const t = ticket({ dueDate: PAST, priority: TicketPriority.LOW });
    const r1 = escalateTicket(t, NOW);
    const r2 = escalateTicket(t, NOW);
    expect(r1).toEqual(r2);
  });
});
