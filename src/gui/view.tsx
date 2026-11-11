/**
 * Plans side panel — SolidJS UI.
 *
 * Reads and writes plans over the server plugin's RPC (`PlansRpc`). The
 * server owns `plans.db`, so list/read/write share one schema and follow the
 * plugin's hot reload. The panel is a master/detail view: plan cards with
 * status/progress, then a detail with the checklist and the original Markdown.
 */

import { createEffect, createMemo, createSignal, For, Index, onCleanup, Show } from "solid-js";
import { usePanel, usePlugin } from "@opencode/plugin/gui";
import type { MountedSession } from "@opencode/plugin/gui";
import { SHARED_CSS, ScrollNav, createScrollNav, EmptyState, ErrorBanner, LoadingRow, StatusChip, type ChipTone } from "opencode-shared/gui";
import { PlansRpc } from "./contract";
import type { Plan, PlanStatus, PlanStep, StepStatus } from "./contract";
import { useT } from "./i18n";
import { bodyWithoutSteps } from "../plan-body";
import { VIEW_INITIAL, ViewState } from "./state";
import type { ScopeFilter, StatusFilter } from "./state";

const CSS = `
.plans {
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
.plans.is-detail { overflow: hidden; }
.plans-body { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.plans-scroll { flex: 1; min-height: 0; overflow-y: auto; padding-right: 2px; }
.plans-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.plans-title { display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 13px; }
.plans-title-text { margin: 0; font-size: 13px; font-weight: 600; }
.plans-count { font-size: 11px; color: var(--v2-text-text-muted); }
.plans-actions { display: flex; align-items: center; gap: 6px; }
.plans-filters { display: flex; flex-direction: column; gap: 8px; }
.plans-toggles { display: flex; align-items: center; gap: 4px; }
.plans-toggle {
  border: 0;
  background: transparent;
  color: var(--v2-text-text-muted);
  padding: 4px 9px;
  border-radius: 6px;
  font-size: 11.5px;
  cursor: pointer;
}
.plans-toggle:hover { color: var(--v2-text-text-base); background: var(--v2-overlay-simple-overlay-hover); }
.plans-toggle.is-active {
  color: var(--v2-text-text-base);
  background: var(--v2-overlay-simple-overlay-pressed);
  font-weight: 600;
}
.plans-toggle:focus-visible { outline: 2px solid var(--v2-border-border-focus); outline-offset: 0; }
.plan-card {
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: 100%;
  box-sizing: border-box;
  text-align: left;
  padding: 9px 10px;
  border-radius: 8px;
  border: 1px solid var(--v2-border-border-muted);
  background: var(--v2-background-bg-layer-02);
  color: var(--v2-text-text-base);
  cursor: pointer;
}
.plan-card:hover {
  border-color: var(--v2-border-border-strong);
  background-image: linear-gradient(var(--v2-overlay-simple-overlay-hover), var(--v2-overlay-simple-overlay-hover));
}
.plan-card:focus-visible { outline: 2px solid var(--v2-border-border-focus); outline-offset: 0; }
.plan-card-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.plan-run-card {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
}
.plan-run-card.is-play { color: var(--v2-state-fg-success); }
.plan-run-card.is-play:hover { color: var(--v2-state-fg-success); }
.plan-run-card.is-pause { color: var(--v2-state-fg-warning); }
.plan-run-card.is-pause:hover { color: var(--v2-state-fg-warning); }
.plan-run-card:hover { background: var(--v2-overlay-simple-overlay-hover); }
.plan-run-card:focus-visible { outline: 2px solid var(--v2-border-border-focus); outline-offset: 0; }
.plan-run-card:disabled { opacity: .6; cursor: default; }
.plan-run-icon { width: 26px !important; height: 26px !important; }
.plan-run-card.is-play .plan-run-icon { transform: rotate(-90deg); }
.plan-pause-icon { display: inline-flex; align-items: center; gap: 3px; }
.plan-pause-icon-inline { margin-right: 5px; }
.plan-pause-icon::before, .plan-pause-icon::after {
  content: "";
  display: block;
  width: 4px;
  height: 12px;
  border-radius: 1px;
  background: currentColor;
}
.plan-run-play { color: var(--v2-state-fg-success); }
.plan-run-play:hover { color: var(--v2-state-fg-success); }
.plan-run-play svg { transform: rotate(-90deg); }
.plan-run-pause { color: var(--v2-state-fg-warning); }
.plan-run-pause:hover { color: var(--v2-state-fg-warning); }
.plan-updated { font-size: 10.5px; color: var(--v2-text-text-faint); }
.plan-card-title { font-weight: 600; font-size: 13px; line-height: 1.3; overflow-wrap: anywhere; }
.plan-card-session { font-size: 10.5px; color: var(--v2-text-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plan-progress-row { display: flex; align-items: center; gap: 8px; }
.plan-progress { display: flex; flex: 1; height: 5px; border-radius: 999px; overflow: hidden; background: var(--v2-overlay-simple-overlay-pressed); }
.plan-progress-done { height: 100%; background: var(--v2-state-fg-success); transition: width .2s ease; }
.plan-progress-doing { height: 100%; background: var(--v2-state-fg-info); transition: width .2s ease; }
.plan-progress-label { font-size: 10.5px; color: var(--v2-text-text-muted); white-space: nowrap; }
.plan-detail { display: flex; flex-direction: column; gap: 8px; flex: 1; min-height: 0; }
.plan-detail > .plan-back,
.plan-detail > .plan-detail-head,
.plan-detail > .plan-meta,
.plan-detail > .plan-progress-row,
.plan-detail > .plan-actions { flex: none; }
.plan-back {
  align-self: flex-start;
  border: 0;
  background: transparent;
  color: var(--v2-text-text-muted);
  cursor: pointer;
  padding: 2px 0;
  font-size: 11.5px;
}
.plan-back:hover { color: var(--v2-text-text-base); }
.plan-detail-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.plan-detail-title { font-weight: 600; font-size: 14px; line-height: 1.3; overflow-wrap: anywhere; }
.plan-meta { display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--v2-text-text-muted); overflow-wrap: anywhere; }
.plan-meta-id { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; min-width: 0; }
.plan-id {
  font-family: var(--font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 10.5px;
  color: var(--v2-text-text-base);
  overflow-wrap: anywhere;
  user-select: text;
}
.plan-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.plan-actions-end { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-left: auto; }
.plan-section-title { font-weight: 600; font-size: 12px; color: var(--v2-text-text-base); margin-top: 4px; }
.plan-muted { color: var(--v2-text-text-muted); font-size: 11.5px; }
.plan-steps { display: flex; flex-direction: column; gap: 5px; }
.plan-step { display: flex; align-items: flex-start; gap: 6px; line-height: 1.45; }
.plan-step-states { display: inline-flex; gap: 2px; flex: none; }
.plan-step-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--v2-text-text-faint, var(--v2-text-text-muted));
  cursor: pointer;
}
.plan-step-btn:hover { background: var(--v2-overlay-simple-overlay-hover); color: var(--v2-text-text-base); }
.plan-step-btn:focus-visible { outline: 2px solid var(--v2-border-border-focus); outline-offset: 0; }
.plan-step-btn:disabled { opacity: .6; cursor: default; }
.plan-step-btn.is-active.is-todo {
  color: var(--v2-text-text-base);
  border-color: var(--v2-overlay-simple-overlay-pressed);
  background: transparent;
}
.plan-step-btn.is-active.is-doing { color: var(--v2-state-fg-info); border-color: var(--v2-state-border-info); background: var(--v2-state-bg-info); }
.plan-step-btn.is-active.is-done { color: var(--v2-state-fg-success); border-color: var(--v2-state-border-success); background: var(--v2-state-bg-success); }
.plan-step-glyph { display: block; }
.plan-step-glyph.glyph-todo { width: 7px; height: 7px; border-radius: 1.5px; background: currentColor; }
.plan-step-glyph.glyph-doing {
  width: 0;
  height: 0;
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  border-left: 6px solid currentColor;
  margin-left: 1px;
}
.plan-step-glyph.glyph-done {
  width: 5px;
  height: 9px;
  margin-top: -2px;
  border-right: 1.6px solid currentColor;
  border-bottom: 1.6px solid currentColor;
  transform: rotate(45deg);
}
.plan-step-text {
  display: block;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.plan-step-done { text-decoration: line-through; color: var(--v2-text-text-muted); }
.plan-step-doing { color: var(--v2-state-fg-info); font-weight: 600; }
.plan-body {
  font-size: 12px;
  line-height: 1.5;
  padding-bottom: 12px;
  overflow-wrap: anywhere;
}
.plan-body-pane {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.plan-body-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 2px;
}
.plan-steps-pane {
  display: flex;
  flex-direction: column;
  flex: none;
  min-height: 120px;
  max-height: min(480px, 60vh);
  overflow: hidden;
}
.plan-steps-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 2px;
}
.plan-splitter {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 8px;
  border-radius: 4px;
  cursor: row-resize;
  touch-action: none;
}
.plan-splitter:hover { background: var(--v2-overlay-simple-overlay-hover); }
.plan-splitter:focus-visible { outline: 2px solid var(--v2-border-border-focus); outline-offset: 0; }
.plan-splitter-grip { width: 42px; height: 3px; border-radius: 2px; background: var(--v2-border-border-strong); }
.plan-editor-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: var(--v2-overlay-simple-overlay-scrim);
}
.plan-editor {
  width: min(560px, 100%);
  max-height: 86vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border-radius: 8px;
  border: 1px solid var(--v2-border-border-strong);
  background: var(--v2-background-bg-layer-02);
  color: var(--v2-text-text-base);
  box-shadow: var(--v2-elevation-floating);
}
.plan-editor-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.plan-editor-heading { font-weight: 600; font-size: 13px; }
.plan-editor-close {
  border: 0;
  background: transparent;
  color: var(--v2-text-text-muted);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
}
.plan-editor-close:hover { color: var(--v2-text-text-base); background: var(--v2-overlay-simple-overlay-hover); }
.plan-editor-field { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--v2-text-text-muted); }
.plan-editor-field input,
.plan-editor-field textarea,
.plan-editor-step input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--v2-border-border-muted);
  border-radius: 6px;
  background: var(--v2-background-bg-layer-01, transparent);
  color: var(--v2-text-text-base);
  padding: 6px 8px;
  font: inherit;
  font-size: 12px;
}
.plan-editor-field textarea { min-height: 160px; resize: vertical; }
.plan-editor-field input:focus,
.plan-editor-field textarea:focus,
.plan-editor-step input:focus { outline: 2px solid var(--v2-border-border-focus); outline-offset: 0; }
.plan-editor-steps-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11px; color: var(--v2-text-text-muted); }
.plan-editor-steps { display: flex; flex-direction: column; gap: 5px; }
.plan-editor-step { display: flex; align-items: center; gap: 3px; }
.plan-editor-step input { flex: 1; }
.plan-editor-step .plan-step-btn { width: 24px; height: 24px; font-size: 12px; }
.plan-editor-error { color: var(--v2-state-fg-danger); font-size: 11.5px; white-space: pre-wrap; }
.plan-editor-hint { color: var(--v2-text-text-faint, var(--v2-text-text-muted)); font-size: 10.5px; line-height: 1.35; }
.plan-editor-actions { display: flex; justify-content: flex-end; gap: 6px; }
`;

