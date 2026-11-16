/**
 * Work side panel — the user's work items.
 *
 * The panel shows only the project resolved from the session workspace; the
 * overlay (no routed session) shows every project that has items, grouped by
 * project and then by status. This is the read-only list: creating, planning
 * and executing arrive in the following USs.
 */

import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { Accessor } from "solid-js";
import { usePlugin } from "@opencode/plugin/gui";
import type { MountedSession, ServerRef } from "@opencode/plugin/gui";
import {
  SHARED_CSS,
  ScrollNav,
  createScrollNav,
  EmptyState,
  ErrorBanner,
  LoadingRow,
  StatusChip,
} from "opencode-shared/gui";
import { PlansRpc, WORK_STATUS_ORDER, type WorkGroup, type WorkItemStatus } from "./contract";
import { useT } from "./i18n";

export type ViewMode = "work" | "plans";

export type WorkTarget = {
  mode: "panel" | "modal";
  server: ServerRef;
  /** Routed session; undefined in the modal. */
  session?: MountedSession | undefined;
  visible: () => boolean;
};

const VIEW_CSS = `
.plans-view { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.plans-view-switch { display: flex; align-items: center; gap: 4px; padding: 8px 12px 0; flex: 0 0 auto; }
.plans-view-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
`;

const WORK_CSS = `
.work {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  min-height: 0;
  padding: 12px;
  overflow: hidden;
  font-family: var(--font-family-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  color: var(--v2-text-text-base);
  font-size: 12.5px;
}
.work.is-modal { width: 100%; box-sizing: border-box; height: 100%; }
.work-body { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.work-scroll { flex: 1; min-height: 0; overflow-y: auto; padding-right: 2px; }
.work.is-modal .work-scroll { padding-bottom: 24px; overscroll-behavior: contain; }
.work-project { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
.work-project:last-child { margin-bottom: 0; }
.work-project-name {
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--v2-text-text-base);
}
.work-project-count { font-size: 10.5px; font-weight: 500; color: var(--v2-text-text-faint); }
.work-section { display: flex; flex-direction: column; gap: 6px; }
.work-section-head {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--v2-text-text-muted);
}
.work-section-count { font-weight: 500; color: var(--v2-text-text-faint); }
.work-dot { width: 6px; height: 6px; border-radius: 999px; background: var(--v2-text-text-faint); }
.work-dot.is-doing { background: var(--v2-state-fg-info); }
.work-dot.is-ready { background: var(--v2-state-fg-success); }
.work-dot.is-blocked { background: var(--v2-state-fg-danger); }
.work-dot.is-done { background: var(--v2-state-fg-success); opacity: 0.55; }
.work-dot.is-dropped { background: var(--v2-text-text-faint); opacity: 0.55; }
.work-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--v2-border-border-muted);
  border-radius: 6px;
  background: var(--v2-background-bg-layer-01);
}
.work-card-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.work-error-detail { font-size: 11px; color: var(--v2-text-text-muted); overflow-wrap: anywhere; }
`;

/** The panel/overlay switch: Trabalho | Planos. */
export function ViewSwitch(props: { mode: Accessor<ViewMode>; onChange: (mode: ViewMode) => void }) {
  const ctx = usePlugin();
  const t = useT();
  return (
    <>
      <style>{VIEW_CSS}</style>
      <div class="plans-view-switch" role="group" aria-label={t("view.label")}>
        <ctx.ui.Button
          size="small"
          variant={props.mode() === "work" ? "neutral" : "ghost"}
          onClick={() => props.onChange("work")}
        >
          {t("view.work")}
        </ctx.ui.Button>
        <ctx.ui.Button
          size="small"
          variant={props.mode() === "plans" ? "neutral" : "ghost"}
          onClick={() => props.onChange("plans")}
        >
          {t("view.plans")}
        </ctx.ui.Button>
      </div>
    </>
  );
}

const statusLabelKey = (status: WorkItemStatus) => `work.status.${status}`;

