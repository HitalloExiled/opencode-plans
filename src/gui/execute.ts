/**
 * Executing a plan: the action shared by the Plans panel and the composer pill.
 *
 * Executing is a user action: move the plan into the target session when it
 * belongs to another one, switch the session agent to Build and send the
 * execution prompt as a normal user message (default `steer`). Never send it
 * with `delivery: "queue"`, which parks it until the current turn ends.
 */

import type { Context, MountedSession } from "@opencode/plugin/gui";
import { PlansRpc, type Plan } from "./contract";

/** The translation function `useT()` returns; the panel and the setup share it. */
export type Translate = (key: string, ...args: unknown[]) => string;

export type RunPlanResult = {
  /** The plan in its target session (moved, when it came from another one). */
  plan: Plan;
  moved: boolean;
};

/**
 * Runs `plan` in `session`. Throws on any failed step so callers can show the
 * error and restore their own state.
 */
export async function runPlan(input: {
  ctx: Context;
  session: MountedSession;
  plan: Plan;
  t: Translate;
}): Promise<RunPlanResult> {
  const { ctx, session, plan, t } = input;
  let target = plan;
  let moved = false;

  if (plan.sessionID !== session.id) {
    const result = await session.server.client.rpc(PlansRpc).move(
      { id: plan.id, sessionID: session.id, locale: ctx.locale.locale() },
      { location: { directory: session.directory } },
    );
    if (!result.ok) throw new Error(result.error ?? t("toast.moveError"));
    if (result.plan) target = result.plan;
    moved = true;
  }

  await session.server.client.session.switchAgent({
    sessionID: session.id,
    agent: "build",
  });
  await session.server.client.session.prompt({
    sessionID: session.id,
    text: t("execute.prompt", target.title, target.id),
  });

  return { plan: target, moved };
}
