/**
 * Execution-state transitions shared by the panel and the composer pill.
 */

import { describe, expect, test } from "bun:test";
import {
  EXECUTION_INITIAL,
  executionBusy,
  nextExecution,
  type ExecutionState,
} from "../src/execution-state";

const state = (overrides: Partial<ExecutionState> = {}): ExecutionState => ({
  ...EXECUTION_INITIAL,
  ...overrides,
});

const change = (running: boolean, now = 10_000, pendingMs = 5_000) => ({ running, now, pendingMs });

describe("nextExecution", () => {
  test("pending becomes the running state", () => {
    const pending = state({ planID: "p1", pending: true, startedAt: 9_000 });
    expect(nextExecution(pending, change(true))).toEqual({
      planID: "p1",
      pending: false,
      startedAt: null,
    });
  });

  test("running without a pending run changes nothing", () => {
    expect(nextExecution(state({ planID: "p1" }), change(true))).toBeUndefined();
  });

  test("an idle session forgets the finished run", () => {
    expect(nextExecution(state({ planID: "p1" }), change(false))).toEqual(EXECUTION_INITIAL);
  });

  test("an idle session with nothing executing changes nothing", () => {
    expect(nextExecution(EXECUTION_INITIAL, change(false))).toBeUndefined();
  });

  test("keeps a pending run while the session has not started it", () => {
    const pending = state({ planID: "p1", pending: true, startedAt: 7_000 });
    expect(nextExecution(pending, change(false, 10_000))).toBeUndefined();
  });

  test("expires a pending run that never started", () => {
    const pending = state({ planID: "p1", pending: true, startedAt: 1_000 });
    expect(nextExecution(pending, change(false, 10_000))).toEqual(EXECUTION_INITIAL);
  });

  test("expires a pending run with no start time", () => {
    const pending = state({ planID: "p1", pending: true });
    expect(nextExecution(pending, change(false, 10_000))).toEqual(EXECUTION_INITIAL);
  });
});

describe("executionBusy", () => {
  test("a running session is busy", () => {
    expect(executionBusy(EXECUTION_INITIAL, true)).toBe(true);
  });

  test("a pending click is busy", () => {
    expect(executionBusy(state({ planID: "p1", pending: true }), false)).toBe(true);
  });

  test("an idle session with no pending click is free", () => {
    expect(executionBusy(EXECUTION_INITIAL, false)).toBe(false);
  });
});
