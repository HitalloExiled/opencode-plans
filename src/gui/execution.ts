/**
 * The execution action shared by the Plans panel, the composer pill and the
 * all-plans page.
 *
 * One handle per session owns the state and the action: clicking Execute in the
 * panel, running the pill or executing from the page lands here, records
 * `{ planID, pending }` in the session's store and calls `runPlan`. Every entry
 * point then renders the same executing state, so the panel shows Pausar for a
 * run started elsewhere.
 */

import { createEffect, createRoot, createSignal, onCleanup } from "solid-js";
import { Schema } from "effect";
import type { Context, MountedSession, Persisted, ServerRef } from "@opencode/plugin/gui";
import type { Plan } from "./contract";
import { runPlan, type ExecutionTarget, type RunPlanResult, type Translate } from "./execute";
import {
  EXECUTION_INITIAL,
  executionBusy,
  nextExecution,
  type ExecutionState,
} from "../execution-state";

/** How long a clicked execution waits for the session to turn running. */
const PENDING_MS = 5_000;

const ExecutionStore = Schema.Struct({
  planID: Schema.NullOr(Schema.String),
  pending: Schema.Boolean,
  startedAt: Schema.NullOr(Schema.Number),
});

export type ExecutionHandle = {
  /** The session is running a plan, or a click is still in flight. */
  busy(): boolean;
  /** This plan is the one executing here. */
  isExecuting(plan: Plan): boolean;
  execute(plan: Plan, t: Translate): Promise<RunPlanResult | undefined>;
  pause(plan: Plan, t: Translate): Promise<void>;
};

/** One handle and one store per server + session, shared by every entry point. */
const handles = new Map<string, ExecutionHandle>();
const stores = new Map<string, Persisted<ExecutionState>>();

const sessionKey = (target: ExecutionTarget): string =>
  `${target.serverID}\u0000${target.sessionID}`;

/** The routed session of a side panel or the pill. */
export function sessionTarget(session: MountedSession): ExecutionTarget {
  return {
    serverID: session.server.id,
    sessionID: session.id,
    client: session.server.client,
    status: () => session.server.data.session.status(session.id),
    directory: session.directory,
  };
}

/** A plan's own session, resolved from a server: the page runs plans in place. */
export function planTarget(server: ServerRef, plan: Plan): ExecutionTarget {
  return {
    serverID: server.id,
    sessionID: plan.sessionID,
    client: server.client,
    status: () => server.data.session.status(plan.sessionID),
  };
}

function storeFor(ctx: Context, target: ExecutionTarget): Persisted<ExecutionState> {
  const key = `execution:${target.serverID}:${target.sessionID}`;
  let store = stores.get(key);
  if (!store) {
    store = ctx.storage.store(key, { schema: ExecutionStore, initial: EXECUTION_INITIAL });
    stores.set(key, store);
  }
  return store;
}

export function executionFor(ctx: Context, target: ExecutionTarget): ExecutionHandle {
  const key = sessionKey(target);
  const cached = handles.get(key);
  if (cached) return cached;

  const handle = createRoot((dispose) => {
    const store = storeFor(ctx, target);
    const [revision, setRevision] = createSignal(0);
    const value = (): ExecutionState => store.value ?? EXECUTION_INITIAL;
    const running = (): boolean => target.status() === "running";
    const notify = (title: string, variant: "success" | "error", cause?: unknown): void => {
      ctx.toast.show({
        title,
        ...(cause === undefined
          ? {}
          : { description: cause instanceof Error ? cause.message : String(cause) }),
        variant,
      });
    };

    // One effect owns the transitions for this session, whichever entry point
    // started the run. `pending` turns into the running state, an idle session
    // forgets the finished run, and a pending run that never starts expires.
    createEffect(() => {
      revision();
      const state = value();
      const change = { running: running(), now: Date.now(), pendingMs: PENDING_MS };
      const next = nextExecution(state, change);
      if (next) store.set(next);

      if (!change.running && state.pending && state.startedAt !== null) {
        const remaining = PENDING_MS - (change.now - state.startedAt);
        if (remaining > 0) {
          const timer = setTimeout(() => setRevision((count) => count + 1), remaining + 25);
          onCleanup(() => clearTimeout(timer));
        }
      }
    });

    const result: ExecutionHandle = {
      busy: () => executionBusy(value(), running()),
      isExecuting: (plan) => {
        const state = value();
        return state.planID === plan.id && (state.pending || running());
      },
      execute: async (plan, t) => {
        if (executionBusy(value(), running())) {
          notify(t("toast.busy"), "error");
          return undefined;
        }
        store.set({ planID: plan.id, pending: true, startedAt: Date.now() });
        try {
          const run = await runPlan({ ctx, target, plan, t });
          notify(t("toast.executing"), "success");
          return run;
        } catch (error) {
          store.set(EXECUTION_INITIAL);
          notify(t("toast.executeError"), "error", error);
          return undefined;
        }
      },
      pause: async (plan, t) => {
        try {
          const interrupted = await target.client.session.interrupt({
            sessionID: target.sessionID,
          });
          // Tell the next turn why the run paused, not just that the mode changed.
          try {
            await target.client.session.synthetic({
              sessionID: target.sessionID,
              text: t("pause.synthetic", plan.title, plan.id),
              description: t("pause.action", plan.title),
              resume: false,
              metadata: { source: "plans", planID: plan.id, kind: "paused" },
            });
          } catch (error) {
            console.warn("[plans] could not record the pause message", error);
          }
          await target.client.session.switchAgent({
            sessionID: target.sessionID,
            agent: "plan",
          });
          if (!interrupted.interrupted) store.set(EXECUTION_INITIAL);
          notify(t("toast.pausing"), "success");
        } catch (error) {
          notify(t("toast.pauseError"), "error", error);
        }
      },
    };

    // The handle lives for the window: the effect must outlive the panel that
    // first opened it, so nothing disposes this root.
    void dispose;
    return result;
  });

  handles.set(key, handle);
  return handle;
}
