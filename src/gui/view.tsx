/**
 * Plans side panel — SolidJS UI.
 *
 * Reads and writes plans over the server plugin's RPC (`PlansRpc`). The
 * server owns `plans.db`, so list/read/write share one schema and follow the
 * plugin's hot reload. The panel is a master/detail view: plan cards with
 * status/progress, then a detail with the checklist and the original Markdown.
 */

import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { usePlugin } from "@opencode/plugin/gui";
import type { MountedSession } from "@opencode/plugin/gui";
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
  overflow-y: auto;
  font-family: var(--font-family-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  color: var(--v2-text-text-base);
  font-size: 12.5px;
}
.plans-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.plans-title { display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 13px; }
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
.plans-error {
  padding: 8px 10px;
  border-radius: 6px;
  color: var(--v2-text-text-danger, #e03131);
  background: var(--v2-background-bg-danger, rgba(224,49,49,.08));
  border: 1px solid var(--v2-border-border-danger, rgba(224,49,49,.25));
  white-space: pre-wrap;
}
.plans-loading { display: flex; align-items: center; gap: 8px; color: var(--v2-text-text-muted); padding: 8px 2px; }
.plans-list { display: flex; flex-direction: column; gap: 8px; }
.plan-card {
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: 100%;
  text-align: left;
  padding: 9px 10px;
  border-radius: 8px;
  border: 1px solid var(--v2-border-border-muted);
  background: var(--v2-background-bg-layer-02);
  color: var(--v2-text-text-base);
  cursor: pointer;
}
.plan-card:hover { background: var(--v2-overlay-simple-overlay-hover); border-color: var(--v2-border-border-strong); }
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
.plan-run-card.is-play { color: #40c057; }
.plan-run-card.is-play:hover { color: #2f9e44; }
.plan-run-card.is-pause { color: #f59f00; }
.plan-run-card.is-pause:hover { color: #e8590c; }
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
.plan-run-play { color: #40c057; }
.plan-run-play:hover { color: #2f9e44; }
.plan-run-play svg { transform: rotate(-90deg); }
.plan-run-pause { color: #f59f00; }
.plan-run-pause:hover { color: #e8590c; }
.plan-updated { font-size: 10.5px; color: var(--v2-text-text-faint); }
.plan-card-title { font-weight: 600; font-size: 13px; line-height: 1.3; overflow-wrap: anywhere; }
.plan-card-session { font-size: 10.5px; color: var(--v2-text-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plan-status {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 600;
  white-space: nowrap;
  background: var(--v2-overlay-simple-overlay-hover);
  color: var(--v2-text-text-muted);
}
.plan-status.status-active { color: #4f8cff; background: rgba(79,140,255,.12); }
.plan-status.status-done { color: #2f9e44; background: rgba(47,158,68,.12); }
.plan-status.status-archived { color: #e8590c; background: rgba(232,89,12,.12); }
.plan-status.status-superseded { color: var(--v2-text-text-muted); background: var(--v2-overlay-simple-overlay-pressed); }
.plan-progress-row { display: flex; align-items: center; gap: 8px; }
.plan-progress { display: flex; flex: 1; height: 5px; border-radius: 999px; overflow: hidden; background: var(--v2-overlay-simple-overlay-pressed); }
.plan-progress-done { height: 100%; background: #40c057; transition: width .2s ease; }
.plan-progress-doing { height: 100%; background: #4f8cff; transition: width .2s ease; }
.plan-progress-label { font-size: 10.5px; color: var(--v2-text-text-muted); white-space: nowrap; }
.plans-empty { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 6px; padding: 24px 10px; color: var(--v2-text-text-muted); }
.plans-empty-icon { color: var(--v2-text-text-faint); }
.plans-empty-title { font-weight: 600; color: var(--v2-text-text-base); }
.plans-empty-hint { font-size: 11.5px; line-height: 1.45; }
.plan-detail { display: flex; flex-direction: column; gap: 8px; }
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
.plan-section-title { font-weight: 600; font-size: 12px; color: var(--v2-text-text-base); margin-top: 4px; }
.plan-body-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.plan-body-toggle:hover { color: var(--v2-text-text-base); }
.plan-body-toggle:focus-visible { outline: 2px solid var(--v2-border-border-focus); outline-offset: 0; }
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
.plan-step-btn.is-active.is-doing { color: #4f8cff; border-color: #4f8cff; background: rgba(79,140,255,.10); }
.plan-step-btn.is-active.is-done { color: #40c057; border-color: #40c057; background: rgba(64,192,87,.16); }
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
.plan-step-doing { color: #4f8cff; font-weight: 600; }
.plan-body {
  font-size: 12px;
  line-height: 1.5;
  padding-bottom: 12px;
  overflow-wrap: anywhere;
}
`;

const STEP_STATUSES: readonly StepStatus[] = ["todo", "doing", "done"];

export function PlansView(props: { session: MountedSession }) {
  const ctx = usePlugin();
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
  const [bodyCollapsed, setBodyCollapsed] = createSignal(saved?.bodyCollapsed ?? false);
  const [executingPlanID, setExecutingPlanID] = createSignal<string | null>(
    saved?.executingPlanID ?? null,
  );
  const [pendingPlanID, setPendingPlanID] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const [hydrated, setHydrated] = createSignal(saved !== undefined);

  const selectedPlan = createMemo(() => (selectedID() ? detail() : null));

  const filteredPlans = createMemo(() => {
    const q = query().trim().toLowerCase();
    if (!q) return plans();
    return plans().filter((plan) => {
      const haystack = [plan.title, plan.body, ...plan.steps.map((step) => step.text)].join("\n").toLowerCase();
      return haystack.includes(q);
    });
  });

  const currentSession = () => props.session;

  const sessionRunning = (): boolean => {
    const session = currentSession();
    return session ? session.server.data.session.status(session.id) === "running" : false;
  };

  const isExecuting = (plan: Plan): boolean =>
    executingPlanID() === plan.id || pendingPlanID() === plan.id;

  const runDisabled = (plan: Plan): boolean =>
    saving() || (!isExecuting(plan) && (sessionRunning() || pendingPlanID() !== null));

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
    setBodyCollapsed(value.bodyCollapsed ?? false);
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
      bodyCollapsed: bodyCollapsed(),
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
      if (!result.ok) throw new Error(result.error ?? "erro ao atualizar o passo");
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
      if (!result.ok) throw new Error(result.error ?? "erro ao atualizar o plano");
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
      if (!result.ok) throw new Error(result.error ?? "erro ao remover o plano");
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
      if (!result.ok) throw new Error(result.error ?? "erro ao mover o plano");
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
    <div class="plans">
      <style>{CSS}</style>

      <Show when={!selectedID()}>
        <div class="plans-head">
          <div class="plans-title">
            <ctx.ui.Icon name="file-document" size="small" />
            <span>{t("title")}</span>
            <span class="plans-count">{filteredPlans().length}</span>
          </div>
          <div class="plans-actions">
            <ctx.ui.Tooltip value={t("saveLast.tooltip")}>
              <ctx.ui.Button size="small" variant="contrast" icon="plus" busy={saving()} onClick={() => void saveLast()}>
                {t("saveLast")}
              </ctx.ui.Button>
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
            onInput={setQuery}
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
        <div class="plans-error">{error()}</div>
      </Show>

      <Show when={!selectedID() && loading() && filteredPlans().length === 0}>
        <div class="plans-loading">
          <ctx.ui.Loader size="small" /> {t("loading")}
        </div>
      </Show>

      <Show when={!selectedID()}>
        <div class="plans-list">
          <Show when={!loading() && filteredPlans().length === 0}>
            <div class="plans-empty">
              <ctx.ui.Icon name="file-document" size="large" class="plans-empty-icon" />
              <div class="plans-empty-title">
                {query().trim() ? t("empty.search") : t("empty.title")}
              </div>
              <div class="plans-empty-hint">
                {query().trim() ? t("empty.searchHint") : t("empty.hint")}
              </div>
            </div>
          </Show>
          <For each={filteredPlans()}>
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
                  <span class={`plan-status ${statusClass(plan.status)}`}>{t(`status.${plan.status}`)}</span>
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
      </Show>

      <Show when={selectedID()}>
        <Show
          when={selectedPlan()}
          fallback={
            <div class="plans-loading">
              <ctx.ui.Loader size="small" /> {t("loading")}
            </div>
          }
        >
          {(plan) => (
            <div class="plan-detail">
            <button type="button" class="plan-back" onClick={back}>
              ← {t("back")}
            </button>

            <div class="plan-detail-head">
              <div class="plan-detail-title">{plan().title}</div>
              <span class={`plan-status ${statusClass(plan().status)}`}>{t(`status.${plan().status}`)}</span>
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

            <div class="plan-section-title">{t("steps")}</div>
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

            <Show when={bodyWithoutSteps(plan().body)}>
              {(body) => (
                <>
                  <button
                    type="button"
                    class="plan-section-title plan-body-toggle"
                    aria-expanded={!bodyCollapsed()}
                    onClick={() => setBodyCollapsed(!bodyCollapsed())}
                  >
                    <ctx.ui.Icon
                      name={bodyCollapsed() ? "chevron-right" : "chevron-down"}
                      size="small"
                    />
                    <span>{t("plan")}</span>
                  </button>
                  <Show when={!bodyCollapsed()}>
                    <ctx.ui.Markdown text={body()} class="plan-body" />
                  </Show>
                </>
              )}
            </Show>
          </div>
        )}
        </Show>
      </Show>
    </div>
  );
}
