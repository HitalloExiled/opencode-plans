/**
 * The "all plans" page: every plan on the builtin server, with no routed
 * session. It reuses `PlansBody`, so the visible difference from the side panel
 * is the filter row (Project | All) and the missing session actions.
 */

import { Show } from "solid-js";
import { usePlugin } from "@opencode/plugin/gui";
import { LoadingRow } from "opencode-shared/gui";
import { useT } from "./i18n";
import { PlansBody } from "./view";

export function PlansPage() {
  const ctx = usePlugin();
  const t = useT();
  // plans.db belongs to the server that runs the plugin; the desktop's own
  // server is the builtin one.
  const builtin = () =>
    ctx.servers
      .list()
      .map((id) => ctx.servers.get(id))
      .find((server) => server?.builtin);

  return (
    <Show when={builtin()} fallback={<LoadingRow label={t("loading")} />}>
      {(server) => (
        <PlansBody
          target={() => ({
            mode: "page",
            server: server(),
            storageKey: `plans:all:${server().id}`,
            visible: () => true,
            projectName: () => "",
          })}
        />
      )}
    </Show>
  );
}
