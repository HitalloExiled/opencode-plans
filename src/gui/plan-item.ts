/**
 * "Plan" action for a work item. With no plan it opens a fresh planning
 * session; with a plan it reuses the plan's session and asks for an edit of
 * the SAME plan (one plan per item).
 */

import type { Context, ServerRef } from "@opencode/plugin/gui";
import type { Location } from "@opencode/schema/location";
import { PlansRpc, type WorkItemDetail } from "./contract";
import type { Translate } from "./execute";
import { planContext } from "./plan-context";
import { pauseAgent } from "../flow-rules.js";
import { repoForItem } from "../work-plan.js";

export type PlanItemTarget = {
  server: ServerRef;
};

export async function planWorkItem(input: {
  ctx: Context;
  target: PlanItemTarget;
  detail: WorkItemDetail;
  t: Translate;
  /** The chosen OpenCode project directory; defaults to the item's repo. */
  directory?: string | undefined;
}): Promise<string> {
  const { ctx, target, detail, t } = input;
  const body = detail.item.body.trim() || t("work.detail.noBody");
  const plan = detail.plan;
  const repo = repoForItem(detail.initiative, detail.item.repoID ?? null);
  const directory = input.directory?.trim() || repo?.directory;

  // The dedicated planner gets the contract from the <plans-flow> tail, so the
  // seed only carries the item, the body and the save call. Native keeps the
  // full prompt: it has no tail.
  const flow = await target.server.client.rpc(PlansRpc).getFlow({});
  const short = flow === "dedicated";
  const prompt = plan
    ? t(
        short ? "work.replan.promptShort" : "work.replan.prompt",
        detail.item.title,
        detail.item.id,
        plan.id,
        plan.title,
        body,
      )
    : t(
        short ? "work.plan.promptShort" : "work.plan.prompt",
        detail.item.title,
        detail.item.id,
        body,
      );
  // The repository, the initiative and the work map are per item: they belong
  // in the seed (a user message), never in the constant <plans-flow> tail.
  const seed = `${planContext(
    {
      repo: directory,
      initiative: detail.initiative,
      map: detail.map,
    },
    t,
  )}\n\n${prompt}`;

  // Replanning continues in the session that wrote the plan, when it still
  // exists; a missing session falls through to a fresh one.
  if (plan) {
    const existing = await target.server.client.session
      .get({ sessionID: plan.sessionID as never })
      .then(() => plan.sessionID)
      .catch(() => undefined);
    if (existing) {
      try {
        await target.server.client.session.prompt({ sessionID: existing as never, text: seed });
        ctx.tabs.open({ server: target.server.id, id: existing }, { focus: true });
        return existing;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // The plan may live in a worktree a finished run already removed; give
        // it a fresh session in the repository instead of failing.
        if (!/location not found/i.test(message)) throw error;
      }
    }
  }

  if (!directory) throw new Error(t("work.plan.error"));

  const agent = pauseAgent(flow);

  const session = await target.server.client.session.create({
    agent,
    title: plan
      ? t("work.replan.title", detail.item.title)
      : t("work.plan.title", detail.item.title),
    // The client type brands the path; the value is the workspace directory.
    location: { directory: directory as Location.PublicRef["directory"] },
  });

  await target.server.client.session.prompt({ sessionID: session.id, text: seed });

  ctx.tabs.open({ server: target.server.id, id: session.id }, { focus: true });
  return session.id;
}
