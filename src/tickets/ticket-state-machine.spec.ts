import { TicketStatus } from '../common/enums';
import {
  assertTransitionAllowed,
  InvalidTicketTransitionError,
} from './ticket-state-machine';

const allDone = { blockersAllDone: true };
const blockersPending = { blockersAllDone: false };

describe('Ticket state machine — assertTransitionAllowed', () => {
  describe('legal forward transitions', () => {
    it('allows TODO → IN_PROGRESS', () => {
      expect(() =>
        assertTransitionAllowed(
          TicketStatus.TODO,
          TicketStatus.IN_PROGRESS,
          allDone,
        ),
      ).not.toThrow();
    });

    it('allows IN_PROGRESS → IN_REVIEW', () => {
      expect(() =>
        assertTransitionAllowed(
          TicketStatus.IN_PROGRESS,
          TicketStatus.IN_REVIEW,
          allDone,
        ),
      ).not.toThrow();
    });

    it('allows IN_REVIEW → DONE when all blockers are DONE', () => {
      expect(() =>
        assertTransitionAllowed(
          TicketStatus.IN_REVIEW,
          TicketStatus.DONE,
          allDone,
        ),
      ).not.toThrow();
    });
  });

  describe('skipping forward (decision: REJECT — lifecycle is sequential per CLAUDE.md)', () => {
    it.each([
      [TicketStatus.TODO, TicketStatus.IN_REVIEW],
      [TicketStatus.TODO, TicketStatus.DONE],
      [TicketStatus.IN_PROGRESS, TicketStatus.DONE],
    ])('rejects %s → %s', (current, target) => {
      expect(() =>
        assertTransitionAllowed(current, target, allDone),
      ).toThrow(InvalidTicketTransitionError);
      expect(() =>
        assertTransitionAllowed(current, target, allDone),
      ).toThrow(/skip|sequential/i);
    });
  });

  describe('backward transitions (always rejected)', () => {
    it.each([
      [TicketStatus.IN_PROGRESS, TicketStatus.TODO],
      [TicketStatus.IN_REVIEW, TicketStatus.TODO],
      [TicketStatus.IN_REVIEW, TicketStatus.IN_PROGRESS],
      [TicketStatus.DONE, TicketStatus.IN_PROGRESS],
      [TicketStatus.DONE, TicketStatus.TODO],
      [TicketStatus.DONE, TicketStatus.IN_REVIEW],
    ])('rejects %s → %s', (current, target) => {
      expect(() =>
        assertTransitionAllowed(current, target, allDone),
      ).toThrow(InvalidTicketTransitionError);
    });

    it('mentions "backward" or "terminal" in the rejection message', () => {
      expect(() =>
        assertTransitionAllowed(
          TicketStatus.IN_REVIEW,
          TicketStatus.TODO,
          allDone,
        ),
      ).toThrow(/backward|reverse|terminal/i);
    });
  });

  describe('same-status transitions (decision: REJECT — no-op masks caller bugs)', () => {
    it.each([
      TicketStatus.TODO,
      TicketStatus.IN_PROGRESS,
      TicketStatus.IN_REVIEW,
      TicketStatus.DONE,
    ])('rejects %s → %s', (status) => {
      expect(() =>
        assertTransitionAllowed(status, status, allDone),
      ).toThrow(InvalidTicketTransitionError);
      expect(() =>
        assertTransitionAllowed(status, status, allDone),
      ).toThrow(/same|no-op|already/i);
    });
  });

  describe('DONE is terminal', () => {
    it.each([
      TicketStatus.TODO,
      TicketStatus.IN_PROGRESS,
      TicketStatus.IN_REVIEW,
    ])('rejects DONE → %s and message mentions terminal', (target) => {
      expect(() =>
        assertTransitionAllowed(TicketStatus.DONE, target, allDone),
      ).toThrow(/terminal|frozen|DONE/i);
    });
  });

  describe('transition INTO DONE is blocker-gated', () => {
    it('rejects IN_REVIEW → DONE when blockersAllDone is false', () => {
      expect(() =>
        assertTransitionAllowed(
          TicketStatus.IN_REVIEW,
          TicketStatus.DONE,
          blockersPending,
        ),
      ).toThrow(InvalidTicketTransitionError);
      expect(() =>
        assertTransitionAllowed(
          TicketStatus.IN_REVIEW,
          TicketStatus.DONE,
          blockersPending,
        ),
      ).toThrow(/blocker|dependenc/i);
    });

    it('allows IN_REVIEW → DONE when blockersAllDone is true', () => {
      expect(() =>
        assertTransitionAllowed(
          TicketStatus.IN_REVIEW,
          TicketStatus.DONE,
          allDone,
        ),
      ).not.toThrow();
    });

    it('does not check blockers for non-DONE targets', () => {
      // blockersPending should not interfere with a legal non-DONE transition
      expect(() =>
        assertTransitionAllowed(
          TicketStatus.TODO,
          TicketStatus.IN_PROGRESS,
          blockersPending,
        ),
      ).not.toThrow();
    });
  });

  describe('error type', () => {
    it('throws InvalidTicketTransitionError (not a plain Error) so the HTTP layer can map to 400', () => {
      try {
        assertTransitionAllowed(
          TicketStatus.TODO,
          TicketStatus.DONE,
          allDone,
        );
        fail('expected to throw');
      } catch (e) {
        expect(e).toBeInstanceOf(InvalidTicketTransitionError);
      }
    });
  });
});
