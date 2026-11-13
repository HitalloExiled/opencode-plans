/**
 * Window-side registration for the Plans side panel, the titlebar pill and the
 * composer pill.
 *
 * The panel is a side tab (one per session). The global surface is the titlebar
 * pill: it shows the active plan count and opens the all-plans overlay, which
 * the plugin renders from a `window.bottom` slot item (nothing visible while
 * closed). No keyboard shortcuts.
 *
 * The composer pill is the quick path: it appears above the composer when the
 * session is idle with an active plan and runs that plan in one click.
 */

import type { SetupContext } from "@opencode/plugin/gui";
import { ComposerPill, Slot, Style, TitlebarItem } from "@opencode/plugin/gui";
import { registerSidePanel, supportedLocale } from "opencode-shared/gui";
import { activePlanCount, openPlansOverlay, PlansOverlay, startPlansCount } from "./launcher";
import { tStatic } from "./i18n";
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

  // A titlebar pill per plugin; the host lays them side by side. The overlay
  // itself needs a place in the plugin's tree, hence the slot item that renders
  // nothing while closed.
  ctx.add(TitlebarItem, (): TitlebarItem => ({
    id: "plans",
    icon: "checklist",
    label: tStatic(supportedLocale(ctx.locale.locale()), "launcher.label", activePlanCount()),
    title: tStatic(supportedLocale(ctx.locale.locale()), "launcher.tooltip"),
    run: openPlansOverlay,
  }));
  ctx.add(Slot, { at: "window.bottom", order: 10, render: () => <PlansOverlay /> });

  const pill = createPlanPill(ctx);
  ctx.add(Style, PLAY_ICON_CSS);
  ctx.add(ComposerPill, () => ({
    id: "execute-plan",
    order: 10,
    show: (input) => pill.show(input.session),
  }));

  return stopCount;
}
