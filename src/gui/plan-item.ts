/**
 * "Plan" action for a work item: a fresh session with the flow's planning
 * agent, seeded with the need, focused so the chat opens (no modal).
 */

import type { Context, ServerRef } from "@opencode/plugin/gui";
import type { Location } from "@opencode/schema/location";
import { PlansRpc, type WorkItemDetail } from "./contract";
import type { Translate } from "./execute";
import { pauseAgent } from "../flow-rules.js";
import { locationForItem } from "../work-plan.js";

export type PlanItemTarget = {
  server: ServerRef;
};

export async function planWorkItem(input: {
  ctx: Context;
  target: PlanItemTarget;
  detail: WorkItemDetail;
  t: Translate;
}): Promise<string> {
  const { ctx, target, detail, t } = input;
  const location = locationForItem(detail.project, detail.item.locationID ?? null);
  if (!location) throw new Error(t("work.plan.error"));

  const flow = await target.server.client.rpc(PlansRpc).getFlow({});
  const agent = pauseAgent(flow);

  const session = await target.server.client.session.create({
    agent,
    title: t("work.plan.title", detail.item.title),
    // The client type brands the path; the value is the workspace directory.
    location: { directory: location.directory as Location.PublicRef["directory"] },
  });

  await target.server.client.session.prompt({
    sessionID: session.id,
    text: t(
      "work.plan.prompt",
      detail.item.title,
      detail.item.id,
      detail.item.body.trim() || t("work.detail.noBody"),
    ),
  });

  ctx.tabs.open({ server: target.server.id, id: session.id }, { focus: true });
  return session.id;
}