export function WorkBody(props: { target: () => WorkTarget }) {
  const ctx = usePlugin();
  const t = useT();
  const [groups, setGroups] = createSignal<WorkGroup[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [reload, setReload] = createSignal(0);

  const scope = () => (props.target().mode === "panel" && props.target().session ? "project" : "all");
  const directory = () => props.target().session?.directory;
  const isModal = () => props.target().mode === "modal";

  // A generation counter drops the result of a request whose target changed.
  let generation = 0;

  createEffect(() => {
    const target = props.target();
    const currentScope = scope();
    const dir = directory();
    void reload();
    const current = ++generation;
    setLoading(true);
    setError(null);

    const options = { ...(dir ? { location: { directory: dir } } : {}) };
    void target.server.client
      .rpc(PlansRpc)
      .listWorkItems({ scope: currentScope, ...(dir ? { directory: dir } : {}) }, options)
      .then((result) => {
        if (current !== generation) return;
        setGroups(result as WorkGroup[]);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (current !== generation) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoading(false);
      });
  });

  const total = createMemo(() => groups().reduce((sum, group) => sum + group.items.length, 0));
  const projectMissing = createMemo(() => scope() === "project" && groups().length === 0);

  const nav = createScrollNav({
    hasMore: () => false,
    loadingMore: () => false,
    loadMore: () => undefined,
    visible: () => props.target().visible(),
    items: total,
  });

  const sectionsFor = (group: WorkGroup) =>
    WORK_STATUS_ORDER.map((status) => ({
      status,
      items: group.items.filter((item) => item.status === status),
    })).filter((section) => section.items.length > 0);

  const empty = () => {
    if (projectMissing()) {
      return { title: t("work.noProject.title"), hint: t("work.noProject.hint") };
    }
    if (scope() === "project") {
      return { title: t("work.project.empty.title"), hint: t("work.project.empty.hint") };
    }
    return { title: t("work.empty.title"), hint: t("work.empty.hint") };
  };

  return (
    <>
      <style>{SHARED_CSS + WORK_CSS}</style>
      <div class="work" classList={{ "is-modal": isModal() }}>
        <Show when={loading()}>
          <LoadingRow label={t("work.loading")} />
        </Show>

        <Show when={!loading() && error()}>
          <ErrorBanner message={t("work.error")} retryLabel={t("work.retry")} onRetry={() => setReload((n) => n + 1)} />
          <div class="work-error-detail">{error()}</div>
        </Show>

        <Show when={!loading() && !error()}>
          <Show
            when={groups().length > 0 && total() > 0}
            fallback={
              <EmptyState
                icon="checklist"
                title={empty().title}
                hint={empty().hint}
              />
            }
          >
            <div class="work-body">
              <div
                class="work-scroll os-scroll"
                ref={nav.ref}
                onKeyDown={nav.onKeyDown}
                tabIndex={nav.scrollable() ? 0 : undefined}
                role="region"
                aria-label={t("work.region")}
              >
                <For each={groups()}>
                  {(group) => (
                    <div class="work-project">
                      <h3 class="work-project-name">
                        {group.project.name}
                        <span class="work-project-count">{group.items.length}</span>
                      </h3>
                      <For each={sectionsFor(group)}>
                        {(section) => (
                          <div class="work-section">
                            <h4 class="work-section-head">
                              <span class={`work-dot is-${section.status}`} />
                              {t(statusLabelKey(section.status))}
                              <span class="work-section-count">{section.items.length}</span>
                            </h4>
                            <For each={section.items}>
                              {(item) => (
                                <div class="work-card">
                                  <span class="work-card-title">{item.title}</span>
                                  <Show when={item.origin === "agent"}>
                                    <StatusChip label={t("work.agent")} tone="info" />
                                  </Show>
                                </div>
                              )}
                            </For>
                          </div>
                        )}
                      </For>
                    </div>
                  )}
                </For>
                <div ref={nav.sentinelRef} class="os-scroll-sentinel" />
              </div>
              <ScrollNav nav={nav} topLabel={t("scroll.top")} bottomLabel={t("scroll.bottom")} />
            </div>
          </Show>
        </Show>
      </div>
    </>
  );
}
