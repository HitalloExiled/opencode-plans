/**
 * "Run plan" composer pill.
 *
 * The pill above the composer appears when the routed session is idle and has
 * an active plan, and runs that plan through the shared execution handle — the
 * same action as the panel's Execute button. Plans live in `plans.db` on the
 * server, so this module keeps a per-session cache refreshed by the
 * `PlansRpc` `changed` event, with an initial fetch and a refetch after the
 * session goes idle.
 *
 * The API has no disabled pill: while the agent runs, or while an execution is
 * pending, `show` returns undefined and the host renders nothing.
 */

import { createSignal, onCleanup } from "solid-js";
import type { ComposerPillView, Context, MountedSession } from "@opencode/plugin/gui";
import { PlansRpc, type Plan } from "./contract";
import { executionFor, sessionTarget } from "./execution";
import { tStatic } from "./i18n";
import { pickRunnablePlan } from "../plan-select";

/** Minimum gap between two listing attempts for one session. */
const RETRY_MS = 1_000;

/**
 * The app has no play glyph: the panel's play button is `fill-triangle-down`
 * rotated by its own CSS. The host draws the pill icon with no rotation prop
 * or plugin class, so this rule gives the pill the same glyph, scoped to that
 * icon (the `$=` form also covers the "New icons" experiment symbols).
 */
export const PLAY_ICON_CSS = `
[data-composer-pill] svg[data-slot="icon-svg"]:has(use[href$="fill-triangle-down"]) {
  width: 20px;
  height: 20px;
  transform: rotate(-90deg);
  transform-box: fill-box;
  transform-origin: center;
}
`;

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

      // The agent is running, or a click is still in flight: the pill has
      // nothing to run, and the next idle transition refetches in case the
      // plan changed during the turn. The execution handle owns that state, so
      // a run started from the panel behaves the same.
      if (executionFor(ctx, sessionTarget(session)).busy()) {
        dirty.add(key);
        return undefined;
      }

      if (dirty.delete(key) || !cache.has(key)) maybeRefresh(session);

      const plan = cache.get(key);
      if (!plan) return undefined;

      const total = plan.steps.length;
      const done = plan.steps.reduce((count, step) => count + (step.status === "done" ? 1 : 0), 0);
      const label = total > 0 ? `${translate("execute.pill")} · ${done}/${total}` : translate("execute.pill");

      return {
        icon: "fill-triangle-down",
        tone: "success",
        label,
        title: translate("execute.pillTitle", plan.title),
        run: () => void executionFor(ctx, sessionTarget(session)).execute(plan, translate),
      };
    },
  };
}
