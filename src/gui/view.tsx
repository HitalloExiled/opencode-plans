/**
 * Plans side panel — SolidJS UI.
 *
 * Reads and writes plans over the GUI IPC (`ctx.main(PlansApi)`), the same
 * contract the desktop main process provides over `plans.db`. The panel is a
 * master/detail view: plan cards with status/progress, then a detail with the
 * checklist and the original Markdown.
 */

import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { usePlugin } from "@opencode/plugin/gui";
import { PlansApi } from "./contract";
import type { Plan, PlanStatus, PlanStep } from "./contract";
import { useT } from "./i18n";

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
.plans-filters { display: flex; gap: 6px; }
.plans-select {
  flex: 1; min-width: 0;
  background: var(--v2-background-bg-layer-02);
  color: var(--v2-text-text-base);
  border: 1px solid var(--v2-border-border-muted);
  border-radius: 6px;
  padding: 5px 6px;
  font-size: 12px;
}
.plans-select:focus-visible { outline: 2px solid var(--v2-border-border-focus); outline-offset: 0; }
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
.plan-updated { font-size: 10.5px; color: var(--v2-text-text-faint); }
.plan-card-title { font-weight: 600; font-size: 13px; line-height: 1.3; overflow-wrap: anywhere; }
.plan-card-project { font-size: 11px; color: var(--v2-text-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
.plan-status.status-abandoned { color: #e8590c; background: rgba(232,89,12,.12); }
.plan-status.status-superseded { color: var(--v2-text-text-muted); background: var(--v2-overlay-simple-overlay-pressed); }
.plan-progress-row { display: flex; align-items: center; gap: 8px; }
.plan-progress { flex: 1; height: 5px; border-radius: 999px; overflow: hidden; background: var(--v2-overlay-simple-overlay-pressed); }
.plan-progress-bar { height: 100%; border-radius: 999px; background: #4f8cff; transition: width .2s ease; }
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
.plan-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.plan-section-title { font-weight: 600; font-size: 12px; color: var(--v2-text-text-base); margin-top: 4px; }
.plan-muted { color: var(--v2-text-text-muted); font-size: 11.5px; }
.plan-steps { display: flex; flex-direction: column; gap: 5px; }
.plan-step { display: flex; align-items: flex-start; gap: 7px; cursor: pointer; line-height: 1.45; }
.plan-step input { margin-top: 1px; accent-color: #4f8cff; }
.plan-step span { overflow-wrap: anywhere; }
.plan-step-done { text-decoration: line-through; color: var(--v2-text-text-muted); }
.plan-body {
  font-size: 12px;
  line-height: 1.5;
  padding-bottom: 12px;
  overflow-wrap: anywhere;
}
`;

type ProjectOption = { id: string; name: string; canonical: string };

export function PlansView() {
  const ctx = usePlugin();
  const api = ctx.main(PlansApi);
  const t = useT();

  const [plans, setPlans] = createSignal<Plan[]>([]);
  const [projects, setProjects] = createSignal<ProjectOption[]>([]);
  const [selectedID, setSelectedID] = createSignal<string | null>(null);
  const [detail, setDetail] = createSignal<Plan | null>(null);
  const [projectID, setProjectID] = createSignal<string | undefined>(undefined);
  const [statusFilter, setStatusFilter] = createSignal<"active" | "done" | "all">("active");
  const [loading, setLoading] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");

  const selectedPlan = createMemo(() => (selectedID() ? detail() : null));

  const currentSession = () => ctx.sessions.current();

  const basename = (path: string): string => path.split("/").pop() || path;

  const formatDate = (iso: string): string => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
  };

  const projectLabel = (plan: Plan): string => {
    const project = projects().find((item) => item.id === plan.projectID);
    return project?.name ?? basename(plan.projectDirectory);
  };

  const progress = (plan: Plan): { done: number; total: number } => ({
    done: plan.steps.filter((step) => step.status === "done").length,
    total: plan.steps.length,
  });

  const percent = (plan: Plan): number => {
    const { done, total } = progress(plan);
    return total === 0 ? 0 : Math.round((done / total) * 100);
  };

  const statusClass = (status: PlanStatus): string => `status-${status}`;

  // Default the project filter to the routed session's project.
  createEffect(() => {
    const id = currentSession()?.project?.id;
    if (id && projectID() === undefined) setProjectID(id);
  });

  // Projects come from opencode itself, never from opencode.db.
  let projectsGen = 0;
  createEffect(() => {
    ctx.sessions.list(); // re-fetch when the open-tab set changes
    const gen = ++projectsGen;
    void ctx.client.project
      .list()
      .then((list) => {
        if (gen !== projectsGen) return;
        setProjects(
          list.map((project) => ({
            id: project.id,
            name: project.name || basename(project.canonical),
            canonical: project.canonical,
          })),
        );
      })
      .catch(() => undefined);
  });

  let loadGen = 0;
  const load = async () => {
    const gen = ++loadGen;
    setLoading(true);
    setError("");
    try {
      const list = await api.list({
        projectID: projectID(),
        status: statusFilter(),
        limit: 200,
      });
      if (gen !== loadGen) return;
      setPlans([...list]);

      const id = selectedID();
      if (id) {
        const found = list.find((plan) => plan.id === id) ?? (await api.get(id));
        if (gen !== loadGen) return;
        setDetail(found ?? null);
        if (!found) setSelectedID(null);
      }
    } catch (cause) {
      if (gen === loadGen) setError(String(cause));
    } finally {
      if (gen === loadGen) setLoading(false);
    }
  };

  createEffect(() => {
    projectID();
    statusFilter();
    void load();
  });

  // The agent writes to the DB from the server process; refresh when the
  // session changes, and on a slow poll while the panel stays open.
  createEffect(() => {
    ctx.sessions.list();
    void load();
  });
  const timer = setInterval(() => {
    if (!loading()) void load();
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

  const toggleStep = async (step: PlanStep, done: boolean) => {
    const id = selectedID();
    if (!id) return;
    setSaving(true);
    try {
      const result = await api.setStep({ id, stepID: step.id, done });
      if (!result.ok) throw new Error(result.error ?? "erro ao atualizar o passo");
      if (result.plan) setDetail(result.plan);
      await load();
    } catch (cause) {
      showError(t("toast.updateError"), cause);
    } finally {
      setSaving(false);
    }
  };

  const changeStatus = async (status: PlanStatus) => {
    const id = selectedID();
    if (!id) return;
    setSaving(true);
    try {
      const result = await api.update({ id, status });
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
    if (!id) return;
    const ok = await ctx.dialogs.confirm({
      title: t("confirm.remove.title"),
      description: t("confirm.remove.desc"),
      confirm: t("confirm.remove.confirm"),
      danger: true,
    });
    if (!ok) return;
    setSaving(true);
    try {
      const result = await api.remove(id);
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

  const saveLast = async () => {
    const session = currentSession();
    if (!session) {
      ctx.toast.show({ title: t("toast.noSession"), variant: "error" });
      return;
    }
    setSaving(true);
    try {
      await session.server.client.session.command({
        sessionID: session.id,
        name: "save-plan",
        text: "",
      });
      ctx.toast.show({ title: t("toast.saveRequested"), variant: "success" });
      // The command writes a synthetic message; refresh after it settles.
      await new Promise((resolve) => setTimeout(resolve, 500));
      await load();
    } catch (cause) {
      showError(t("toast.saveError"), cause);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="plans">
      <style>{CSS}</style>

      <div class="plans-head">
        <div class="plans-title">
          <ctx.ui.Icon name="file-document" size="small" />
          <span>{t("title")}</span>
          <span class="plans-count">{plans().length}</span>
        </div>
        <div class="plans-actions">
          <ctx.ui.Button size="small" variant="contrast" icon="plus" busy={saving()} onClick={() => void saveLast()}>
            {t("saveLast")}
          </ctx.ui.Button>
          <ctx.ui.IconButton
            icon="outline-rotate-clockwise"
            label={t("refresh")}
            onClick={() => void load()}
          />
        </div>
      </div>

      <div class="plans-filters">
        <select
          class="plans-select"
          value={projectID() ?? ""}
          onChange={(event) => setProjectID(event.currentTarget.value || undefined)}
        >
          <option value="">{t("allProjects")}</option>
          <For each={projects()}>
            {(project) => <option value={project.id}>{project.name}</option>}
          </For>
        </select>
        <select
          class="plans-select"
          value={statusFilter()}
          onChange={(event) => setStatusFilter(event.currentTarget.value as "active" | "done" | "all")}
        >
          <option value="active">{t("filter.active")}</option>
          <option value="done">{t("filter.done")}</option>
          <option value="all">{t("filter.all")}</option>
        </select>
      </div>

      <Show when={error()}>
        <div class="plans-error">{error()}</div>
      </Show>

      <Show when={loading() && plans().length === 0}>
        <div class="plans-loading">
          <ctx.ui.Loader size="small" /> {t("loading")}
        </div>
      </Show>

      <Show when={!selectedPlan()}>
        <div class="plans-list">
          <Show when={!loading() && plans().length === 0}>
            <div class="plans-empty">
              <ctx.ui.Icon name="file-document" size="large" class="plans-empty-icon" />
              <div class="plans-empty-title">{t("empty.title")}</div>
              <div class="plans-empty-hint">{t("empty.hint")}</div>
            </div>
          </Show>
          <For each={plans()}>
            {(plan) => (
              <button type="button" class="plan-card" onClick={() => select(plan)}>
                <div class="plan-card-top">
                  <span class={`plan-status ${statusClass(plan.status)}`}>{t(`status.${plan.status}`)}</span>
                  <span class="plan-updated">{formatDate(plan.updatedAt)}</span>
                </div>
                <div class="plan-card-title">{plan.title}</div>
                <div class="plan-card-project">{projectLabel(plan)}</div>
                <div class="plan-progress-row">
                  <div class="plan-progress">
                    <div class="plan-progress-bar" style={{ width: `${percent(plan)}%` }} />
                  </div>
                  <span class="plan-progress-label">
                    {t("progress", progress(plan).done, progress(plan).total)}
                  </span>
                </div>
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show when={selectedPlan()}>
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
                <div class="plan-progress-bar" style={{ width: `${percent(plan())}%` }} />
              </div>
              <span class="plan-progress-label">
                {t("progress", progress(plan()).done, progress(plan()).total)}
              </span>
            </div>

            <div class="plan-actions">
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
                icon="arrow-undo-down"
                disabled={saving()}
                onClick={() => void changeStatus("active")}
              >
                {t("reopen")}
              </ctx.ui.Button>
              <ctx.ui.Button
                size="small"
                variant="ghost"
                icon="outline-hexagonal-warning"
                disabled={saving()}
                onClick={() => void changeStatus("abandoned")}
              >
                {t("archive")}
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

            <div class="plan-section-title">{t("steps")}</div>
            <Show when={plan().steps.length === 0}>
              <div class="plan-muted">{t("noSteps")}</div>
            </Show>
            <div class="plan-steps">
              <For each={plan().steps}>
                {(step) => (
                  <label class="plan-step">
                    <input
                      type="checkbox"
                      checked={step.status === "done"}
                      disabled={saving()}
                      onChange={(event) => void toggleStep(step, event.currentTarget.checked)}
                    />
                    <span classList={{ "plan-step-done": step.status === "done" }}>{step.text}</span>
                  </label>
                )}
              </For>
            </div>

            <div class="plan-section-title">{t("plan")}</div>
            <ctx.ui.Markdown text={plan().body} class="plan-body" />
          </div>
        )}
      </Show>
    </div>
  );
}
