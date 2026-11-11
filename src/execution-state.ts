/**
 * Pure execution-state rules, shared by the panel and the composer pill.
 *
 * The state follows the session, not the entry point: a plan is executing when
 * it was started here and the session is running (or the prompt is still in
 * flight). Kept free of GUI imports so the transitions are testable.
 */

export type ExecutionState = {
  /** Plan the last execution started; null when nothing is executing. */
  planID: string | null;
  /** The prompt was sent but the session has not turned running yet. */
  pending: boolean;
  /** When `pending` started; used to expire a run that never starts. */
  startedAt: number | null;
};

export const EXECUTION_INITIAL: ExecutionState = {
  planID: null,
  pending: false,
  startedAt: null,
};

export type ExecutionChange = {
  readonly running: boolean;
  readonly now: number;
  /** How long `pending` survives while the session stays idle. */
  readonly pendingMs: number;
};

/**
 * The next state after a session transition, or undefined when nothing should
 * change. `pending` becomes the running state, an idle session forgets the
 * finished run, and a pending run that never started expires.
 */
export function nextExecution(
  state: ExecutionState,
  change: ExecutionChange,
): ExecutionState | undefined {
  if (change.running) {
    return state.pending ? { ...state, pending: false, startedAt: null } : undefined;
  }

  if (state.pending) {
    const remaining =
      state.startedAt === null ? 0 : change.pendingMs - (change.now - state.startedAt);
    return remaining > 0 ? undefined : EXECUTION_INITIAL;
  }

  return state.planID === null ? undefined : EXECUTION_INITIAL;
}

/** Whether a new execution must be refused for this session. */
export function executionBusy(state: ExecutionState, running: boolean): boolean {
  return running || state.pending;
}
