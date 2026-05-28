import { TicketStatus } from '../common/enums';

// Sequential lifecycle from CLAUDE.md: TODO → IN_PROGRESS → IN_REVIEW → DONE.
// Skipping (e.g. TODO → IN_REVIEW) is rejected because the spec defines an
// explicit "forward path ONLY"; the workflow stages exist precisely so that
// review happens before done. Same-status calls are rejected because they are
// no-ops that would otherwise silently mask caller bugs (a real status change
// is always meaningful work).
const FORWARD_NEXT: Record<TicketStatus, TicketStatus | null> = {
  [TicketStatus.TODO]: TicketStatus.IN_PROGRESS,
  [TicketStatus.IN_PROGRESS]: TicketStatus.IN_REVIEW,
  [TicketStatus.IN_REVIEW]: TicketStatus.DONE,
  [TicketStatus.DONE]: null,
};

export class InvalidTicketTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTicketTransitionError';
  }
}

export interface TransitionOpts {
  blockersAllDone: boolean;
}

export function assertTransitionAllowed(
  current: TicketStatus,
  target: TicketStatus,
  opts: TransitionOpts,
): void {
  // Same-status check runs before DONE-terminal so that DONE → DONE is
  // reported as a no-op (more specific) rather than as "leaving DONE".
  if (current === target) {
    throw new InvalidTicketTransitionError(
      `Same-status transition is a no-op and not allowed: ${current} → ${target}`,
    );
  }

  if (current === TicketStatus.DONE) {
    throw new InvalidTicketTransitionError(
      `DONE is terminal (frozen): cannot transition ${current} → ${target}`,
    );
  }

  const next = FORWARD_NEXT[current];
  if (target !== next) {
    if (isBackward(current, target)) {
      throw new InvalidTicketTransitionError(
        `Backward transition not allowed: ${current} → ${target}`,
      );
    }
    throw new InvalidTicketTransitionError(
      `Cannot skip lifecycle stages (sequential only): ${current} → ${target}; next allowed is ${next}`,
    );
  }

  if (target === TicketStatus.DONE && !opts.blockersAllDone) {
    throw new InvalidTicketTransitionError(
      `Cannot transition to DONE while ticket has unfinished blocker dependencies`,
    );
  }
}

const ORDER: TicketStatus[] = [
  TicketStatus.TODO,
  TicketStatus.IN_PROGRESS,
  TicketStatus.IN_REVIEW,
  TicketStatus.DONE,
];

function isBackward(current: TicketStatus, target: TicketStatus): boolean {
  return ORDER.indexOf(target) < ORDER.indexOf(current);
}
