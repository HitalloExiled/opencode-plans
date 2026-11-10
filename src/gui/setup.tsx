/**
 * Window-side registration for the Plans side panel.
 *
 * One side tab, opened from the command palette and from the "+ / New tab"
 * menu. There is no default keybind: `mod+shift+p` belongs to the app's command
 * palette. The shared `registerSidePanel` keeps the registration shape the same
 * as the other panels.
 */

import type { SetupContext } from "@opencode/plugin/gui";
import { registerSidePanel } from "@hitalloexiled/opencode-shared/gui";
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
}
