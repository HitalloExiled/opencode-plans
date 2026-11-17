/**
 * Executing a plan: the action shared by the Plans panel, the composer pill and
 * the all-plans page.
 *
 * Executing is a user action: the plan runs in a target session. The panel and
 * the pill pass the routed session, so a plan from another session is moved
 * into it first; the page passes the plan's own session, so nothing moves.
 * The run switches the session to the plugin's `executor` agent.
 */

import type { Context, MountedSession } from "@opencode/plugin/gui";
import { PlansRpc, type Plan } from "./contract";
import { runAgent } from "../flow-rules.js";

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

  // The work item names the need the plan serves; a missing item (deleted or
  // unlinked) simply falls back to the plan-only prompt.
  const detail = current.workItemID
    ? await target.client
        .rpc(PlansRpc)
        .getWorkItem({ id: current.workItemID })
        .catch(() => null)
    : null;

  // The flow setting picks the agent (one tested mapping, `runAgent`). The
  // dedicated agents get the contract from the <plans-flow> tail, so the seed
  // only names the plan (and the item); the native flow has no tail and keeps
  // the full prompt.
  const flow = await target.client.rpc(PlansRpc).getFlow({});
  const short = flow === "dedicated";
  const seed = detail
    ? t(
        short ? "execute.promptItemShort" : "execute.promptItem",
        current.title,
        current.id,
        detail.item.title,
        detail.item.id,
      )
    : t(short ? "execute.promptShort" : "execute.prompt", current.title, current.id);

  // Where it runs: solo switches the repository to wi/<item>; parallel opens a
  // session in a worktree. A failure here falls back to the current session
  // instead of blocking the execution.
  const begun = await target.client
    .rpc(PlansRpc)
    .executionBegin({ planID: current.id, workItemID: current.workItemID, sessionID: target.sessionID })
    .catch(() => null);
  // A pending dependency is not an isolation failure: stop instead of running
  // without its branch.
  if (begun && !begun.ok && begun.blocked) {
    throw new Error(begun.error ?? t("execute.blocked"));
  }
  const worktree = begun?.ok && begun.mode === "worktree" ? begun.directory : undefined;

  let sessionID = target.sessionID;
  if (worktree) {
    const created = await target.client.session.create({
      agent: runAgent(flow),
      title: t("execute.worktreeTitle", current.title),
      location: { directory: worktree as never },
    });
    sessionID = created.id;
    const into = await target.client
      .rpc(PlansRpc)
      .move({ id: current.id, sessionID, locale: ctx.locale.locale() }, { location: { directory: worktree } });
    if (into.ok && into.plan) current = into.plan;
    moved = true;
    ctx.tabs.open({ server: target.serverID, id: sessionID }, { focus: true });
  } else if (begun?.ok && begun.mode === "solo" && begun.branch) {
    ctx.toast.show({ title: t("execute.branch", begun.branch), variant: "success" });
  }

  const startIn = async (sid: string) => {
    await target.client.session.switchAgent({ sessionID: sid, agent: runAgent(flow) });
    await target.client.session.prompt({ sessionID: sid, text: seed });
  };

  try {
    await startIn(sessionID);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The plan may have been written in a worktree that no longer exists (a
    // finished run). Give it a live session in the directory beginWork chose —
    // or the plan's own project, when even that call failed — and retry once.
    const directory = (begun?.ok ? begun.directory : undefined) ?? current.projectDirectory;
    if (!/location not found/i.test(message) || !directory) throw error;
    const recovered = await target.client.session.create({
      agent: runAgent(flow),
      title: t("execute.worktreeTitle", current.title),
      location: { directory: directory as never },
    });
    const into = await target.client
      .rpc(PlansRpc)
      .move({ id: current.id, sessionID: recovered.id, locale: ctx.locale.locale() }, { location: { directory } });
    if (into.ok && into.plan) current = into.plan;
    moved = true;
    ctx.tabs.open({ server: target.serverID, id: recovered.id }, { focus: true });
    await startIn(recovered.id);
  }

  return { plan: current, moved };
}
