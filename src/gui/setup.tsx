/**
 * Window-side registration for the Plans side panel, the titlebar pill and the
 * composer pill.
 *
 * The panel is a side tab (one per session). The global surface is the pill in
 * the timeline's title row: it shows the active plan count and opens the
 * all-plans overlay, fixed over the window. No keyboard shortcuts.
 *
 * The composer pill is the quick path: it appears above the composer when the
 * session is idle with an active plan and runs that plan in one click.
 */

import type { SetupContext } from "@opencode/plugin/gui";
import { ComposerPill, Slot, Style } from "@opencode/plugin/gui";
import { registerSidePanel } from "opencode-shared/gui";
import { PlansPill, startPlansCount } from "./launcher";
import { createPlanPill, PLAY_ICON_CSS } from "./pill";
import { PlansView } from "./view";

export const openPlansId = "plans";

export function setup(ctx: SetupContext<never>): () => void {
  registerSidePanel(ctx, {
    id: openPlansId,
    title: { pt: "Planos", en: "Plans" },
    icon: "checklist",
    order: 42,
    command: {
      title: { pt: "Abrir Planos", en: "Open Plans" },
      description: {
        pt: "Abre a aba de Planos no painel lateral",
        en: "Opens the Plans tab in the side panel",
      },
    },
    view: ({ session }) => <PlansView session={session} />,
  });

  const stopCount = startPlansCount(ctx);

  // The entry is a pill in the timeline's title row (session.header), next to
  // the other plugins' pills. The overlay rides the same slot item, fixed over
  // the window, so there is no second mount point.
  ctx.add(Slot, {
    at: "session.header",
    order: -10,
    render: (input) => <PlansPill active={input.active} />,
  });

  const pill = createPlanPill(ctx);
  ctx.add(Style, PLAY_ICON_CSS);
  ctx.add(ComposerPill, () => ({
    id: "execute-plan",
    order: 10,
    show: (input) => pill.show(input.session),
  }));

  return stopCount;
}
