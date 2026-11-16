/**
 * Work side panel — the user's work items.
 *
 * The panel shows only the project resolved from the session workspace; the
 * overlay (no routed session) shows every project that has items, grouped by
 * project and then by status. A card opens the item detail, where the need is
 * read and edited inline. Planning/executing arrive in the following USs.
 */

import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
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
  type ChipTone,
} from "opencode-shared/gui";
import {
  PlansRpc,
  WORK_ITEM_TRANSITIONS,
  WORK_STATUS_ORDER,
  type WorkGroup,
  type WorkItemDetail,
  type PlanSummary,
  type WorkItemStatus,
} from "./contract";
import { useT } from "./i18n";
import { filterWorkGroups } from "../work-filter";
import { planWorkItem } from "./plan-item";

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
  cursor: pointer;
}
.work-card:hover { background-image: linear-gradient(var(--v2-overlay-simple-overlay-hover), var(--v2-overlay-simple-overlay-hover)); }
.work-card:focus-visible { outline: 2px solid var(--v2-border-border-focus); outline-offset: -2px; }
.work-card-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.work-toolbar { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
.work-new { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
.work-new > :first-child { flex: 1; min-width: 0; }
.work-detail { display: flex; flex-direction: column; gap: 10px; flex: 1; min-height: 0; }
.work-detail-head { display: flex; align-items: center; gap: 6px; }
.work-detail-title { flex: 1; min-width: 0; margin: 0; font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.work-detail-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--v2-text-text-muted); font-size: 11px; }
.work-detail-body { flex: 1; min-height: 0; overflow-y: auto; }
.work-deps { display: flex; flex-direction: column; gap: 6px; }
.work-deps-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.work-deps-title {
  margin: 0;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--v2-text-text-muted);
}
.work-dep-label { font-size: 10.5px; color: var(--v2-text-text-faint); }
.work-dep-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.work-dep-row .work-dot { flex: 0 0 auto; }
.work-deps-empty { font-size: 11px; color: var(--v2-text-text-muted); }
.work-detail-empty { color: var(--v2-text-text-muted); font-size: 11.5px; }
.work-editor { display: flex; flex-direction: column; gap: 8px; flex: 1; min-height: 0; }
.work-editor textarea {
  flex: 1;
  min-height: 120px;
  resize: none;
  font: inherit;
  color: var(--v2-text-text-base);
  background: var(--v2-background-bg-layer-01);
  border: 1px solid var(--v2-border-border-strong);
  border-radius: 6px;
  padding: 8px;
}
.work-editor-actions { display: flex; gap: 6px; justify-content: flex-end; }
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

const planTone = (status: PlanSummary["status"]): ChipTone =>
  status === "active"
    ? "info"
    : status === "done"
      ? "success"
      : status === "superseded"
        ? "warning"
        : "neutral";

const statusTone = (status: WorkItemStatus): ChipTone =>
  status === "doing" ? "info" : status === "ready" || status === "done" ? "success" : status === "blocked" ? "danger" : "neutral";

