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

import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { usePlugin } from "@opencode/plugin/gui";
import { PlansRpc, type Initiative } from "./contract";
import { useT } from "./i18n";
import { builtinServer, globalTarget } from "./page";
import { closePlansOverlay, openPlansOverlay, overlayMode, plansOverlayOpen, type OverlayMode } from "./overlay-state";
import type { PlansTarget } from "./view";
import { PlansBody } from "./view";
import { WorkBody, workWideMode } from "./work";
import { InitiativesBody } from "./initiatives";
import { initiativeSelection } from "./initiative-selection";

const CSS = `
.plans-modal-scrim {
  position: fixed;
  inset: 0;
  /* The host draws dialogs at z-index 50+; stay below them and above the content. */
  z-index: 45;
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
  justify-content: flex-end;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--v2-border-border-muted);
}
.plans-modal-body { flex: 1; min-height: 0; }
.plans-nav { display: flex; align-items: center; gap: 2px; }
.plans-modal.is-board { width: min(1280px, calc(100% - 20px)); }
`;

const close = (): void => {
  closePlansOverlay();
};

/**
 * The session header entry: the three-way selector (Initiative | Work | Plans).
 * Clicking a segment opens the overlay on that screen; with it open, the
 * segment moves the body. Mounted in the timeline's title row.
 */
export function PlansPill(props: { active: boolean }) {
  const ctx = usePlugin();
  const t = useT();
  const target = () => {
    if (!plansOverlayOpen()) return null;
    const server = builtinServer(ctx);
    return server ? globalTarget(server) : null;
  };
  const modes: readonly OverlayMode[] = ["initiatives", "work", "plans"];
  return (
    <Show when={props.active}>
      <div class="plans-nav" role="group" aria-label={t("view.label")}>
        <For each={modes}>
          {(entry) => (
            <ctx.ui.Button
              size="small"
              variant={overlayMode() === entry ? "neutral" : "ghost-muted"}
              onClick={() => openPlansOverlay(entry)}
            >
              {t(`view.${entry}`)}
            </ctx.ui.Button>
          )}
        </For>
      </div>
      {/* The overlay is fixed and rides the pill's slot item: no second mount. */}
      <Show when={target()}>
        {(current) => (
          <Portal>
            <style>{CSS}</style>
            <PlansModal target={() => current()} onClose={close} />
          </Portal>
        )}
      </Show>
    </Show>
  );
}

/** The overlay: scrim, header, and the shared PlansBody. */
function PlansModal(props: { target: () => PlansTarget; onClose: () => void }) {
  const ctx = usePlugin();
  const t = useT();
  const selection = initiativeSelection(ctx);
  const [initiativeId, setInitiativeId] = createSignal<string | null>(selection.value?.id ?? null);
  const [initiatives, setInitiatives] = createSignal<Initiative[]>([]);
  const [initiativesLoading, setInitiativesLoading] = createSignal(true);
  const [initiativesError, setInitiativesError] = createSignal<string | null>(null);
  const [initiativesRevision, setInitiativesRevision] = createSignal(0);
  let panel: HTMLDivElement | undefined;
  let previous: Element | null = null;

  const select = (id: string) => {
    setInitiativeId(id);
    selection.set({ id });
  };

  const upsert = (initiative: Initiative) => {
    setInitiatives((list) => {
      const exists = list.some((entry) => entry.id === initiative.id);
      return exists
        ? list.map((entry) => (entry.id === initiative.id ? initiative : entry))
        : [...list, initiative];
    });
  };

  createEffect(() => {
    const stored = selection.value;
    if (stored !== undefined && stored.id !== initiativeId()) setInitiativeId(stored.id);
  });

  createEffect(() => {
    void initiativesRevision();
    setInitiativesLoading(true);
    setInitiativesError(null);
    void props.target()
      .server.client.rpc(PlansRpc)
      .listInitiatives({})
      .then((list) => setInitiatives(list as Initiative[]))
      .catch((cause: unknown) => setInitiativesError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setInitiativesLoading(false));
  });

  createEffect(() => {
    const off = props.target()
      .server.client.rpc(PlansRpc)
      .events.on("changed", () => {
        setInitiativesRevision((n) => n + 1);
      });
    onCleanup(off);
  });

  // Resolve a missing/stale selection to the first initiative.
  createEffect(() => {
    const list = initiatives();
    if (list.length === 0) return;
    const id = initiativeId();
    if (!id || !list.some((entry) => entry.id === id)) select(list[0]!.id);
  });

  onMount(() => {
    previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Focus the list itself (not the shell) so Home/End/PageUp/PageDown work
    // without a click.
    const list = panel?.querySelector(".os-scroll");
    if (list instanceof HTMLElement) list.focus();
    else panel?.focus();
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
        classList={{ "is-board": overlayMode() === "work" && workWideMode() }}
        role="dialog"
        aria-modal="true"
        aria-label={t("page.title")}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={trapTab}
      >
        <div class="plans-modal-head">
          <ctx.ui.IconButton icon="close" label={t("close")} onClick={() => props.onClose()} />
        </div>
        <div class="plans-modal-body">
          <Show when={overlayMode() === "initiatives"}>
            <InitiativesBody
              server={props.target().server}
              initiatives={initiatives()}
              loading={initiativesLoading()}
              error={initiativesError()}
              onOpen={(id) => {
                select(id);
                openPlansOverlay("work");
              }}
              onCreated={(initiative) => {
                upsert(initiative);
                select(initiative.id);
                openPlansOverlay("work");
              }}
            />
          </Show>
          <Show when={overlayMode() === "work"}>
            <WorkBody
              target={() => ({
                server: props.target().server,
                visible: () => true,
              })}
              initiativeID={initiativeId() ?? undefined}
              initiatives={initiatives()}
              onSelectInitiative={select}
              onInitiativeChanged={upsert}
              onInitiativeDeleted={(id) => {
                const remaining = initiatives().filter((entry) => entry.id !== id);
                setInitiatives(remaining);
                const next = remaining[0];
                if (next) select(next.id);
                else {
                  setInitiativeId(null);
                  selection.set({ id: null });
                  openPlansOverlay("initiatives");
                }
              }}
            />
          </Show>
          <Show when={overlayMode() === "plans"}>
            <PlansBody target={props.target} />
          </Show>
        </div>
      </div>
    </div>
  );
}
