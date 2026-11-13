/**
 * Window-side registration for the Plans side panel, the global launcher and
 * the composer pill.
 *
 * The panel is a side tab (one per session). The global surface is the
 * `window.bottom` launcher: it opens every saved plan in a modal, with no
 * session and no keyboard shortcut. The panel, the launcher and the modal all
 * render the same `PlansBody`.
 *
 * The composer pill is the quick path: it appears above the composer when the
 * session is idle with an active plan and runs that plan in one click.
 */

import type { SetupContext } from "@opencode/plugin/gui";
import { ComposerPill, Slot, Style } from "@opencode/plugin/gui";
import { registerSidePanel } from "opencode-shared/gui";
import { PlansLauncher } from "./launcher";
import { createPlanPill, PLAY_ICON_CSS } from "./pill";
import { PlansView } from "./view";

export const openPlansId = "plans";

export function setup(ctx: SetupContext<never>): void {
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

  ctx.add(Slot, { at: "window.bottom", order: 10, render: () => <PlansLauncher /> });

  const pill = createPlanPill(ctx);
  ctx.add(Style, PLAY_ICON_CSS);
  ctx.add(ComposerPill, () => ({
    id: "execute-plan",
    order: 10,
    show: (input) => pill.show(input.session),
  }));
}
