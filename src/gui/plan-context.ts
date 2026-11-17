/**
 * The context a planning session starts with: where it runs, which initiative
 * the item belongs to, the initiative's macro view and the map of cards.
 *
 * Pure and localized through `t`, because the same block feeds the native and
 * the dedicated seeds and must be testable without the UI. It goes in the seed
 * (a user message), never in the constant `<plans-flow>` tail.
 */

import type { Initiative, WorkMapEntry } from "./contract";
import type { Translate } from "./execute";
import { renderInitiativeMap } from "../work-map.js";

const OVERVIEW_LIMIT = 6000;
const MAP_LIMIT = 40;

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit).trimEnd()}…`;
}

export type PlanContextInput = {
  /** The repository the session runs in, when known. */
  repo?: string | undefined;
  initiative: Pick<Initiative, "name" | "overview">;
  map: readonly WorkMapEntry[];
};

export function planContext(input: PlanContextInput, t: Translate): string {
  const lines: string[] = [t("work.plan.context.title")];
  if (input.repo) lines.push(t("work.plan.context.repo", input.repo));
  lines.push(t("work.plan.context.initiative", input.initiative.name));

  const overview = input.initiative.overview?.trim();
  if (overview) {
    lines.push("", t("work.plan.context.overview"), "", truncate(overview, OVERVIEW_LIMIT));
  }

  const map = renderInitiativeMap(
    input.map,
    { blockedBy: t("work.map.blockedBy"), more: t("work.map.more") },
    MAP_LIMIT,
  );
  if (map) lines.push("", t("work.plan.context.map", input.map.length), "", map);

  lines.push("", t("work.plan.context.read"), t("work.plan.context.touches"));
  return lines.join("\n");
}
