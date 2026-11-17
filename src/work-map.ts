/**
 * The initiative map: every card with its status and blockers, as compact
 * lines. Pure so the planning seed, the `initiative.get` tool and the tests
 * share one format; the labels are injected because the seed is localized by
 * the GUI and the tool by the session locale.
 */

export type InitiativeMapItem = {
  title: string;
  status: string;
  /** Items this one waits for. */
  blockedBy: readonly { title: string; status: string }[];
};

export type MapLabels = {
  /** Prefix of an item's blockers, e.g. "blocked by". */
  blockedBy: string;
  /** Line for the items past the cap; `{0}` is the count. */
  more: string;
};

export function renderInitiativeMap(
  items: readonly InitiativeMapItem[],
  labels: MapLabels,
  limit = 40,
): string {
  if (items.length === 0) return "";
  const shown = items.slice(0, limit);
  const lines = shown.map((item) => {
    const deps =
      item.blockedBy.length === 0
        ? ""
        : ` — ${labels.blockedBy} ${item.blockedBy
            .map((dep) => `${dep.title} (${dep.status})`)
            .join(", ")}`;
    return `- [${item.status}] ${item.title}${deps}`;
  });
  const hidden = items.length - shown.length;
  if (hidden > 0) lines.push(`- ${labels.more.replace("{0}", String(hidden))}`);
  return lines.join("\n");
}