export function WorkBody(props: { target: () => WorkTarget }) {
  const ctx = usePlugin();
  const t = useT();
  const [groups, setGroups] = createSignal<WorkGroup[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [reload, setReload] = createSignal(0);

  const [selectedID, setSelectedID] = createSignal<string | undefined>(undefined);
  const [detail, setDetail] = createSignal<WorkItemDetail | null>(null);
  const [detailLoading, setDetailLoading] = createSignal(false);
  const [detailError, setDetailError] = createSignal<string | null>(null);
  const [detailReload, setDetailReload] = createSignal(0);
  const [editing, setEditing] = createSignal(false);
  const [editTitle, setEditTitle] = createSignal("");
  const [editBody, setEditBody] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [statusSaving, setStatusSaving] = createSignal(false);
  const [moving, setMoving] = createSignal(false);
  const [depSaving, setDepSaving] = createSignal(false);
  const [parentSaving, setParentSaving] = createSignal(false);
  const [planning, setPlanning] = createSignal(false);
  const [newTitle, setNewTitle] = createSignal("");
  const [creating, setCreating] = createSignal(false);
  const [actionError, setActionError] = createSignal<string | null>(null);
  const [agentOnly, setAgentOnly] = createSignal(false);
  const [showDropped, setShowDropped] = createSignal(false);

  const scope = () => (props.target().mode === "panel" && props.target().session ? "project" : "all");
  const directory = () => props.target().session?.directory;
  const isModal = () => props.target().mode === "modal";

  const rpcOptions = () => {
    const dir = directory();
    return { ...(dir ? { location: { directory: dir } } : {}) };
  };

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

    void target.server.client
      .rpc(PlansRpc)
      .listWorkItems({ scope: currentScope, ...(dir ? { directory: dir } : {}) }, rpcOptions())
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

  // Commands and the agent write outside this component; re-read on the shared
  // change event instead of waiting for a remount.
  createEffect(() => {
    const off = props.target().server.client.rpc(PlansRpc).events.on("changed", () => {
      setReload((n) => n + 1);
    });
    onCleanup(off);
  });

  let detailGeneration = 0;
  createEffect(() => {
    const id = selectedID();
    void detailReload();
    const target = props.target();
    if (!id) {
      setDetail(null);
      setDetailLoading(false);
      return;
    }
    const current = ++detailGeneration;
    setDetailLoading(true);
    setDetailError(null);
    void target.server.client
      .rpc(PlansRpc)
      .getWorkItem({ id }, rpcOptions())
      .then((value) => {
        if (current !== detailGeneration) return;
        setDetail(value as WorkItemDetail | null);
        setDetailLoading(false);
      })
      .catch((cause: unknown) => {
        if (current !== detailGeneration) return;
        setDetailError(cause instanceof Error ? cause.message : String(cause));
        setDetailLoading(false);
      });
  });

  const visibleGroups = createMemo(() =>
    filterWorkGroups(groups(), { agentOnly: agentOnly(), showDropped: showDropped() }),
  );
  const total = createMemo(() => visibleGroups().reduce((sum, group) => sum + group.items.length, 0));
  const projectMissing = createMemo(() => scope() === "project" && groups().length === 0);
  const hasAgentItems = createMemo(() =>
    groups().some((group) => group.items.some((item) => item.origin === "agent")),
  );
  const hasDropped = createMemo(() =>
    groups().some((group) => group.items.some((item) => item.status === "dropped")),
  );

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
    if (agentOnly()) {
      return { title: t("work.empty.agent.title"), hint: t("work.empty.agent.hint") };
    }
    if (scope() === "project") {
      return { title: t("work.project.empty.title"), hint: t("work.project.empty.hint") };
    }
    return { title: t("work.empty.title"), hint: t("work.empty.hint") };
  };

  const openItem = (id: string) => {
    setActionError(null);
    setEditing(false);
    setSelectedID(id);
  };

  const closeDetail = () => {
    setSelectedID(undefined);
    setEditing(false);
    setDetail(null);
    setActionError(null);
  };

  const startEdit = () => {
    const current = detail();
    if (!current) return;
    setEditTitle(current.item.title);
    setEditBody(current.item.body);
    setActionError(null);
    setEditing(true);
  };

  const saveEdit = () => {
    const id = selectedID();
    if (!id) return;
    const title = editTitle().trim();
    if (!title) return;
    setSaving(true);
    setActionError(null);
    void props.target()
      .server.client.rpc(PlansRpc)
      .saveWorkItem({ id, title, body: editBody() }, rpcOptions())
      .then((result) => {
        if (!result.ok) {
          setActionError(result.error ?? t("work.save.error"));
          return;
        }
        setEditing(false);
        setDetailReload((n) => n + 1);
        setReload((n) => n + 1);
      })
      .catch((cause: unknown) => setActionError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setSaving(false));
  };

  const depCandidates = createMemo(() => {
    const current = detail();
    if (!current) return [];
    const group = groups().find((entry) => entry.project.id === current.item.projectID);
    if (!group) return [];
    const existing = new Set(current.blockedBy.map((item) => item.id));
    return group.items.filter((item) => item.id !== current.item.id && !existing.has(item.id));
  });

  const addDep = (blocksID: string) => {
    const id = selectedID();
    if (!id || depSaving()) return;
    setDepSaving(true);
    setActionError(null);
    void props.target()
      .server.client.rpc(PlansRpc)
      .addWorkItemDep({ itemID: id, blocksID }, rpcOptions())
      .then((result) => {
        if (!result.ok) {
          setActionError(result.error ?? t("work.deps.error"));
          return;
        }
        setDetailReload((n) => n + 1);
      })
      .catch((cause: unknown) => setActionError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setDepSaving(false));
  };

  const removeDep = (blocksID: string) => {
    const id = selectedID();
    if (!id || depSaving()) return;
    setDepSaving(true);
    setActionError(null);
    void props.target()
      .server.client.rpc(PlansRpc)
      .removeWorkItemDep({ itemID: id, blocksID }, rpcOptions())
      .then((result) => {
        if (!result.ok) {
          setActionError(result.error ?? t("work.deps.error"));
          return;
        }
        setDetailReload((n) => n + 1);
      })
      .catch((cause: unknown) => setActionError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setDepSaving(false));
  };

  const parentCandidates = createMemo(() => {
    const current = detail();
    if (!current || current.children.length > 0) return [];
    const group = groups().find((entry) => entry.project.id === current.item.projectID);
    if (!group) return [];
    return group.items.filter(
      (item) => item.id !== current.item.id && item.parentID === undefined && item.id !== current.parent?.id,
    );
  });

  const planDetail = (current: WorkItemDetail) => {
    if (planning()) return;
    setPlanning(true);
    setActionError(null);
    void planWorkItem({ ctx, target: props.target(), detail: current, t })
      .catch((cause: unknown) => setActionError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPlanning(false));
  };

  const planFromCard = (id: string) => {
    if (planning()) return;
    setPlanning(true);
    setActionError(null);
    void props.target()
      .server.client.rpc(PlansRpc)
      .getWorkItem({ id }, rpcOptions())
      .then((current) => {
        if (!current) throw new Error(t("work.plan.error"));
        return planWorkItem({ ctx, target: props.target(), detail: current as WorkItemDetail, t });
      })
      .catch((cause: unknown) => setActionError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPlanning(false));
  };

  const setParent = (parentID: string | null) => {
    const id = selectedID();
    if (!id || parentSaving()) return;
    setParentSaving(true);
    setActionError(null);
    void props.target()
      .server.client.rpc(PlansRpc)
      .setWorkItemParent({ id, parentID }, rpcOptions())
      .then((result) => {
        if (!result.ok) {
          setActionError(result.error ?? t("work.hier.error"));
          return;
        }
        setDetailReload((n) => n + 1);
        setReload((n) => n + 1);
      })
      .catch((cause: unknown) => setActionError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setParentSaving(false));
  };

  const statusPosition = createMemo(() => {
    const current = detail();
    if (!current) return undefined;
    const group = groups().find((entry) => entry.project.id === current.item.projectID);
    if (!group) return undefined;
    const same = group.items.filter((item) => item.status === current.item.status);
    const index = same.findIndex((item) => item.id === current.item.id);
    if (index < 0) return undefined;
    return { index, total: same.length };
  });

  const move = (direction: "up" | "down") => {
    const id = selectedID();
    if (!id || moving()) return;
    setMoving(true);
    setActionError(null);
    void props.target()
      .server.client.rpc(PlansRpc)
      .moveWorkItem({ id, direction }, rpcOptions())
      .then((result) => {
        if (!result.ok) {
          setActionError(result.error ?? t("work.move.error"));
          return;
        }
        setDetailReload((n) => n + 1);
        setReload((n) => n + 1);
      })
      .catch((cause: unknown) => setActionError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setMoving(false));
  };

  const changeStatus = async (status: WorkItemStatus) => {
    const id = selectedID();
    if (!id || statusSaving()) return;

    if (status === "dropped") {
      const current = detail();
      const confirmed = await ctx.dialogs.confirm({
        title: t("work.drop.title"),
        description: t("work.drop.message", current?.item.title ?? ""),
        confirm: t("work.drop.confirm"),
        cancel: t("cancel"),
        danger: true,
      });
      if (!confirmed) return;
    }

    setStatusSaving(true);
    setActionError(null);
    void props.target()
      .server.client.rpc(PlansRpc)
      .setWorkItemStatus({ id, status }, rpcOptions())
      .then((result) => {
        if (!result.ok) {
          setActionError(result.error ?? t("work.status.error"));
          return;
        }
        setDetailReload((n) => n + 1);
        setReload((n) => n + 1);
      })
      .catch((cause: unknown) => setActionError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setStatusSaving(false));
  };

  const createItem = () => {
    const dir = directory();
    const title = newTitle().trim();
    if (!dir || !title || creating()) return;
    setCreating(true);
    setActionError(null);
    void props.target()
      .server.client.rpc(PlansRpc)
      .saveWorkItem({ directory: dir, title }, rpcOptions())
      .then((result) => {
        if (!result.ok) {
          setActionError(result.error ?? t("work.create.error"));
          return;
        }
        setNewTitle("");
        setReload((n) => n + 1);
      })
      .catch((cause: unknown) => setActionError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setCreating(false));
  };

  return (
    <>
      <style>{SHARED_CSS + WORK_CSS}</style>
      <div class="work" classList={{ "is-modal": isModal() }}>
        <Show when={!selectedID()}>
          <Show when={hasAgentItems() || hasDropped()}>
            <div class="work-toolbar">
              <Show when={hasAgentItems()}>
                <ctx.ui.Button
                  size="small"
                  variant={agentOnly() ? "neutral" : "ghost"}
                  icon="review"
                  onClick={() => setAgentOnly((value) => !value)}
                >
                  {t("work.filter.agent")}
                </ctx.ui.Button>
              </Show>
              <Show when={hasDropped()}>
                <ctx.ui.Button
                  size="small"
                  variant={showDropped() ? "neutral" : "ghost"}
                  icon="archive"
                  onClick={() => setShowDropped((value) => !value)}
                >
                  {t("work.filter.dropped")}
                </ctx.ui.Button>
              </Show>
            </div>
          </Show>

          <Show when={!isModal() && directory()}>
            <div class="work-new">
              <ctx.ui.TextInput
                value={newTitle()}
                onInput={(value) => setNewTitle(value)}
                onSubmit={() => createItem()}
                label={t("work.newItem")}
                placeholder={t("work.newItem.placeholder")}
              />
              <ctx.ui.Button
                size="small"
                variant="neutral"
                icon="plus"
                disabled={!newTitle().trim() || creating()}
                busy={creating()}
                onClick={() => createItem()}
              >
                {t("work.newItem.add")}
              </ctx.ui.Button>
            </div>
          </Show>

          <Show when={actionError()}>
            <ErrorBanner message={actionError()!} />
          </Show>

          <Show when={loading()}>
            <LoadingRow label={t("work.loading")} />
          </Show>

          <Show when={!loading() && error()}>
            <ErrorBanner message={t("work.error")} retryLabel={t("work.retry")} onRetry={() => setReload((n) => n + 1)} />
            <div class="work-error-detail">{error()}</div>
          </Show>

          <Show when={!loading() && !error()}>
            <Show
              when={visibleGroups().length > 0 && total() > 0}
              fallback={<EmptyState icon="checklist" title={empty().title} hint={empty().hint} />}
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
                  <For each={visibleGroups()}>
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
                                  <div
                                    class="work-card"
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => openItem(item.id)}
                                    onKeyDown={(event) => {
                                      if (event.target !== event.currentTarget) return;
                                      if (event.key === "Enter" || event.key === " ") {
                                        event.preventDefault();
                                        openItem(item.id);
                                      }
                                    }}
                                  >
                                    <span class="work-card-title">{item.title}</span>
                                    <Show when={item.origin === "agent"}>
                                      <StatusChip label={t("work.agent")} tone="info" />
                                    </Show>
                                    <ctx.ui.IconButton
                                      icon="brain"
                                      label={t("work.plan")}
                                      disabled={planning()}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        planFromCard(item.id);
                                      }}
                                    />
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
        </Show>

        <Show when={selectedID()}>
          <Show when={detailLoading()}>
            <LoadingRow label={t("work.loading")} />
          </Show>

          <Show when={!detailLoading() && detailError()}>
            <ErrorBanner message={t("work.error")} retryLabel={t("work.retry")} onRetry={() => setDetailReload((n) => n + 1)} />
            <div class="work-error-detail">{detailError()}</div>
          </Show>

          <Show when={!detailLoading() && !detailError() && detail()}>
            {(current) => (
              <div class="work-detail">
                <div class="work-detail-head">
                  <ctx.ui.IconButton icon="arrow-left" label={t("work.back")} onClick={closeDetail} />
                  <h2 class="work-detail-title">{current().item.title}</h2>
                  <ctx.ui.Button
                    size="small"
                    variant="contrast"
                    icon="brain"
                    busy={planning()}
                    onClick={() => planDetail(current())}
                  >
                    {t("work.plan")}
                  </ctx.ui.Button>
                  <ctx.ui.Button size="small" variant="neutral" icon="pencil-line" onClick={startEdit}>
                    {t("work.edit")}
                  </ctx.ui.Button>
                </div>

                <div class="work-detail-meta">
                  <StatusChip
                    tone={statusTone(current().item.status)}
                    label={t(statusLabelKey(current().item.status))}
                  />
                  <Show when={current().item.origin === "agent"}>
                    <StatusChip label={t("work.agent")} tone="info" />
                  </Show>
                  <span>
                    {t("work.detail.project")}: {current().project.name}
                  </span>
                  <ctx.ui.Menu
                    trigger="button"
                    icon="status"
                    label={t("work.status.change")}
                    disabled={statusSaving()}
                    items={WORK_STATUS_ORDER.map((status) => ({
                      label: t(statusLabelKey(status)),
                      disabled:
                        status === current().item.status ||
                        !WORK_ITEM_TRANSITIONS[current().item.status].includes(status),
                      onSelect: () => {
                        void changeStatus(status);
                      },
                    }))}
                  />
                  <ctx.ui.IconButton
                    icon="arrow-up"
                    label={t("work.moveUp")}
                    disabled={moving() || !(statusPosition()?.index ?? 0)}
                    onClick={() => move("up")}
                  />
                  <ctx.ui.IconButton
                    icon="arrow-down-to-line"
                    label={t("work.moveDown")}
                    disabled={moving() || (statusPosition()?.index ?? 0) >= (statusPosition()?.total ?? 1) - 1}
                    onClick={() => move("down")}
                  />
                </div>

                <div class="work-deps">
                  <div class="work-deps-head">
                    <h3 class="work-deps-title">{t("work.plan.section")}</h3>
                  </div>
                  <Show
                    when={current().plan}
                    fallback={<div class="work-deps-empty">{t("work.plan.none")}</div>}
                  >
                    {(plan) => (
                      <div class="work-dep-row">
                        <StatusChip tone={planTone(plan().status)} label={t(`status.${plan().status}`)} />
                        <span class="work-card-title">{plan().title}</span>
                        <span class="work-dep-label">
                          {t("work.plan.progress", plan().done, plan().total)}
                        </span>
                      </div>
                    )}
                  </Show>
                </div>

                <div class="work-deps">
                  <div class="work-deps-head">
                    <h3 class="work-deps-title">{t("work.deps.title")}</h3>
                    <Show when={depCandidates().length > 0}>
                      <ctx.ui.Menu
                        trigger="button"
                        icon="plus"
                        label={t("work.deps.add")}
                        disabled={depSaving()}
                        items={depCandidates().map((item) => ({
                          label: item.title,
                          onSelect: () => addDep(item.id),
                        }))}
                      />
                    </Show>
                  </div>

                  <Show
                    when={current().blockedBy.length > 0}
                    fallback={<div class="work-deps-empty">{t("work.deps.none")}</div>}
                  >
                    <span class="work-dep-label">{t("work.deps.blockedBy")}</span>
                    <For each={current().blockedBy}>
                      {(dep) => (
                        <div class="work-dep-row">
                          <span class={`work-dot is-${dep.status}`} />
                          <ctx.ui.Button size="small" variant="ghost" onClick={() => openItem(dep.id)}>
                            {dep.title}
                          </ctx.ui.Button>
                          <ctx.ui.IconButton
                            icon="close-small"
                            label={t("work.deps.remove", dep.title)}
                            disabled={depSaving()}
                            onClick={() => removeDep(dep.id)}
                          />
                        </div>
                      )}
                    </For>
                  </Show>

                  <Show when={current().blocks.length > 0}>
                    <span class="work-dep-label">{t("work.deps.blocks")}</span>
                    <For each={current().blocks}>
                      {(dep) => (
                        <div class="work-dep-row">
                          <span class={`work-dot is-${dep.status}`} />
                          <ctx.ui.Button size="small" variant="ghost" onClick={() => openItem(dep.id)}>
                            {dep.title}
                          </ctx.ui.Button>
                        </div>
                      )}
                    </For>
                  </Show>
                </div>

                <div class="work-deps">
                  <div class="work-deps-head">
                    <h3 class="work-deps-title">{t("work.hier.title")}</h3>
                    <Show when={parentCandidates().length > 0}>
                      <ctx.ui.Menu
                        trigger="button"
                        icon="plus"
                        label={t("work.hier.set")}
                        disabled={parentSaving()}
                        items={parentCandidates().map((item) => ({
                          label: item.title,
                          onSelect: () => setParent(item.id),
                        }))}
                      />
                    </Show>
                  </div>

                  <Show when={current().parent}>
                    {(parent) => (
                      <>
                        <span class="work-dep-label">{t("work.hier.parent")}</span>
                        <div class="work-dep-row">
                          <span class={`work-dot is-${parent().status}`} />
                          <ctx.ui.Button size="small" variant="ghost" onClick={() => openItem(parent().id)}>
                            {parent().title}
                          </ctx.ui.Button>
                          <ctx.ui.IconButton
                            icon="close-small"
                            label={t("work.hier.clear")}
                            disabled={parentSaving()}
                            onClick={() => setParent(null)}
                          />
                        </div>
                      </>
                    )}
                  </Show>

                  <Show
                    when={current().children.length > 0}
                    fallback={
                      <Show when={!current().parent}>
                        <div class="work-deps-empty">{t("work.hier.none")}</div>
                      </Show>
                    }
                  >
                    <span class="work-dep-label">{t("work.hier.children")}</span>
                    <For each={current().children}>
                      {(child) => (
                        <div class="work-dep-row">
                          <span class={`work-dot is-${child.status}`} />
                          <ctx.ui.Button size="small" variant="ghost" onClick={() => openItem(child.id)}>
                            {child.title}
                          </ctx.ui.Button>
                        </div>
                      )}
                    </For>
                  </Show>
                </div>

                <Show when={actionError()}>
                  <ErrorBanner message={actionError()!} />
                </Show>

                <Show
                  when={editing()}
                  fallback={
                    <Show
                      when={current().item.body.trim()}
                      fallback={<div class="work-detail-empty">{t("work.detail.noBody")}</div>}
                    >
                      <ctx.ui.Markdown text={current().item.body} class="work-detail-body" />
                    </Show>
                  }
                >
                  <div class="work-editor">
                    <ctx.ui.TextInput
                      value={editTitle()}
                      onInput={(value) => setEditTitle(value)}
                      label={t("work.detail.title")}
                      invalid={!editTitle().trim()}
                    />
                    <textarea
                      value={editBody()}
                      aria-label={t("work.detail.body")}
                      placeholder={t("work.detail.bodyHint")}
                      onInput={(event) => setEditBody(event.currentTarget.value)}
                    />
                    <div class="work-editor-actions">
                      <ctx.ui.Button size="small" variant="ghost" onClick={() => setEditing(false)}>
                        {t("cancel")}
                      </ctx.ui.Button>
                      <ctx.ui.Button
                        size="small"
                        variant="contrast"
                        busy={saving()}
                        disabled={!editTitle().trim()}
                        onClick={saveEdit}
                      >
                        {t("work.save")}
                      </ctx.ui.Button>
                    </div>
                  </div>
                </Show>
              </div>
            )}
          </Show>
        </Show>
      </div>
    </>
  );
}
