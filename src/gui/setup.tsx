/**
 * Window-side registration for the Plans side panel, the "all plans" page and
 * the composer pill.
 *
 * The panel is a side tab (one per session). The page is a full-width Settings
 * page with no routed session, opened from the palette or `mod+shift+a`; it is
 * the same `PlansBody`, only without the session filter and session actions.
 *
 * The composer pill is the quick path: it appears above the composer when the
 * session is idle with an active plan and runs that plan in one click.
 */

import type { SetupContext } from "@opencode/plugin/gui";
import { Command, ComposerPill, SettingsPage, Style } from "@opencode/plugin/gui";
import { registerSidePanel, supportedLocale } from "opencode-shared/gui";
import { createPlanPill, PLAY_ICON_CSS } from "./pill";
import { tStatic } from "./i18n";
import { PlansPage } from "./page";
import { PlansView } from "./view";

export const openPlansId = "plans";
export const allPlansPageId = "plans-all";

export function setup(ctx: SetupContext<never>): void {
  const locale = () => supportedLocale(ctx.locale.locale());

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

  ctx.add(SettingsPage, (): SettingsPage => ({
    id: allPlansPageId,
    icon: "checklist",
    get title() {
      return tStatic(locale(), "page.title");
    },
    render: () => <PlansPage />,
  }));

  ctx.add(Command, (): Command => ({
    id: "open-all-plans",
    get title() {
      return tStatic(locale(), "page.command");
    },
    get description() {
      return tStatic(locale(), "page.commandDescription");
    },
    keywords: "plans all todos global",
    section: "navigation",
    bind: "mod+shift+a",
    run: () => ctx.layout.settings(allPlansPageId),
  }));

  const pill = createPlanPill(ctx);
  ctx.add(Style, PLAY_ICON_CSS);
  ctx.add(ComposerPill, () => ({
    id: "execute-plan",
    order: 10,
    show: (input) => pill.show(input.session),
  }));
}
