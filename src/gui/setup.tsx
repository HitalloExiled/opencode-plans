/**
 * Window-side registration for the Plans side panel.
 *
 * Registers:
 *  - a removable "Planos" tab in the session's side region (`Panel`),
 *  - a command palette / slash entry (`Command`),
 *  - a "+ / New tab" menu entry (`MenuItem`).
 */

import type {
  Panel as PanelType,
  PanelTab,
  SessionPanelMenuItem,
  SetupContext,
} from "@opencode/plugin/gui";
import { Command, MenuItem, Panel } from "@opencode/plugin/gui";
import { PlansView } from "./view";

export const openPlansId = "plans";

export function setup(ctx: SetupContext<never>): void {
  // Stable tab object: the host reads the label once per session switch.
  const plansTab: PanelTab = {
    id: openPlansId,
    title: "Planos",
  };

  const plansPanel: PanelType = {
    id: openPlansId,
    region: "side",
    list: () => [plansTab],
    render: () => <PlansView />,
  };
  ctx.add(Panel, () => plansPanel);

  ctx.add(Command, () => ({
    id: "open",
    title: "Abrir Planos",
    description: "Abre a aba de Planos no painel lateral",
    bind: "mod+shift+p",
    group: "general",
    run: () => {
      const session = ctx.sessions.current();
      if (session) ctx.layout.open(`${ctx.id}:${openPlansId}`, session);
    },
  }));

  const plansMenu: SessionPanelMenuItem = {
    menu: "session.panel",
    id: "plans",
    title: "Planos",
    icon: "file-document",
    run: () => {
      const session = ctx.sessions.current();
      if (session) ctx.layout.open(`${ctx.id}:${openPlansId}`, session);
    },
  };
  ctx.add(MenuItem, () => plansMenu);
}
