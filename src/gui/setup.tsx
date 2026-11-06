/**
 * Window-side registration for the Plans side panel.
 *
 * Registers:
 *  - a removable "Planos" tab in the session's side region (`Panel`),
 *  - a command palette / slash entry (`Command`),
 *  - a "+ / New tab" menu entry (`MenuItem`).
 */

import { createMemo, Show } from "solid-js";
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
  const text = (pt: string, en: string): string =>
    (ctx.locale.locale() ?? "").toLowerCase().startsWith("pt") ? pt : en;

  // The host reads the label per session switch; the memo follows the locale.
  const plansTab = createMemo<PanelTab>(() => ({
    id: openPlansId,
    title: text("Planos", "Plans"),
  }));

  const plansPanel: PanelType = {
    id: openPlansId,
    region: "side",
    list: () => [plansTab()],
    // The host keeps a panel render mounted across session switches. Key it by
    // the session so each session gets its own restored panel state.
    render: (props) => (
      <Show when={props.session.key} keyed>
        {(_key) => <PlansView session={props.session} />}
      </Show>
    ),
  };
  ctx.add(Panel, () => plansPanel);

  ctx.add(Command, () => ({
    id: "open",
    title: text("Abrir Planos", "Open Plans"),
    description: text(
      "Abre a aba de Planos no painel lateral",
      "Opens the Plans tab in the side panel",
    ),
    bind: "mod+shift+p",
    group: "general",
    run: () => {
      const session = ctx.sessions.current();
      if (session) ctx.layout.open(`${ctx.id}:${openPlansId}`, session);
    },
  }));

  ctx.add(MenuItem, (): SessionPanelMenuItem => ({
    menu: "session.panel",
    id: "plans",
    // Native panel actions use orders 10-30; plugin tabs go after them.
    order: 41,
    title: text("Planos", "Plans"),
    icon: "file-document",
    run: () => {
      const session = ctx.sessions.current();
      if (session) ctx.layout.open(`${ctx.id}:${openPlansId}`, session);
    },
  }));
}
