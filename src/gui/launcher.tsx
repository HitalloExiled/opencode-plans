/**
 * The global plans launcher: a bar in the host's `window.bottom` slot that
 * opens every saved plan in a near-full-window overlay.
 *
 * It shows only while the builtin server has an active plan, and keeps the
 * count fresh from the `PlansRpc` changed event. The bar stays mounted while
 * hidden so the overlay keeps its owner when the count drops to zero (marking
 * the last active plan done must not close the modal under the user).
 *
 * The overlay is ours, not `ctx.ui.Dialog`: the host caps dialogs at 980×600
 * and the modal must cover the window minus a 10px gutter. Esc, outside click,
 * focus and scroll lock are handled here, following the plan editor's overlay.
 */

import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { usePlugin } from "@opencode/plugin/gui";
import { PlansRpc } from "./contract";
import { useT } from "./i18n";
import { builtinServer, globalTarget } from "./page";
import type { PlansTarget } from "./view";
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
.plans-modal-scrim {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: 10px;
  background: var(--v2-overlay-simple-overlay-scrim);
}
.plans-modal {
  display: flex;
  flex-direction: column;
  width: min(900px, 100%);
  height: min(640px, 100%);
  min-height: 0;
  box-sizing: border-box;
  overflow: hidden;
  border-radius: 8px;
  background: var(--v2-background-bg-layer-01);
  box-shadow: var(--v2-elevation-raised);
  outline: none;
}
.plans-modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--v2-border-border-muted);
}
.plans-modal-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--v2-text-text-base);
}
.plans-modal-body { flex: 1; min-height: 0; }
`;

/** The overlay: scrim, header, and the shared PlansBody. */
function PlansModal(props: { target: PlansTarget; onClose: () => void }) {
  const ctx = usePlugin();
  const t = useT();
  let panel: HTMLDivElement | undefined;
  let previous: Element | null = null;

  onMount(() => {
    previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      if (previous instanceof HTMLElement) previous.focus();
    });
  });

  // Keep Tab inside the overlay; the panel itself takes focus first.
  const trapTab = (event: KeyboardEvent) => {
    if (event.key !== "Tab" || !panel) return;
    const focusables = panel.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    const first = focusables[0];
    if (!first) {
      event.preventDefault();
      return;
    }
    const last = focusables[focusables.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div class="plans-modal-scrim" onClick={() => props.onClose()}>
      <div
        ref={panel}
        class="plans-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("page.title")}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={trapTab}
      >
        <div class="plans-modal-head">
          <h2 class="plans-modal-title">{t("page.title")}</h2>
          <ctx.ui.IconButton icon="close" label={t("close")} onClick={() => props.onClose()} />
        </div>
        <div class="plans-modal-body">
          <PlansBody target={() => props.target} />
        </div>
      </div>
    </div>
  );
}

export function PlansLauncher() {
  const ctx = usePlugin();
  const t = useT();
  const [active, setActive] = createSignal(0);
  const [opened, setOpened] = createSignal<PlansTarget | null>(null);

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
    setOpened(globalTarget(server));
  };

  return (
    <>
      <style>{CSS}</style>
      <div class="plans-launcher" classList={{ "is-hidden": active() === 0 }}>
        <ctx.ui.Button size="small" variant="ghost" icon="checklist" onClick={open}>
          {t("launcher.label", active())}
        </ctx.ui.Button>
      </div>
      <Show when={opened()}>
        {(target) => <PlansModal target={target()} onClose={() => setOpened(null)} />}
      </Show>
    </>
  );
}
