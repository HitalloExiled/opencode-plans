/**
 * "Run plan" composer pill.
 *
 * The pill above the composer appears when the routed session is idle and has
 * an active plan, and runs that plan exactly as the panel's Execute button
 * does (`runPlan`). Plans live in `plans.db` on the server, so this module
 * keeps a per-session cache refreshed by the `PlansRpc` `changed` event, with
 * an initial fetch and a refetch after the session goes idle.
 *
 * The API has no disabled pill: while the agent runs, or while an execution is
 * pending, `show` returns undefined and the host renders nothing.
 */

import { createSignal, onCleanup } from "solid-js";
import type { ComposerPillView, Context, MountedSession } from "@opencode/plugin/gui";
import { PlansRpc, type Plan } from "./contract";
import { runPlan } from "./execute";
import { tStatic } from "./i18n";
import { pickRunnablePlan } from "../plan-select";

/** How long a clicked pill stays hidden while the session starts running. */
const PENDING_MS = 5_000;

/** Minimum gap between two listing attempts for one session. */
const RETRY_MS = 1_000;

const sessionKey = (session: MountedSession): string => `${session.server.id}\u0000${session.id}`;

export type PlanPill = {
  show(session: MountedSession): ComposerPillView | undefined;
};

export function createPlanPill(ctx: Context): PlanPill {
  const [revision, setRevision] = createSignal(0);
  const bump = () => setRevision((value) => value + 1);

  /** `null`: fetched and no active plan; missing: not fetched yet. */
  const cache = new Map<string, Plan | null>();
  const sessions = new Map<string, MountedSession>();
  const seq = new Map<string, number>();
  const attempted = new Map<string, number>();
  const pendingAt = new Map<string, number>();
  const dirty = new Set<string>();
  const subscriptions = new Map<string, () => void>();

  const translate = (key: string, ...args: unknown[]): string =>
    tStatic(ctx.locale.locale(), key, ...args);

  const refresh = async (session: MountedSession): Promise<void> => {
    const key = sessionKey(session);
    const turn = (seq.get(key) ?? 0) + 1;
    seq.set(key, turn);
    try {
      const plans = await session.server.client.rpc(PlansRpc).list(
        { scope: "session", sessionID: session.id, status: "active", limit: 1 },
        { location: { directory: session.directory } },
      );
      if (seq.get(key) !== turn) return;
      cache.set(key, pickRunnablePlan(plans, session.id) ?? null);
      bump();
    } catch {
      // A broken RPC must not break the composer; the next idle retries.
    }
  };

  const maybeRefresh = (session: MountedSession): void => {
    const key = sessionKey(session);
    const now = Date.now();
    if (now - (attempted.get(key) ?? 0) < RETRY_MS) return;
    attempted.set(key, now);
    void refresh(session);
  };

  /**
   * One subscription per server: a write from the agent or the panel refetches
   * only the session that changed. Sessions not mounted right now are ignored
   * and fetched when their composer first shows.
   */
  const subscribe = (session: MountedSession): void => {
    const server = session.server.id;
    if (subscriptions.has(server)) return;
    const off = session.server.client.rpc(PlansRpc).events.on("changed", (event) => {
      const target = sessions.get(`${server}\u0000${event.data.sessionID}`);
      if (target) void refresh(target);
    });
    subscriptions.set(server, off);
  };

  const execute = async (session: MountedSession, plan: Plan): Promise<void> => {
    const key = sessionKey(session);
    if (pendingAt.has(key)) return;
    pendingAt.set(key, Date.now());
    bump();
    try {
      await runPlan({ ctx, session, plan, t: translate });
      ctx.toast.show({ title: translate("toast.executing"), variant: "success" });
    } catch (cause) {
      pendingAt.delete(key);
      bump();
      ctx.toast.show({
        title: translate("execute.pillError"),
        description: cause instanceof Error ? cause.message : String(cause),
        variant: "error",
      });
    }
  };

  onCleanup(() => {
    for (const off of subscriptions.values()) off();
    subscriptions.clear();
  });

  return {
    show(session) {
      // Subscribes the cache (bumped on every refresh) to this contribution.
      revision();

      const key = sessionKey(session);
      sessions.set(key, session);
      subscribe(session);

      // The agent is working: the pill has nothing to run yet, and the next
      // idle transition refetches in case a save happened during the turn.
      if (session.server.data.session.status(session.id) === "running") {
        pendingAt.delete(key);
        dirty.add(key);
        return undefined;
      }

      const pending = pendingAt.get(key);
      if (pending !== undefined) {
        if (Date.now() - pending < PENDING_MS) return undefined;
        pendingAt.delete(key);
        bump();
      }

      if (dirty.delete(key) || !cache.has(key)) maybeRefresh(session);

      const plan = cache.get(key);
      if (!plan) return undefined;

      const total = plan.steps.length;
      const done = plan.steps.reduce((count, step) => count + (step.status === "done" ? 1 : 0), 0);
      const label = total > 0 ? `${translate("execute.pill")} · ${done}/${total}` : translate("execute.pill");

      return {
        icon: "arrow-right",
        label,
        title: translate("execute.pillTitle", plan.title),
        run: () => void execute(session, plan),
      };
    },
  };
}
