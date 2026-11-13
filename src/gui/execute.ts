/**
 * Executing a plan: the action shared by the Plans panel, the composer pill and
 * the all-plans page.
 *
 * Executing is a user action: the plan runs in a target session. The panel and
 * the pill pass the routed session, so a plan from another session is moved
 * into it first; the page passes the plan's own session, so nothing moves.
 */

import type { Context, MountedSession } from "@opencode/plugin/gui";
import { PlansRpc, type Plan } from "./contract";

/** The translation function `useT()` returns; the panel and the setup share it. */
export type Translate = (key: string, ...args: unknown[]) => string;

/** Where an execution runs, decoupled from a mounted tab. */
export type ExecutionTarget = {
  serverID: string;
  sessionID: string;
  client: MountedSession["server"]["client"];
  /** Reactive session status; "running" while the turn is in flight. */
  status: () => string | undefined;
  /** The session's directory, for the move RPC; undefined outside a mounted tab. */
  directory?: string | undefined;
};

export type RunPlanResult = {
  /** The plan in its target session (moved, when it came from another one). */
  plan: Plan;
  moved: boolean;
};

/**
 * Runs `plan` in `target`. A plan from another session is moved into it first,
 * which needs the session's directory. Throws on any failed step so callers can
 * show the error and restore their own state.
 */
export async function runPlan(input: {
  ctx: Context;
  target: ExecutionTarget;
  plan: Plan;
  t: Translate;
}): Promise<RunPlanResult> {
  const { ctx, target, plan, t } = input;
  let current = plan;
  let moved = false;

  if (plan.sessionID !== target.sessionID) {
    const directory = target.directory;
    if (!directory) throw new Error(t("toast.moveError"));
    const result = await target.client.rpc(PlansRpc).move(
      { id: plan.id, sessionID: target.sessionID, locale: ctx.locale.locale() },
      { location: { directory } },
    );
    if (!result.ok) throw new Error(result.error ?? t("toast.moveError"));
    if (result.plan) current = result.plan;
    moved = true;
  }

  await target.client.session.switchAgent({
    sessionID: target.sessionID,
    agent: "build",
  });
  await target.client.session.prompt({
    sessionID: target.sessionID,
    text: t("execute.prompt", current.title, current.id),
  });

  return { plan: current, moved };
}