const STEP_STATUSES: readonly StepStatus[] = ["todo", "doing", "done"];
const CHUNK_SIZE = 20;

export function PlansView(props: { session: MountedSession }) {
  const ctx = usePlugin();
  const panel = usePanel();
  const t = useT();

  // The server context has no locale; keep it in sync so /save-plan messages
  // follow the interface language (EN-US is the fallback).
  createEffect(() => {
    const session = props.session;
    void session.server.client
      .rpc(PlansRpc)
      .setLocale(ctx.locale.locale(), { location: { directory: session.directory } })
      .catch(() => undefined);
  });

  const viewStore = createMemo(() => {
    const session = props.session;
    return ctx.storage.store(`view:${session.server.id}:${session.id}`, {
      schema: ViewState,
      initial: VIEW_INITIAL,
    });
  });
  const saved = viewStore().value;
  const [plans, setPlans] = createSignal<Plan[]>([]);
  const [query, setQuery] = createSignal(saved?.query ?? "");
  const [selectedID, setSelectedID] = createSignal<string | null>(saved?.selectedID ?? null);
  const [detail, setDetail] = createSignal<Plan | null>(null);
  const [statusFilter, setStatusFilter] = createSignal<StatusFilter>(saved?.status ?? "active");
  const [scopeFilter, setScopeFilter] = createSignal<ScopeFilter>(saved?.scope ?? "session");
  const [executingPlanID, setExecutingPlanID] = createSignal<string | null>(
    saved?.executingPlanID ?? null,
  );
  const [pendingPlanID, setPendingPlanID] = createSignal<string | null>(null);
  const [stepsHeight, setStepsHeight] = createSignal(saved?.stepsHeight ?? 240);
  const [visible, setVisible] = createSignal(CHUNK_SIZE);
  const [loading, setLoading] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const [hydrated, setHydrated] = createSignal(saved !== undefined);
  const [editorOpen, setEditorOpen] = createSignal(false);
  const [editorID, setEditorID] = createSignal<string | null>(null);
  const [editorTitle, setEditorTitle] = createSignal("");
  const [editorBody, setEditorBody] = createSignal("");
  const [editorSteps, setEditorSteps] = createSignal<string[]>([]);
  const [editorError, setEditorError] = createSignal("");

  const selectedPlan = createMemo(() => (selectedID() ? detail() : null));

  const filteredPlans = createMemo(() => {
    const q = query().trim().toLowerCase();
    if (!q) return plans();
    return plans().filter((plan) => {
      const haystack = [plan.title, plan.body, ...plan.steps.map((step) => step.text)].join("\n").toLowerCase();
      return haystack.includes(q);
    });
  });

  const visiblePlans = createMemo(() => filteredPlans().slice(0, visible()));
  const nav = createScrollNav({
    hasMore: () => visible() < filteredPlans().length,
    loadingMore: () => false,
    loadMore: () => setVisible((value) => value + CHUNK_SIZE),
    visible: () => panel.visible(),
    items: () => filteredPlans().length,
  });
  // A new query or filter starts from the top of the list.
  createEffect(() => {
    query();
    statusFilter();
    scopeFilter();
    setVisible(CHUNK_SIZE);
    nav.reset();
  });

  const currentSession = () => props.session;

  const statusTone = (status: PlanStatus): ChipTone =>
    status === "active"
      ? "info"
      : status === "done"
        ? "success"
        : status === "archived"
          ? "warning"
          : "neutral";

  const sessionRunning = (): boolean => {
    const session = currentSession();
    return session ? session.server.data.session.status(session.id) === "running" : false;
  };

  const isExecuting = (plan: Plan): boolean =>
    executingPlanID() === plan.id || pendingPlanID() === plan.id;

  const runDisabled = (plan: Plan): boolean =>
    saving() ||
    (!isExecuting(plan) &&
      (plan.steps.length === 0 || sessionRunning() || pendingPlanID() !== null));

  const stepsMax = (): number => Math.min(480, Math.round(window.innerHeight * 0.6));
  const clampSteps = (value: number): number => Math.min(stepsMax(), Math.max(120, value));

  const startResize = (event: PointerEvent) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = stepsHeight();
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    const onMove = (move: PointerEvent) => {
      setStepsHeight(clampSteps(startHeight + (startY - move.clientY)));
    };
    const onUp = () => {
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onSplitterKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const delta = event.key === "ArrowUp" ? 16 : -16;
    setStepsHeight(clampSteps(stepsHeight() + delta));
  };

  const basename = (path: string): string => path.split("/").pop() || path;

  const shortSession = (id: string): string => (id.length > 14 ? `${id.slice(0, 14)}…` : id);

  const canMove = (plan: Plan): boolean => {
    const id = currentSession()?.id;
    return !!id && id !== plan.sessionID;
  };

  const activeProjectName = (): string => {
    const project = currentSession()?.project;
    return project?.name || (project?.worktree ? basename(project.worktree) : "");
  };

  const formatDate = (iso: string): string => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
  };

  const projectLabel = (plan: Plan): string => activeProjectName() || basename(plan.projectDirectory);

  const progress = (plan: Plan): { done: number; doing: number; total: number } => ({
    done: plan.steps.filter((step) => step.status === "done").length,
    doing: plan.steps.filter((step) => step.status === "doing").length,
    total: plan.steps.length,
  });

  const percent = (count: number, total: number): number =>
    total === 0 ? 0 : Math.round((count / total) * 100);

  const donePercent = (plan: Plan): number => percent(progress(plan).done, progress(plan).total);
  const doingPercent = (plan: Plan): number => percent(progress(plan).doing, progress(plan).total);

  const progressLabel = (plan: Plan): string => {
    const { done, doing, total } = progress(plan);
    return doing > 0
      ? `${t("progress", done, total)} · ${t("progress.doing", doing)}`
      : t("progress", done, total);
  };

  const statusClass = (status: PlanStatus): string => `status-${status}`;

  const sameJSON = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

  let loadGen = 0;
  let loadController: AbortController | undefined;
  const load = async (silent = false) => {
    const gen = ++loadGen;
    setError("");

    const session = currentSession();
    if (!session) {
      setPlans([]);
      setSelectedID(null);
      setDetail(null);
      setLoading(false);
      return;
    }

    loadController?.abort();
    const controller = new AbortController();
    loadController = controller;
    if (!silent) setLoading(true);

    try {
      const rpc = session.server.client.rpc(PlansRpc);
      const options = { location: { directory: session.directory }, signal: controller.signal };
      const list = await rpc.list(
        {
          scope: scopeFilter(),
          sessionID: session.id,
          status: statusFilter(),
          limit: 200,
        },
        options,
      );
      if (gen !== loadGen) return;
      if (!sameJSON(plans(), list)) setPlans([...list]);

      const id = selectedID();
      if (id) {
        const found = list.find((plan) => plan.id === id) ?? (await rpc.get(id, options));
        if (gen !== loadGen) return;
        const next = found ?? null;
        if (!sameJSON(detail(), next)) setDetail(next);
        if (!found) setSelectedID(null);
      }
    } catch (cause) {
      if (gen === loadGen && !controller.signal.aborted) setError(String(cause));
    } finally {
      if (gen === loadGen) setLoading(false);
    }
  };

  onCleanup(() => loadController?.abort());

  // Restore the panel state (open plan, search and filters) from the session
  // store. The store loads before the panel's regions render, but fall back to
  // hydrating once it arrives.
  let filterKey: string | undefined;
  createEffect(() => {
    if (hydrated()) return;
    const value = viewStore().value;
    if (!value) return;
    setHydrated(true);
    filterKey = `${value.scope}\u0000${value.status}`;
    setQuery(value.query);
    setStatusFilter(value.status);
    setScopeFilter(value.scope);
    setSelectedID(value.selectedID);
    setStepsHeight(value.stepsHeight ?? 240);
    setExecutingPlanID(value.executingPlanID ?? null);
    setPendingPlanID(null);
    void load();
  });

  // Mirror every UI change into the session store. Writes wait for the store
  // to load, so skip them until the value above is hydrated.
  createEffect(() => {
    if (!hydrated()) return;
    viewStore().set({
      selectedID: selectedID(),
      query: query(),
      status: statusFilter(),
      scope: scopeFilter(),
      stepsHeight: stepsHeight(),
      executingPlanID: executingPlanID(),
    });
  });

  // Only reset the detail when the filter actually changes. Session updates (a
  // step toggle, a notification) must not collapse an expanded plan, and the
  // first run must keep the restored selection.
  createEffect(() => {
    const key = `${scopeFilter()}\u0000${statusFilter()}`;
    if (filterKey === undefined) {
      filterKey = key;
      void load();
      return;
    }
    if (key === filterKey) return;
    filterKey = key;
    setVisible(CHUNK_SIZE);
    setSelectedID(null);
    setDetail(null);
    void load();
  });

  // The agent writes to the DB from the server process; refresh when the
  // session changes, and on a slow poll while the panel stays open.
  createEffect(() => {
    ctx.sessions.list();
    void load(true);
  });

  // Track the execution lifecycle from the session's busy state. `pending`
  // covers the gap between sending the prompt and the session turning
  // "running"; once it goes idle again, the Execute button comes back.
  createEffect(() => {
    const session = currentSession();
    if (!session) return;
    const running = session.server.data.session.status(session.id) === "running";
    const pending = pendingPlanID();
    if (running) {
      if (pending) {
        setExecutingPlanID(pending);
        setPendingPlanID(null);
      }
      return;
    }
    if (!pending && executingPlanID()) setExecutingPlanID(null);
  });

  const timer = setInterval(() => {
    if (!loading()) void load(true);
  }, 3000);
  onCleanup(() => clearInterval(timer));

  const select = (plan: Plan) => {
    setSelectedID(plan.id);
    setDetail(plan);
  };

  const back = () => {
    setSelectedID(null);
    setDetail(null);
  };

  const showError = (title: string, cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    setError(message);
    ctx.toast.show({ title, description: message, variant: "error" });
  };

  const copyID = async (id: string) => {
    try {
      await ctx.system.copy(id);
      ctx.toast.show({ title: t("toast.idCopied"), variant: "success" });
    } catch (cause) {
      showError(t("toast.copyError"), cause);
    }
  };

  const bodyFromPlan = (plan: Plan): string =>
    bodyWithoutSteps(plan.body)
      .replace(/^#\s+.*(?:\r?\n)+/, "")
      .trim();

  const openNewPlan = () => {
    setEditorID(null);
    setEditorTitle("");
    setEditorBody("");
    setEditorSteps([""]);
    setEditorError("");
    setEditorOpen(true);
  };

  const openEditPlan = (plan: Plan) => {
    setEditorID(plan.id);
    setEditorTitle(plan.title);
    setEditorBody(bodyFromPlan(plan));
    setEditorSteps(plan.steps.length > 0 ? plan.steps.map((step) => step.text) : [""]);
    setEditorError("");
    setEditorOpen(true);
  };

  const closeEditor = () => {
    if (saving()) return;
    setEditorOpen(false);
    setEditorError("");
  };

  const updateEditorStep = (index: number, value: string) => {
    const next = [...editorSteps()];
    next[index] = value;
    setEditorSteps(next);
  };

  const addEditorStep = () => setEditorSteps([...editorSteps(), ""]);

  const removeEditorStep = (index: number) => {
    const next = editorSteps().filter((_, cursor) => cursor !== index);
    setEditorSteps(next.length > 0 ? next : [""]);
  };

  const moveEditorStep = (index: number, delta: number) => {
    const next = [...editorSteps()];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item ?? "");
    setEditorSteps(next);
  };

  const saveEditor = async () => {
    const session = currentSession();
    if (!session) {
      ctx.toast.show({ title: t("toast.noSession"), variant: "error" });
      return;
    }
    const title = editorTitle().trim();
    const steps = editorSteps().map((step) => step.trim()).filter(Boolean);
    if (!title) {
      setEditorError(t("editor.titleRequired"));
      return;
    }
    if (steps.length === 0) {
      setEditorError(t("editor.stepsRequired"));
      return;
    }
    const context = editorBody().trim();
    const parts = [`# ${title}`];
    if (context) parts.push("", context);
    parts.push("", "## Passos", "", ...steps.map((step) => `- [ ] ${step}`));
    const body = parts.join("\n");
    const editing = Boolean(editorID());
    setSaving(true);
    setEditorError("");
    try {
      const rpc = session.server.client.rpc(PlansRpc);
      const result = await rpc.save(
        {
          id: editorID() ?? undefined,
          title,
          body,
          steps,
          sessionID: session.id,
          locale: ctx.locale.locale(),
        },
        { location: { directory: session.directory } },
      );
      if (!result.ok) throw new Error(result.error ?? t("toast.createError"));
      if (result.plan) {
        setSelectedID(result.plan.id);
        setDetail(result.plan);
      }
      setEditorOpen(false);
      await load();
      ctx.toast.show({
        title: editing ? t("toast.updated") : t("toast.created"),
        variant: "success",
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setEditorError(message);
      showError(editing ? t("toast.updateError") : t("toast.createError"), cause);
    } finally {
      setSaving(false);
    }
  };

  const setStepStatus = async (step: PlanStep, status: StepStatus) => {
    const id = selectedID();
    const session = currentSession();
    if (!id || !session) return;
    setSaving(true);
    try {
      const rpc = session.server.client.rpc(PlansRpc);
      const result = await rpc.setStep(
        { id, stepID: step.id, status, sessionID: session.id, locale: ctx.locale.locale() },
        { location: { directory: session.directory } },
      );
      if (!result.ok) throw new Error(result.error ?? t("toast.updateError"));
      if (result.plan) setDetail(result.plan);
      await load(true);
    } catch (cause) {
      showError(t("toast.updateError"), cause);
    } finally {
      setSaving(false);
    }
  };

  const executePlan = async (plan: Plan) => {
    const session = currentSession();
    if (!session) return;
    setSaving(true);
    try {
      let target = plan;
      if (plan.sessionID !== session.id) {
        const rpc = session.server.client.rpc(PlansRpc);
        const moved = await rpc.move(
          { id: plan.id, sessionID: session.id, locale: ctx.locale.locale() },
          { location: { directory: session.directory } },
        );
        if (!moved.ok) throw new Error(moved.error ?? t("toast.moveError"));
        if (moved.plan) {
          target = moved.plan;
          setDetail(moved.plan);
        }
        await load(true);
      }

      await session.server.client.session.switchAgent({
        sessionID: session.id,
        agent: "build",
      });
      // No `delivery`: the default is steer, so this is a normal user message
      // and starts the turn immediately. `delivery: "queue"` would park it
      // until the current turn ends, leaving the panel stuck in "executing".
      await session.server.client.session.prompt({
        sessionID: session.id,
        text: t("execute.prompt", target.title, target.id),
      });
      setExecutingPlanID(target.id);
      setPendingPlanID(target.id);
      ctx.toast.show({ title: t("toast.executing"), variant: "success" });
    } catch (cause) {
      setExecutingPlanID(null);
      setPendingPlanID(null);
      showError(t("toast.executeError"), cause);
    } finally {
      setSaving(false);
    }
  };

  const pausePlan = async (plan: Plan) => {
    const session = currentSession();
    if (!session) return;
    setSaving(true);
    try {
      const result = await session.server.client.session.interrupt({ sessionID: session.id });
      // Tell the next turn why the run paused, not just that the mode changed.
      try {
        await session.server.client.session.synthetic({
          sessionID: session.id,
          text: t("pause.synthetic", plan.title, plan.id),
          description: t("pause.action", plan.title),
          resume: false,
          metadata: { source: "plans", planID: plan.id, kind: "paused" },
        });
      } catch (error) {
        console.warn("[plans] could not record the pause message", error);
      }
      await session.server.client.session.switchAgent({
        sessionID: session.id,
        agent: "plan",
      });
      if (!result.interrupted) {
        setExecutingPlanID(null);
        setPendingPlanID(null);
      }
      ctx.toast.show({ title: t("toast.pausing"), variant: "success" });
    } catch (cause) {
      showError(t("toast.pauseError"), cause);
    } finally {
      setSaving(false);
    }
  };

  const toggleRun = async (plan: Plan) => {
    if (isExecuting(plan)) {
      await pausePlan(plan);
      return;
    }
    if (sessionRunning() || pendingPlanID() !== null) {
      ctx.toast.show({ title: t("toast.busy"), variant: "error" });
      return;
    }
    await executePlan(plan);
  };

  const changeStatus = async (status: PlanStatus) => {
    const id = selectedID();
    const session = currentSession();
    if (!id || !session) return;
    setSaving(true);
    try {
      const rpc = session.server.client.rpc(PlansRpc);
      const result = await rpc.update(
        { id, status, sessionID: session.id, locale: ctx.locale.locale() },
        { location: { directory: session.directory } },
      );
      if (!result.ok) throw new Error(result.error ?? t("toast.updateError"));
      if (result.plan) setDetail(result.plan);
      await load();
      ctx.toast.show({ title: t("toast.updated"), variant: "success" });
    } catch (cause) {
      showError(t("toast.updateError"), cause);
    } finally {
      setSaving(false);
    }
  };

  const removeCurrent = async () => {
    const id = selectedID();
    const session = currentSession();
    if (!id || !session) return;
    const ok = await ctx.dialogs.confirm({
      title: t("confirm.remove.title"),
      description: t("confirm.remove.desc"),
      confirm: t("confirm.remove.confirm"),
      danger: true,
    });
    if (!ok) return;
    setSaving(true);
    try {
      const rpc = session.server.client.rpc(PlansRpc);
      const result = await rpc.remove(
        { id, sessionID: session.id, locale: ctx.locale.locale() },
        { location: { directory: session.directory } },
      );
      if (!result.ok) throw new Error(result.error ?? t("toast.removeError"));
      setSelectedID(null);
      setDetail(null);
      await load();
      ctx.toast.show({ title: t("toast.removed"), variant: "success" });
    } catch (cause) {
      showError(t("toast.removeError"), cause);
    } finally {
      setSaving(false);
    }
  };

  const moveCurrent = async () => {
    const id = selectedID();
    const session = currentSession();
    if (!id || !session) return;
    setSaving(true);
    try {
      const rpc = session.server.client.rpc(PlansRpc);
      const result = await rpc.move(
        { id, sessionID: session.id, locale: ctx.locale.locale() },
        { location: { directory: session.directory } },
      );
      if (!result.ok) throw new Error(result.error ?? t("toast.moveError"));
      if (result.plan) setDetail(result.plan);
      await load(true);
      ctx.toast.show({ title: t("toast.moved"), variant: "success" });
    } catch (cause) {
      showError(t("toast.moveError"), cause);
    } finally {
      setSaving(false);
    }
  };

  const saveLast = async () => {
    const session = currentSession();
    if (!session) {
      ctx.toast.show({ title: t("toast.noSession"), variant: "error" });
      return;
    }
    setSaving(true);
    try {
      // This is a nudge, not a capture: the agent must call plans.save with
      // its own context, so a regular message is never persisted as a plan.
      await session.server.client.session.prompt({
        sessionID: session.id,
        text: t("saveLast.prompt"),
      });
      ctx.toast.show({ title: t("toast.saveHint"), variant: "success" });
    } catch (cause) {
      showError(t("toast.saveError"), cause);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="plans" classList={{ "is-detail": Boolean(selectedID()) }}>
      <style>{CSS}</style>
      <style>{SHARED_CSS}</style>

      <Show when={!selectedID()}>
        <div class="plans-head">
          <div class="plans-title">
            <ctx.ui.Icon name="checklist" size="small" />
            <h2 class="plans-title-text">{t("title")}</h2>
            <span class="plans-count">{filteredPlans().length}</span>
          </div>
          <div class="plans-actions">
            <ctx.ui.Button
              size="small"
              variant="contrast"
              icon="plus"
              onClick={openNewPlan}
            >
              {t("newPlan")}
            </ctx.ui.Button>
            <ctx.ui.Tooltip value={t("saveLast.tooltip")}>
              <ctx.ui.IconButton
                icon="download"
                label={t("saveLast")}
                onClick={() => void saveLast()}
              />
            </ctx.ui.Tooltip>
            <ctx.ui.IconButton
              icon="outline-rotate-clockwise"
              label={t("refresh")}
              onClick={() => void load()}
            />
          </div>
        </div>
      </Show>

      <Show when={!selectedID()}>
        <div class="plans-filters">
          <ctx.ui.TextInput
            type="search"
            label={t("search.label")}
            placeholder={t("search.placeholder")}
            value={query()}
            onInput={(value) => {
              setQuery(value);
              setVisible(CHUNK_SIZE);
            }}
          />
          <div class="plans-toggles" role="group" aria-label={t("filters.scope")}>
            <button
              type="button"
              class="plans-toggle"
              classList={{ "is-active": scopeFilter() === "session" }}
              onClick={() => setScopeFilter("session")}
            >
              {t("scope.session")}
            </button>
            <button
              type="button"
              class="plans-toggle"
              classList={{ "is-active": scopeFilter() === "project" }}
              onClick={() => setScopeFilter("project")}
            >
              {t("scope.project")}
            </button>
          </div>
          <div class="plans-toggles" role="group" aria-label={t("filters.label")}>
            <button
              type="button"
              class="plans-toggle"
              classList={{ "is-active": statusFilter() === "active" }}
              onClick={() => setStatusFilter("active")}
            >
              {t("filter.active")}
            </button>
            <button
              type="button"
              class="plans-toggle"
              classList={{ "is-active": statusFilter() === "done" }}
              onClick={() => setStatusFilter("done")}
            >
              {t("filter.done")}
            </button>
            <button
              type="button"
              class="plans-toggle"
              classList={{ "is-active": statusFilter() === "all" }}
              onClick={() => setStatusFilter("all")}
            >
              {t("filter.all")}
            </button>
          </div>
        </div>
      </Show>

      <Show when={error()}>
        <ErrorBanner message={error()} />
      </Show>

      <Show when={!selectedID()}>
        <div class="plans-body">
          <div
            class="plans-scroll os-scroll"
            ref={nav.ref}
            onKeyDown={nav.onKeyDown}
            tabIndex={nav.scrollable() ? 0 : undefined}
            role="region"
            aria-label={t("scroll.region")}
          >
            <Show when={loading() && filteredPlans().length === 0}>
              <LoadingRow label={t("loading")} />
            </Show>
            <div class="plans-list os-list">
          <Show when={!loading() && filteredPlans().length === 0}>
            <EmptyState
              icon="file-document"
              title={query().trim() ? t("empty.search") : t("empty.title")}
              hint={query().trim() ? t("empty.searchHint") : t("empty.hint")}
            />
          </Show>
          <For each={visiblePlans()}>
            {(plan) => (
              <div
                class="plan-card"
                role="button"
                tabIndex={0}
                onClick={() => select(plan)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    select(plan);
                  }
                }}
              >
                <div class="plan-card-top">
                  <StatusChip tone={statusTone(plan.status)} label={t(`status.${plan.status}`)} />
                  <span class="plan-updated">{formatDate(plan.updatedAt)}</span>
                </div>
                <div class="plan-card-title">{plan.title}</div>
                <Show when={scopeFilter() === "project"}>
                  <div class="plan-card-session">
                    {t("session")}: {shortSession(plan.sessionID)}
                  </div>
                </Show>
                <div class="plan-progress-row">
                  <Show when={plan.status === "active"}>
                    <ctx.ui.Tooltip value={isExecuting(plan) ? t("pause") : t("execute")}>
                      <button
                        type="button"
                        class={isExecuting(plan) ? "plan-run-card is-pause" : "plan-run-card is-play"}
                        aria-label={isExecuting(plan) ? t("pause") : t("execute")}
                        aria-pressed={isExecuting(plan)}
                        disabled={runDisabled(plan)}
                        onClick={(event) => {
                          event.stopPropagation();
                          void toggleRun(plan);
                        }}
                      >
                        <Show
                          when={isExecuting(plan)}
                          fallback={
                            <ctx.ui.Icon
                              name="fill-triangle-down"
                              size="large"
                              class="plan-run-icon"
                            />
                          }
                        >
                          <span class="plan-pause-icon" />
                        </Show>
                      </button>
                    </ctx.ui.Tooltip>
                  </Show>
                  <div class="plan-progress">
                    <div class="plan-progress-done" style={{ width: `${donePercent(plan)}%` }} />
                    <div class="plan-progress-doing" style={{ width: `${doingPercent(plan)}%` }} />
                  </div>
                  <span class="plan-progress-label">{progressLabel(plan)}</span>
                </div>
              </div>
            )}
          </For>
            </div>
          </div>
          <ScrollNav nav={nav} topLabel={t("scroll.top")} bottomLabel={t("scroll.bottom")} />
        </div>
      </Show>

      <Show when={selectedID()}>
        <Show
          when={selectedPlan()}
          fallback={<LoadingRow label={t("loading")} />}
        >
          {(plan) => (
            <div class="plan-detail">
            <button type="button" class="plan-back" onClick={back}>
              ← {t("back")}
            </button>

            <div class="plan-detail-head">
              <div class="plan-detail-title">{plan().title}</div>
              <StatusChip tone={statusTone(plan().status)} label={t(`status.${plan().status}`)} />
            </div>

            <div class="plan-meta">
              <div class="plan-meta-id">
                <span>{t("id")}:</span>
                <code class="plan-id">{plan().id}</code>
                <ctx.ui.IconButton
                  icon="copy"
                  label={t("copyID")}
                  onClick={() => void copyID(plan().id)}
                />
              </div>
              <div>
                {t("project")}: {projectLabel(plan())}
              </div>
              <div>
                {t("created")}: {formatDate(plan().createdAt)}
              </div>
              <div>
                {t("updated")}: {formatDate(plan().updatedAt)}
              </div>
              <Show when={plan().completedAt}>
                <div>
                  {t("completed")}: {formatDate(plan().completedAt!)}
                </div>
              </Show>
              <div>
                {t("session")}: {plan().sessionID}
              </div>
            </div>

            <div class="plan-progress-row">
              <div class="plan-progress">
                <div class="plan-progress-done" style={{ width: `${donePercent(plan())}%` }} />
                <div class="plan-progress-doing" style={{ width: `${doingPercent(plan())}%` }} />
              </div>
              <span class="plan-progress-label">{progressLabel(plan())}</span>
            </div>

            <div class="plan-actions">
              <Show when={plan().status === "active"}>
                <ctx.ui.Button
                  size="small"
                  variant="ghost"
                  class={isExecuting(plan()) ? "plan-run-pause" : "plan-run-play"}
                  icon={isExecuting(plan()) ? undefined : "fill-triangle-down"}
                  disabled={runDisabled(plan())}
                  onClick={() => void toggleRun(plan())}
                >
                  <Show when={isExecuting(plan())}>
                    <span class="plan-pause-icon plan-pause-icon-inline" />
                  </Show>
                  {isExecuting(plan()) ? t("pause") : t("execute")}
                </ctx.ui.Button>
              </Show>
              <Show when={plan().status === "active"}>
                <ctx.ui.Button
                  size="small"
                  variant="contrast"
                  icon="circle-check"
                  busy={saving()}
                  onClick={() => void changeStatus("done")}
                >
                  {t("markDone")}
                </ctx.ui.Button>
                <ctx.ui.Button
                  size="small"
                  variant="ghost"
                  icon="outline-hexagonal-warning"
                  disabled={saving()}
                  onClick={() => void changeStatus("archived")}
                >
                  {t("archive")}
                </ctx.ui.Button>
              </Show>
              <Show when={plan().status !== "active"}>
                <ctx.ui.Button
                  size="small"
                  variant="ghost"
                  icon="arrow-undo-down"
                  disabled={saving()}
                  onClick={() => void changeStatus("active")}
                >
                  {t("reopen")}
                </ctx.ui.Button>
              </Show>
              <Show when={canMove(plan())}>
                <ctx.ui.Button
                  size="small"
                  variant="ghost"
                  disabled={saving()}
                  onClick={() => void moveCurrent()}
                >
                  {t("moveToSession")}
                </ctx.ui.Button>
              </Show>
              <div class="plan-actions-end">
                <ctx.ui.Button
                  size="small"
                  variant="ghost"
                  icon="edit"
                  onClick={() => openEditPlan(plan())}
                >
                  {t("editPlan")}
                </ctx.ui.Button>
                <ctx.ui.Button
                  size="small"
                  variant="ghost-muted"
                  icon="trash"
                  disabled={saving()}
                  onClick={() => void removeCurrent()}
                >
                  {t("remove")}
                </ctx.ui.Button>
              </div>
            </div>

            <div class="plan-body-pane">
              <Show when={bodyWithoutSteps(plan().body)}>
                {(body) => (
                  <>
                    <div class="plan-section-title">{t("plan")}</div>
                    <div class="plan-body-scroll">
                      <ctx.ui.Markdown text={body()} class="plan-body" />
                    </div>
                  </>
                )}
              </Show>
            </div>

            <div
              class="plan-splitter"
              role="separator"
              aria-orientation="horizontal"
              aria-label={t("resizeSteps")}
              tabIndex={0}
              onPointerDown={startResize}
              onKeyDown={onSplitterKeyDown}
            >
              <span class="plan-splitter-grip" />
            </div>

            <div class="plan-steps-pane" style={{ height: `${stepsHeight()}px` }}>
              <div class="plan-section-title">{t("steps")}</div>
              <div class="plan-steps-scroll">
                <Show when={plan().steps.length === 0}>
                  <div class="plan-muted">{t("noSteps")}</div>
                </Show>
                <div class="plan-steps">
                  <For each={plan().steps}>
                    {(step) => (
                      <div class="plan-step">
                        <div class="plan-step-states" role="group" aria-label={t("step.state")}>
                          <For each={STEP_STATUSES}>
                            {(value) => (
                              <button
                                type="button"
                                class={`plan-step-btn is-${value}`}
                                classList={{ "is-active": step.status === value }}
                                aria-pressed={step.status === value}
                                aria-label={t(`step.${value}`)}
                                title={t(`step.${value}`)}
                                disabled={saving()}
                                onClick={() => {
                                  if (value !== step.status) void setStepStatus(step, value);
                                }}
                              >
                                <span class={`plan-step-glyph glyph-${value}`} />
                              </button>
                            )}
                          </For>
                        </div>
                        <span
                          class="plan-step-text"
                          title={step.text}
                          classList={{
                            "plan-step-done": step.status === "done",
                            "plan-step-doing": step.status === "doing",
                          }}
                        >
                          {step.text}
                        </span>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </div>
          </div>
        )}
        </Show>
      </Show>

      <Show when={editorOpen()}>
        <div
          class="plan-editor-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={editorID() ? t("editPlan") : t("newPlan")}
          onClick={closeEditor}
        >
          <div class="plan-editor" onClick={(event) => event.stopPropagation()}>
            <div class="plan-editor-head">
              <div class="plan-editor-heading">{editorID() ? t("editPlan") : t("newPlan")}</div>
              <button
                type="button"
                class="plan-editor-close"
                aria-label={t("cancel")}
                title={t("cancel")}
                onClick={closeEditor}
              >
                ×
              </button>
            </div>

            <label class="plan-editor-field">
              <span>{t("titleLabel")}</span>
              <input
                value={editorTitle()}
                onInput={(event) => setEditorTitle(event.currentTarget.value)}
              />
            </label>

            <label class="plan-editor-field">
              <span>{t("bodyLabel")}</span>
              <textarea
                value={editorBody()}
                onInput={(event) => setEditorBody(event.currentTarget.value)}
              />
              <small class="plan-editor-hint">{t("bodyHint")}</small>
            </label>

            <div class="plan-editor-steps-head">
              <span>{t("stepsLabel")}</span>
              <ctx.ui.Button size="small" variant="ghost" icon="plus" onClick={addEditorStep}>
                {t("addStep")}
              </ctx.ui.Button>
            </div>

            <div class="plan-editor-steps">
              <Index each={editorSteps()}>
                {(step, index) => (
                  <div class="plan-editor-step">
                    <input
                      value={step()}
                      aria-label={`${t("stepsLabel")} ${index + 1}`}
                      onInput={(event) => updateEditorStep(index, event.currentTarget.value)}
                    />
                    <button
                      type="button"
                      class="plan-step-btn"
                      aria-label={t("moveUp")}
                      title={t("moveUp")}
                      disabled={index === 0}
                      onClick={() => moveEditorStep(index, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      class="plan-step-btn"
                      aria-label={t("moveDown")}
                      title={t("moveDown")}
                      disabled={index === editorSteps().length - 1}
                      onClick={() => moveEditorStep(index, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      class="plan-step-btn"
                      aria-label={t("removeStep")}
                      title={t("removeStep")}
                      onClick={() => removeEditorStep(index)}
                    >
                      ×
                    </button>
                  </div>
                )}
              </Index>
            </div>

            <Show when={editorError()}>
              <div class="plan-editor-error">{editorError()}</div>
            </Show>

            <div class="plan-editor-actions">
              <ctx.ui.Button size="small" variant="ghost" disabled={saving()} onClick={closeEditor}>
                {t("cancel")}
              </ctx.ui.Button>
              <ctx.ui.Button
                size="small"
                variant="contrast"
                busy={saving()}
                onClick={() => void saveEditor()}
              >
                {t("savePlan")}
              </ctx.ui.Button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
