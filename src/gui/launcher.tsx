/**
 * The global plans launcher: a bar in the host's `window.bottom` slot that
 * opens every saved plan in a modal.
 *
 * It shows only while the builtin server has an active plan, and keeps the
 * count fresh from the `PlansRpc` changed event. The bar stays mounted while
 * hidden so the dialog's owner outlives a count that drops to zero (marking the
 * last active plan done must not close the modal under the user).
 */

import { createEffect, createSignal, getOwner, onCleanup, runWithOwner } from "solid-js";
import { usePlugin } from "@opencode/plugin/gui";
import { PlansRpc } from "./contract";
import { useT } from "./i18n";
import { builtinServer, globalTarget } from "./page";
import { PlansBody } from "./view";

const CSS = `
.plans-launcher {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  padding: 3px 12px;
  border-top: 1px solid var(--v2-border-border-muted);
  background: var(--v2-background-bg-base);
}
.plans-launcher.is-hidden { display: none; }
`;

export function PlansLauncher() {
  const ctx = usePlugin();
  const t = useT();
  // The dialog lives as long as the owner that opened it; the bar stays
  // mounted, so the launcher's owner is the right one (a click handler has
  // none of its own).
  const owner = getOwner();
  const [active, setActive] = createSignal(0);

  createEffect(() => {
    const server = builtinServer(ctx);
    if (!server) {
      setActive(0);
      return;
    }
    const rpc = server.client.rpc(PlansRpc);
    let live = true;
    const refresh = () => {
      void rpc
        .count({ scope: "all", status: "active" })
        .then((count) => {
          if (live) setActive(count);
        })
        .catch(() => undefined);
    };
    refresh();
    const off = rpc.events.on("changed", () => refresh());
    onCleanup(() => {
      live = false;
      off();
    });
  });

  const open = () => {
    const server = builtinServer(ctx);
    if (!server) return;
    const target = globalTarget(server);
    runWithOwner(owner, () =>
      ctx.dialogs.open((dialog) => (
        <ctx.ui.Dialog
          title={t("page.title")}
          size="x-large"
          footer={
            <ctx.ui.Button size="small" variant="ghost" onClick={dialog.close}>
              {t("close")}
            </ctx.ui.Button>
          }
        >
          <PlansBody target={() => target} />
        </ctx.ui.Dialog>
      )),
    );
  };

  return (
    <div class="plans-launcher" classList={{ "is-hidden": active() === 0 }}>
      <style>{CSS}</style>
      <ctx.ui.Button size="small" variant="ghost" icon="checklist" onClick={open}>
        {t("launcher.label", active())}
      </ctx.ui.Button>
    </div>
  );
}
