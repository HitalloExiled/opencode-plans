/**
 * The global plans surface: a titlebar pill with the active count and the
 * large overlay it opens.
 *
 * The pill lives in the host's titlebar (two plugins can sit side by side
 * there); the overlay covers the window with the shared `PlansBody`. The count
 * is module state so the pill and the overlay (both in the same slot item)
 * read the same signal.
 *
 * The overlay is ours, not `ctx.ui.Dialog`: the host caps dialogs at 980×600,
 * and this one is capped at 900×640, keeping a 10px gutter on smaller windows.
 * Esc, outside click, focus and scroll lock are handled here, following the
 * plan editor's overlay.
 */

import { createEffect, createRoot, createSignal, onCleanup, onMount, Show } from "solid-js";
import { usePlugin } from "@opencode/plugin/gui";
import type { Context } from "@opencode/plugin/gui";
import { PlansRpc } from "./contract";
import { useT } from "./i18n";
import { builtinServer, globalTarget } from "./page";
import type { PlansTarget } from "./view";
import { PlansBody } from "./view";

const CSS = `
.plans-modal-scrim {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  background: var(--v2-overlay-simple-overlay-scrim);
}
.plans-modal {
  display: flex;
  flex-direction: column;
  width: min(900px, calc(100% - 20px));
  height: calc(100% - 40px);
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

const [active, setActive] = createSignal(0);
const [opened, setOpened] = createSignal(false);

/** Active plans, for the titlebar pill. */
export const activePlanCount = (): number => active();
export const openPlansOverlay = (): void => {
  setOpened(true);
};
const close = (): void => {
  setOpened(false);
};

/**
 * Keeps the active-plan count fresh for the pill. Call once from `setup`; the
 * returned cleanup stops the subscription.
 */
export function startPlansCount(ctx: Context): () => void {
  return createRoot((dispose) => {
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
    return dispose;
  });
}

/**
 * The session header entry: a small pill with the active count. Mounted by the
 * host in the timeline's title row, next to the other plugins' pills.
 */
export function PlansPill(props: { active: boolean }) {
  const ctx = usePlugin();
  const t = useT();
  const target = () => {
    if (!opened()) return null;
    const server = builtinServer(ctx);
    return server ? globalTarget(server) : null;
  };
  return (
    <Show when={props.active}>
      <ctx.ui.Button size="small" variant="ghost-muted" icon="checklist" onClick={openPlansOverlay}>
        {t("launcher.label", activePlanCount())}
      </ctx.ui.Button>
      {/* The overlay is fixed and rides the pill's slot item: no second mount. */}
      <Show when={target()}>
        {(current) => (
          <>
            <style>{CSS}</style>
            <PlansModal target={() => current()} onClose={close} />
          </>
        )}
      </Show>
    </Show>
  );
}

/** The overlay: scrim, header, and the shared PlansBody. */
function PlansModal(props: { target: () => PlansTarget; onClose: () => void }) {
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
    const current = document.activeElement;
    if (event.shiftKey && (current === first || current === panel)) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && current === last) {
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
          <PlansBody target={props.target} />
        </div>
      </div>
    </div>
  );
}
