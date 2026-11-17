/**
 * Work — the global surface (overlay): the user's work items across initiatives.
 *
 * Work items are global because an initiative spans sessions and workspaces; the
 * session side panel owns plans. The overlay offers Work and Plans (Global ->
 * Work -> Plan and Global -> Plan); a plan is also reached from its item.
 */

import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { usePlugin } from "@opencode/plugin/gui";
import type { ServerRef } from "@opencode/plugin/gui";
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
  type Plan,
  type PlanSummary,
  type PreflightView,
  type Initiative,
  type RunView,
  type WorkGroup,
  type WorkItemDetail,
  type WorkItemStatus,
} from "./contract";
import { useT } from "./i18n";
import { executionFor, planTarget } from "./execution";
import { filterWorkGroups } from "../work-filter";
import { planProgressOf } from "../work-progress";
import { planWorkItem } from "./plan-item";
import { openPlanDialog } from "./plan-dialog";
import { WorkGraph } from "./graph";
import { openWorkItemDialog } from "./work-item-dialog";
import { closePlansOverlay } from "./overlay-state";

export type WorkViewMode = "list" | "board" | "graph";

/** Lista | Quadro | Grafo. Module state so the overlay can widen with the board/graph. */
const [viewMode, setViewMode] = createSignal<WorkViewMode>("list");
export const workView = viewMode;
export const workWideMode = (): boolean => viewMode() !== "list";

export type WorkTarget = {
  server: ServerRef;
  /** The overlay is always on screen. */
  visible: () => boolean;
};

const WORK_CSS = `
.work {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  padding: 12px;
  overflow: hidden;
  font-family: var(--font-family-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  color: var(--v2-text-text-base);
  font-size: 12.5px;
}
.work-body { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.work-body.is-hidden { display: none; }
.work-scroll { flex: 1; min-height: 0; overflow-y: auto; padding-right: 2px; padding-bottom: 24px; overscroll-behavior: contain; }
.work-initiative { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
.work-initiative:last-child { margin-bottom: 0; }
.work-initiative-name {
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--v2-text-text-base);
}
.work-initiative-count { font-size: 10.5px; font-weight: 500; color: var(--v2-text-text-faint); }
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
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
  padding: 8px 10px;
  /* A card never grows past its column: long titles and the "doing" step text
     ellipsize instead of spilling over the neighbours. */
  min-width: 0;
  overflow: hidden;
  box-sizing: border-box;
  border: 1px solid var(--v2-border-border-muted);
  border-radius: 6px;
  background: var(--v2-background-bg-layer-01);
  cursor: pointer;
}
.work-card:hover { background-image: linear-gradient(var(--v2-overlay-simple-overlay-hover), var(--v2-overlay-simple-overlay-hover)); }
.work-card:focus-visible { outline: 2px solid var(--v2-border-border-focus); outline-offset: -2px; }
.work-card-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
/* Title, action and pills on one line; the progress bar on its own below. */
.work-card-head { display: flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; }
/* Only the title shrinks; the action and the pills keep their size. */
.work-card-head > * { flex: 0 0 auto; min-width: 0; }
.work-card-head > .work-card-title { flex: 1 1 auto; width: 0; }
.work-card-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.work-card-progress { display: flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; }
.work-progress { width: 56px; flex: 0 0 auto; height: 4px; border-radius: 999px; overflow: hidden; background: var(--v2-overlay-simple-overlay-pressed); }
.work-progress-done { display: block; height: 100%; background: var(--v2-state-fg-success); transition: width .2s ease; }
.work-progress-label { flex: 0 0 auto; font-size: 10px; color: var(--v2-text-text-muted); font-variant-numeric: tabular-nums; }
.work-progress-doing { flex: 1 1 auto; width: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; color: var(--v2-text-text-faint); }
.work-toolbar { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; flex-wrap: wrap; }
.work-new { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
.work-new > :first-child { flex: 1; min-width: 0; }
.work-detail { display: flex; flex-direction: column; gap: 10px; flex: 1; min-height: 0; }
.work-detail-head { display: flex; align-items: center; gap: 6px; }
.work-detail-title { flex: 1; min-width: 0; margin: 0; font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.work-detail-id { flex: 0 0 auto; font-size: 10px; color: var(--v2-text-text-faint); font-variant-numeric: tabular-nums; }
.work-detail-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--v2-text-text-muted); font-size: 11px; }
.work-detail-body { flex: 1; min-height: 0; overflow-y: auto; }
.work-detail-empty { color: var(--v2-text-text-muted); font-size: 11.5px; }
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
.work-pause-icon { display: inline-flex; align-items: center; gap: 3px; margin-right: 5px; }
.work-pause-icon::before, .work-pause-icon::after {
  content: "";
  display: block;
  width: 4px;
  height: 12px;
  border-radius: 1px;
  background: currentColor;
}
.work-run-hint { font-size: 10.5px; color: var(--v2-text-text-faint); }
.work-run-error { font-size: 10.5px; color: var(--v2-state-fg-danger); overflow-wrap: anywhere; }
.work-run-field { display: flex; flex-direction: column; gap: 3px; }
.work-run-field-label { font-size: 11px; font-weight: 600; color: var(--v2-text-text-base); }
/* Same play glyph as the plan Execute: the down triangle rotated into a play. */
.play-icon { color: var(--v2-state-fg-success); }
.play-icon:hover { color: var(--v2-state-fg-success); }
.play-icon svg { transform: rotate(-90deg); width: 20px; height: 20px; }
.work-view-switch { display: flex; align-items: center; gap: 4px; }
.work-board { display: flex; gap: 8px; flex: 1; min-height: 0; overflow-x: auto; padding-bottom: 4px; }
.work-col {
  flex: 1 1 0;
  min-width: 180px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 0;
  padding: 8px;
  border: 1px solid var(--v2-border-border-muted);
  border-radius: 8px;
  background: var(--v2-background-bg-layer-02);
}
.work-col.is-over { border-color: var(--v2-border-border-focus); }
.work-col-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--v2-text-text-muted);
}
.work-col-count { margin-left: auto; font-weight: 500; color: var(--v2-text-text-faint); }
.work-col-body { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
.work-board-card { cursor: grab; }
.work-board-card:active { cursor: grabbing; }
.work-board-card.is-drop { box-shadow: inset 0 2px 0 var(--v2-border-border-focus); }
.work-card-initiative { font-size: 10px; color: var(--v2-text-text-faint); }
.work-card-actions { display: flex; align-items: center; gap: 4px; }
.work-run-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.work-run-panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--v2-border-border-muted);
  border-radius: 6px;
  background: var(--v2-background-bg-layer-01);
}
.work-run-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.work-run-row { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; }
.work-run-actions { display: flex; justify-content: flex-end; gap: 6px; }
.work-run-blockers { display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--v2-state-fg-danger); }
.work-run-badge { flex: 0 0 auto; }
.work-board-empty { font-size: 10.5px; color: var(--v2-text-text-faint); }
`;

const runTone = (status: string): ChipTone =>
  status === "failed" ? "danger" : status === "done" ? "success" : status === "running" ? "info" : "neutral";

const runItemTone = (status: string): ChipTone =>
  status === "failed" ? "danger" : status === "merged" || status === "done" ? "success" : status === "running" || status === "merging" ? "info" : "neutral";

const mergeTone = (status: string): ChipTone =>
  status === "failed" ? "danger" : status === "merged" ? "success" : status === "merging" ? "info" : "neutral";

const duration = (start?: string, end?: string): string => {
  if (!start) return "";
  const from = Date.parse(start);
  const to = end ? Date.parse(end) : Date.now();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return "";
  const seconds = Math.round((to - from) / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
};

/** The overlay switch: Trabalho | Planos (Global -> Work and Global -> Plan). */

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

export function WorkBody(props: {
  target: () => WorkTarget;
  /** The single initiative this surface works on. */
  initiativeID: string | undefined;
  initiatives: Initiative[];
  onSelectInitiative: (id: string) => void;
  onInitiativeChanged: (initiative: Initiative) => void;
}) {
  const ctx = usePlugin();
  const t = useT();
  const [groups, setGroups] = createSignal<WorkGroup[]>([]);
  const [activePlans, setActivePlans] = createSignal<Plan[]>([]);
  const [executingIDs, setExecutingIDs] = createSignal<string[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [reload, setReload] = createSignal(0);

  const [selectedID, setSelectedID] = createSignal<string | undefined>(undefined);
  const [detail, setDetail] = createSignal<WorkItemDetail | null>(null);
  const [fullPlan, setFullPlan] = createSignal<Plan | null>(null);
  const [runningPlan, setRunningPlan] = createSignal(false);
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
  const [deleting, setDeleting] = createSignal(false);
  const [actionError, setActionError] = createSignal<string | null>(null);
  const [agentOnly, setAgentOnly] = createSignal(false);
  const [showDropped, setShowDropped] = createSignal(false);
  const [placing, setPlacing] = createSignal(false);
  const [run, setRun] = createSignal<RunView | null>(null);
  const [preflight, setPreflight] = createSignal<PreflightView | null>(null);
  const [preflightBusy, setPreflightBusy] = createSignal(false);
  const [runBusy, setRunBusy] = createSignal(false);
  const [runError, setRunError] = createSignal<string | null>(null);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [baseInput, setBaseInput] = createSignal("");
  const [parallelInput, setParallelInput] = createSignal("2");
  const [verifyInput, setVerifyInput] = createSignal("");
  const [dropColumn, setDropColumn] = createSignal<WorkItemStatus | null>(null);
  const [dropIndex, setDropIndex] = createSignal(-1);

  // A generation counter drops the result of a request whose target changed.
  let generation = 0;

  createEffect(() => {
    const target = props.target();
    void reload();
    const current = ++generation;
    setLoading(true);
    setError(null);

    void Promise.all([
      target.server.client.rpc(PlansRpc).listWorkItems({ scope: "all" }),
      target.server.client.rpc(PlansRpc).list({ scope: "all", status: "active" }),
      target.server.client.rpc(PlansRpc).executing({}),
    ])
      .then(([itemGroups, plans, executing]) => {
        if (current !== generation) return;
        setGroups(itemGroups as WorkGroup[]);
        setActivePlans(plans as Plan[]);
        setExecutingIDs(executing as string[]);
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
      setFullPlan(null);
      setDetailLoading(false);
      return;
    }
    const current = ++detailGeneration;
    setDetailLoading(true);
    setDetailError(null);
    void target.server.client
      .rpc(PlansRpc)
      .getWorkItem({ id })
      .then((value) => {
        if (current !== detailGeneration) return;
        const next = value as WorkItemDetail | null;
        setDetail(next);
        setDetailLoading(false);
        const summary = next?.plan;
        if (!summary) {
          setFullPlan(null);
          return;
        }
        // The summary is enough for display; executing needs the full plan.
        void target.server.client
          .rpc(PlansRpc)
          .get(summary.id)
          .then((plan) => {
            if (current !== detailGeneration) return;
            setFullPlan(plan as Plan | null);
          })
          .catch(() => {
            if (current !== detailGeneration) return;
            setFullPlan(null);
          });
      })
      .catch((cause: unknown) => {
        if (current !== detailGeneration) return;
        setDetailError(cause instanceof Error ? cause.message : String(cause));
        setDetailLoading(false);
      });
  });

  const selectedInitiative = createMemo(() =>
    props.initiatives.find((initiative) => initiative.id === props.initiativeID),
  );

  /** Run settings and monitor are per selected project. */
  createEffect(() => {
    const initiative = selectedInitiative();
    void reload();
    if (!initiative) {
      setRun(null);
      return;
    }
    void props.target()
      .server.client.rpc(PlansRpc)
      .runActive({ initiativeID: initiative.id })
      .then((value) => setRun(value as RunView | null))
      .catch(() => setRun(null));
  });

  /** Run state per item, for the cards. */
  const runItems = createMemo(() => {
    const map = new Map<string, string>();
    for (const entry of run()?.items ?? []) map.set(entry.itemID, entry.status);
    return map;
  });

  // Blockers travel as data (code + args); the copy lives in i18n so both
  // locales render the same preflight.
  const blockerText = (blocker: { code: string; args?: readonly string[] }): string =>
    t(`work.run.blocker.${blocker.code}`, ...(blocker.args ?? []));

  const directoryOf = (initiative: Initiative): string =>
    initiative.repos.find((repo) => repo.primary)?.directory ?? initiative.repos[0]?.directory ?? "";

  const openSession = (id: string) => {
    ctx.tabs.open({ server: props.target().server.id, id }, { focus: true });
  };

  const loadRun = (initiativeID: string) => {
    void props.target()
      .server.client.rpc(PlansRpc)
      .runActive({ initiativeID })
      .then((value) => setRun(value as RunView | null))
      .catch(() => undefined);
  };

  const openPreflight = () => {
    const initiative = selectedInitiative();
    if (!initiative) return;
    setPreflightBusy(true);
    setRunError(null);
    setPreflight(null);
    void props.target()
      .server.client.rpc(PlansRpc)
      .runPreflight({ initiativeID: initiative.id, directory: directoryOf(initiative) })
      .then((value) => setPreflight(value as PreflightView))
      .catch((cause: unknown) => setRunError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPreflightBusy(false));
  };

  const startRun = () => {
    const initiative = selectedInitiative();
    if (!initiative) return;
    setRunBusy(true);
    setRunError(null);
    void props.target()
      .server.client.rpc(PlansRpc)
      .runStart({ initiativeID: initiative.id, directory: directoryOf(initiative) })
      .then((result) => {
        if (!result.ok) {
          // A preflight failure keeps its structured blockers: show them in the
          // same panel instead of a joined string.
          if (result.blockers && result.blockers.length > 0) {
            setPreflight({ ok: false, blockers: result.blockers, items: [] } as PreflightView);
            return;
          }
          setRunError(result.error ?? t("work.run.startError"));
          return;
        }
        setPreflight(null);
        if (result.runID) {
          void props.target()
            .server.client.rpc(PlansRpc)
            .runGet({ runID: result.runID })
            .then((value) => setRun(value as RunView | null));
        }
        ctx.toast.show({ title: t("work.run.started"), variant: "success" });
      })
      .catch((cause: unknown) => setRunError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setRunBusy(false));
  };

  const cancelRun = (runID: string) => {
    const initiative = selectedInitiative();
    if (!initiative || runBusy()) return;
    setRunBusy(true);
    setRunError(null);
    void props.target()
      .server.client.rpc(PlansRpc)
      .runCancel({ runID })
      .then((result) => {
        if (!result.ok) {
          setRunError(result.error ?? t("work.run.cancelError"));
          return;
        }
        loadRun(initiative.id);
      })
      .catch((cause: unknown) => setRunError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setRunBusy(false));
  };

  const resumeRun = (runID: string) => {
    const initiative = selectedInitiative();
    if (!initiative || runBusy()) return;
    setRunBusy(true);
    setRunError(null);
    void props.target()
      .server.client.rpc(PlansRpc)
      .runResume({ runID })
      .then((result) => {
        if (!result.ok) {
          setRunError(result.error ?? t("work.run.resumeError"));
          return;
        }
        loadRun(initiative.id);
      })
      .catch((cause: unknown) => setRunError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setRunBusy(false));
  };

  const retryRun = (runID: string, itemID: string) => {
    if (runBusy()) return;
    setRunBusy(true);
    setRunError(null);
    void props.target()
      .server.client.rpc(PlansRpc)
      .runRetry({ runID, itemID })
      .then((result) => {
        if (!result.ok) {
          setRunError(result.error ?? t("work.run.retryError"));
          return;
        }
        void props.target()
          .server.client.rpc(PlansRpc)
          .runGet({ runID })
          .then((value) => setRun(value as RunView | null));
      })
      .catch((cause: unknown) => setRunError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setRunBusy(false));
  };

  const syncSettings = () => {
    const initiative = selectedInitiative();
    if (!initiative) return;
    setBaseInput(initiative.baseBranch ?? "main");
    setParallelInput(String(initiative.maxParallel ?? 2));
    setVerifyInput(initiative.verifyCommand ?? "");
  };

  const saveSettings = () => {
    const initiative = selectedInitiative();
    if (!initiative || runBusy()) return;
    setRunBusy(true);
    setRunError(null);
    void props.target()
      .server.client.rpc(PlansRpc)
      .runSettings({
        initiativeID: initiative.id,
        baseBranch: baseInput().trim() || null,
        maxParallel: Number(parallelInput()) || 2,
        verifyCommand: verifyInput().trim() || null,
      })
      .then((result) => {
        if (!result.ok) {
          setRunError(result.error ?? t("work.run.settingsError"));
          return;
        }
        if (result.initiative) props.onInitiativeChanged(result.initiative);
        setSettingsOpen(false);
        ctx.toast.show({ title: t("work.run.settingsSaved"), variant: "success" });
      })
      .catch((cause: unknown) => setRunError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setRunBusy(false));
  };

  /** The active plan of each item, for the card progress. */
  const plansByItem = createMemo(() => {
    const map = new Map<string, Plan>();
    for (const plan of activePlans()) {
      if (plan.workItemID && !map.has(plan.workItemID)) map.set(plan.workItemID, plan);
    }
    return map;
  });

  const initiativeGroups = createMemo(() => {
    const id = props.initiativeID;
    return id ? groups().filter((group) => group.initiative.id === id) : [];
  });

  const visibleGroups = createMemo(() =>
    filterWorkGroups(initiativeGroups(), { agentOnly: agentOnly(), showDropped: showDropped() }),
  );
  const total = createMemo(() => visibleGroups().reduce((sum, group) => sum + group.items.length, 0));
  const hasAgentItems = createMemo(() =>
    initiativeGroups().some((group) => group.items.some((item) => item.origin === "agent")),
  );
  const hasDropped = createMemo(() =>
    initiativeGroups().some((group) => group.items.some((item) => item.status === "dropped")),
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

  /** Dropped joins the board only when its filter is on. */
  const boardStatuses = createMemo(() =>
    showDropped() ? [...WORK_STATUS_ORDER] : WORK_STATUS_ORDER.filter((status) => status !== "dropped"),
  );

  const boardColumns = createMemo(() => {
    const groups = visibleGroups();
    return boardStatuses().map((status) => ({
      status,
      items: groups.flatMap((group) =>
        group.items
          .filter((item) => item.status === status)
          .map((item) => ({ item })),
      ),
    }));
  });

  /** Drag and the accessible menu both land here: status plus exact index. */
  const place = (id: string, status: WorkItemStatus, position: number) => {
    if (placing()) return;
    setPlacing(true);
    setActionError(null);
    void props.target()
      .server.client.rpc(PlansRpc)
      .placeWorkItem({ id, status, position })
      .then((result) => {
        if (!result.ok) {
          setActionError(result.error ?? t("work.move.error"));
          return;
        }
        setReload((n) => n + 1);
      })
      .catch((cause: unknown) => setActionError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => {
        setPlacing(false);
        setDropColumn(null);
        setDropIndex(-1);
      });
  };

  const drop = (event: DragEvent, status: WorkItemStatus, index: number) => {
    event.preventDefault();
    event.stopPropagation();
    const id = event.dataTransfer?.getData("text/plain") ?? "";
    if (!id) return;
    place(id, status, index);
  };

  const empty = () => {
    if (!props.initiativeID) {
      return { title: t("work.initiative.selectTitle"), hint: t("work.initiative.selectHint") };
    }
    if (agentOnly()) {
      return { title: t("work.empty.agent.title"), hint: t("work.empty.agent.hint") };
    }
    return { title: t("work.initiative.empty.title"), hint: t("work.initiative.empty.hint") };
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
      .saveWorkItem({ id, title, body: editBody() })
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

  const deleteItem = async (item: { id: string; title: string }) => {
    if (deleting()) return;
    const confirmed = await ctx.dialogs.confirm({
      title: t("work.item.deleteTitle"),
      description: t("work.item.deleteMessage", item.title),
      confirm: t("work.item.deleteConfirm"),
      cancel: t("cancel"),
      danger: true,
    });
    if (!confirmed) return;
    setDeleting(true);
    setActionError(null);
    void props.target()
      .server.client.rpc(PlansRpc)
      .deleteWorkItem({ id: item.id })
      .then((result) => {
        if (!result.ok) {
          setActionError(result.error ?? t("work.item.deleteError"));
          return;
        }
        closeDetail();
        setReload((n) => n + 1);
        ctx.toast.show({ title: t("work.item.deleted"), variant: "success" });
      })
      .catch((cause: unknown) => setActionError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setDeleting(false));
  };

  const openNewItem = () => {
    const initiative = selectedInitiative();
    if (!initiative) return;
    openWorkItemDialog({
      ctx,
      server: props.target().server,
      initiative,
      onCreated: () => setReload((n) => n + 1),
    });
  };

  const depCandidates = createMemo(() => {
    const current = detail();
    if (!current) return [];
    const group = groups().find((entry) => entry.initiative.id === current.item.initiativeID);
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
      .addWorkItemDep({ itemID: id, blocksID })
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
      .removeWorkItemDep({ itemID: id, blocksID })
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

  /** Only an active plan is executable; a done one needs a replan first. */
  const activePlan = (): Plan | undefined => {
    const plan = fullPlan();
    return plan && plan.status === "active" ? plan : undefined;
  };

  // Executing from the global surface runs the plan in its own session (the
  // session that wrote it) and never moves it, like the overlay.
  const execution = (plan: Plan) =>
    executionFor(ctx, planTarget(props.target().server, plan));

  // An execution row is open while the run is in flight and closes when the
  // session idles; the session status keeps a crashed row from showing forever.
  const isExecuting = (plan: Plan): boolean => {
    if (execution(plan).isExecuting(plan)) return true;
    return (
      executingIDs().includes(plan.id) &&
      props.target().server.data.session.status(plan.sessionID) === "running"
    );
  };

  const executingItem = (itemID: string): boolean => {
    const plan = plansByItem().get(itemID);
    return plan ? isExecuting(plan) : false;
  };

  const runDisabled = (plan: Plan): boolean =>
    runningPlan() || (!isExecuting(plan) && (plan.steps.length === 0 || execution(plan).busy()));

  const toggleRun = async (plan: Plan) => {
    if (runningPlan()) return;
    setRunningPlan(true);
    setActionError(null);
    try {
      if (isExecuting(plan)) await execution(plan).pause(plan, t);
      else await execution(plan).execute(plan, t);
    } finally {
      setRunningPlan(false);
      setReload((n) => n + 1);
    }
  };

  /** With a plan it reopens the plan's session; without one, it asks where. */
  const startPlanning = (current: WorkItemDetail) => {
    if (planning()) return;
    setActionError(null);
    if (current.plan) {
      setPlanning(true);
      void planWorkItem({ ctx, target: props.target(), detail: current, t })
        .then(() => closePlansOverlay())
        .catch((cause: unknown) => setActionError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => setPlanning(false));
      return;
    }
    openPlanDialog({
      ctx,
      server: props.target().server,
      detail: current,
      onPlanned: () => {
        closePlansOverlay();
        setReload((n) => n + 1);
        setDetailReload((n) => n + 1);
      },
    });
  };

  const planDetail = (current: WorkItemDetail) => startPlanning(current);

  const planFromCard = (id: string) => {
    if (planning()) return;
    setActionError(null);
    void props.target()
      .server.client.rpc(PlansRpc)
      .getWorkItem({ id })
      .then((current) => {
        if (!current) throw new Error(t("work.plan.error"));
        startPlanning(current as WorkItemDetail);
      })
      .catch((cause: unknown) => setActionError(cause instanceof Error ? cause.message : String(cause)));
  };

  /**
   * The card action shared by the three views: plan the item when it has no
   * active plan, execute that plan when it does.
   */
  const cardAction = (id: string) => {
    const summary = plansByItem().get(id);
    if (!summary) {
      planFromCard(id);
      return;
    }
    void props.target()
      .server.client.rpc(PlansRpc)
      .get(summary.id)
      .then((plan) => {
        if (plan) void toggleRun(plan as Plan);
      })
      .catch((cause: unknown) => setActionError(cause instanceof Error ? cause.message : String(cause)));
  };

  const openPlan = (plan: PlanSummary) => {
    ctx.tabs.open({ server: props.target().server.id, id: plan.sessionID }, { focus: true });
  };

  const parentCandidates = createMemo(() => {
    const current = detail();
    if (!current || current.children.length > 0) return [];
    const group = groups().find((entry) => entry.initiative.id === current.item.initiativeID);
    if (!group) return [];
    return group.items.filter(
      (item) => item.id !== current.item.id && item.parentID === undefined && item.id !== current.parent?.id,
    );
  });

  const setParent = (parentID: string | null) => {
    const id = selectedID();
    if (!id || parentSaving()) return;
    setParentSaving(true);
    setActionError(null);
    void props.target()
      .server.client.rpc(PlansRpc)
      .setWorkItemParent({ id, parentID })
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
    const group = groups().find((entry) => entry.initiative.id === current.item.initiativeID);
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
      .moveWorkItem({ id, direction })
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
      .setWorkItemStatus({ id, status })
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

  return (
    <>
      <style>{SHARED_CSS + WORK_CSS}</style>
      <div class="work">
        <Show when={!selectedID()}>
          <div class="work-toolbar">
              <div class="work-view-switch" role="group" aria-label={t("work.view.label")}>
                <ctx.ui.Button
                  size="small"
                  variant={viewMode() === "list" ? "neutral" : "ghost"}
                  icon="checklist"
                  onClick={() => setViewMode("list")}
                >
                  {t("work.view.list")}
                </ctx.ui.Button>
                <ctx.ui.Button
                  size="small"
                  variant={viewMode() === "board" ? "neutral" : "ghost"}
                  icon="workspace"
                  onClick={() => setViewMode("board")}
                >
                  {t("work.view.board")}
                </ctx.ui.Button>
                <ctx.ui.Button
                  size="small"
                  variant={viewMode() === "graph" ? "neutral" : "ghost"}
                  icon="branch"
                  onClick={() => setViewMode("graph")}
                >
                  {t("work.view.graph")}
                </ctx.ui.Button>
              </div>
              <Show when={props.initiatives.length > 0}>
                <ctx.ui.Menu
                  trigger="button"
                  icon="workspace"
                  label={selectedInitiative()?.name ?? t("work.initiative.select")}
                  items={props.initiatives.map((initiative) => ({
                    label: initiative.name,
                    onSelect: () => props.onSelectInitiative(initiative.id),
                  }))}
                />
              </Show>
              <ctx.ui.Button
                size="small"
                variant="neutral"
                icon="plus"
                disabled={!selectedInitiative()}
                onClick={openNewItem}
              >
                {t("work.newItem")}
              </ctx.ui.Button>
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

          <Show when={selectedInitiative()}>
            <div class="work-run-bar">
              <ctx.ui.Button
                size="small"
                variant="neutral"
                class="play-icon"
                icon="fill-triangle-down"
                busy={preflightBusy()}
                onClick={openPreflight}
              >
                {t("work.run.button")}
              </ctx.ui.Button>
              <ctx.ui.Button
                size="small"
                variant="ghost"
                icon="settings-gear"
                onClick={() => {
                  setSettingsOpen((value) => !value);
                  syncSettings();
                }}
              >
                {t("work.run.settings")}
              </ctx.ui.Button>
              <Show when={run()}>
                {(current) => (
                  <>
                    <StatusChip
                      tone={runTone(current().status)}
                      label={t(`run.status.${current().status}`)}
                    />
                    <span class="work-dep-label">
                      {t(
                        "work.run.progress",
                        current().items.filter((entry) => entry.status === "merged").length,
                        current().items.length,
                      )}
                    </span>
                  </>
                )}
              </Show>
            </div>

            <Show when={runError()}>
              <ErrorBanner message={runError()!} />
            </Show>

            <Show when={preflight()}>
              {(view) => (
                <div class="work-run-panel">
                  <Show
                    when={view().ok}
                    fallback={
                      <div class="work-run-blockers">
                        <For each={view().blockers}>{(blocker) => <div>• {blockerText(blocker)}</div>}</For>
                      </div>
                    }
                  >
                    <div class="work-dep-label">
                      {t("work.run.ready", view().items.length, view().baseRef ?? "", view().maxParallel ?? 0)}
                    </div>
                    <For each={view().items}>
                      {(entry) => (
                        <div class="work-run-row">
                          <span class="work-card-title">{entry.title}</span>
                          <span class="work-dep-label">{entry.planTitle}</span>
                        </div>
                      )}
                    </For>
                    <div class="work-run-actions">
                      <ctx.ui.Button size="small" variant="ghost" onClick={() => setPreflight(null)}>
                        {t("cancel")}
                      </ctx.ui.Button>
                      <ctx.ui.Button size="small" variant="contrast" busy={runBusy()} onClick={startRun}>
                        {t("work.run.start")}
                      </ctx.ui.Button>
                    </div>
                  </Show>
                </div>
              )}
            </Show>

            <Show when={run()}>
              {(current) => (
                <div class="work-run-panel">
                  <div class="work-run-head">
                    <span class="work-dep-label">{t("work.run.items")}</span>
                    <Show when={current().status === "interrupted"}>
                      <ctx.ui.Button
                        size="small"
                        variant="neutral"
                        class="play-icon"
                        icon="fill-triangle-down"
                        busy={runBusy()}
                        onClick={() => resumeRun(current().id)}
                      >
                        {t("work.run.resume")}
                      </ctx.ui.Button>
                    </Show>
                    <Show when={current().status === "running" || current().status === "interrupted"}>
                      <ctx.ui.Button
                        size="small"
                        variant="ghost"
                        icon="close-small"
                        busy={runBusy()}
                        onClick={() => cancelRun(current().id)}
                      >
                        {t("work.run.cancel")}
                      </ctx.ui.Button>
                    </Show>
                    <Show when={current().mergeSessionID}>
                      {(sessionID) => (
                        <ctx.ui.Button
                          size="small"
                          variant="ghost"
                          icon="arrow-up-right"
                          onClick={() => openSession(sessionID())}
                        >
                          {t("work.run.mergeSession")}
                        </ctx.ui.Button>
                      )}
                    </Show>
                  </div>

                  <Show when={current().error}>
                    <span class="work-run-error">{current().error}</span>
                  </Show>

                  <For each={current().items}>
                    {(entry) => (
                      <div class="work-run-row">
                        <StatusChip
                          tone={runItemTone(entry.status)}
                          label={t(`run.item.${entry.status}`)}
                        />
                        <span class="work-card-title">{entry.title}</span>
                        <span class="work-dep-label">{entry.branch ?? ""}</span>
                        <span class="work-dep-label">{duration(entry.startedAt, entry.finishedAt)}</span>
                        <Show when={entry.sessionID}>
                          {(sessionID) => (
                            <ctx.ui.IconButton
                              icon="arrow-up-right"
                              label={t("work.run.openSession")}
                              onClick={() => openSession(sessionID())}
                            />
                          )}
                        </Show>
                        <Show when={entry.status === "failed" || entry.status === "skipped"}>
                          <ctx.ui.IconButton
                            icon="refresh"
                            label={t("work.run.retry")}
                            disabled={runBusy()}
                            onClick={() => retryRun(current().id, entry.itemID)}
                          />
                        </Show>
                        <Show when={entry.error}>
                          <span class="work-error-detail">{entry.error}</span>
                        </Show>
                      </div>
                    )}
                  </For>

                  <Show when={current().queue.length > 0}>
                    <div class="work-dep-label">{t("work.run.queue")}</div>
                    <For each={current().queue}>
                      {(entry) => (
                        <div class="work-run-row">
                          <StatusChip tone={mergeTone(entry.status)} label={t(`run.merge.${entry.status}`)} />
                          <span class="work-card-title">{entry.title}</span>
                          <Show when={entry.error}>
                            <span class="work-error-detail">{entry.error}</span>
                          </Show>
                        </div>
                      )}
                    </For>
                  </Show>
                </div>
              )}
            </Show>

            <Show when={settingsOpen()}>
              <div class="work-run-panel">
                <div class="work-run-field">
                  <span class="work-run-field-label">{t("work.run.base")}</span>
                  <ctx.ui.TextInput
                    value={baseInput()}
                    onInput={(value) => setBaseInput(value)}
                    label={t("work.run.base")}
                    placeholder={t("work.run.baseHint")}
                  />
                  <span class="work-run-hint">{t("work.run.baseDescription")}</span>
                </div>
                <div class="work-run-field">
                  <span class="work-run-field-label">{t("work.run.parallel")}</span>
                  <ctx.ui.TextInput
                    value={parallelInput()}
                    onInput={(value) => setParallelInput(value)}
                    label={t("work.run.parallel")}
                  />
                  <span class="work-run-hint">{t("work.run.parallelDescription")}</span>
                </div>
                <div class="work-run-field">
                  <span class="work-run-field-label">{t("work.run.verify")}</span>
                  <ctx.ui.TextInput
                    value={verifyInput()}
                    onInput={(value) => setVerifyInput(value)}
                    label={t("work.run.verify")}
                  />
                  <span class="work-run-hint">{t("work.run.verifyDescription")}</span>
                </div>
                <div class="work-run-actions">
                  <ctx.ui.Button size="small" variant="ghost" onClick={() => setSettingsOpen(false)}>
                    {t("cancel")}
                  </ctx.ui.Button>
                  <ctx.ui.Button size="small" variant="contrast" busy={runBusy()} onClick={saveSettings}>
                    {t("work.run.save")}
                  </ctx.ui.Button>
                </div>
              </div>
            </Show>
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
              <div class="work-body" classList={{ "is-hidden": viewMode() !== "list" }}>
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
                      <div class="work-initiative">
                        <h3 class="work-initiative-name">
                          {group.initiative.name}
                          <span class="work-initiative-count">{group.items.length}</span>
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
                                    <div class="work-card-head">
                                      <span class="work-card-title">{item.title}</span>
                                      <Show when={item.origin === "agent"}>
                                        <StatusChip label={t("work.agent")} tone="info" />
                                      </Show>
                                      <Show when={runItems().get(item.id)}>
                                        {(status) => (
                                          <span class="work-run-badge">
                                            <StatusChip
                                              label={t(`run.item.${status()}`)}
                                              tone={runItemTone(status())}
                                            />
                                          </span>
                                        )}
                                      </Show>
                                    </div>
                                    <span class="work-card-progress">
                                      <Show
                                        when={executingItem(item.id)}
                                        fallback={
                                          <ctx.ui.IconButton
                                            class={plansByItem().get(item.id) ? "play-icon" : undefined}
                                            icon={plansByItem().get(item.id) ? "fill-triangle-down" : "brain"}
                                            label={t(plansByItem().get(item.id) ? "work.card.execute" : "work.card.plan")}
                                            disabled={planning()}
                                            onClick={(event) => {
                                              event.stopPropagation();
                                              cardAction(item.id);
                                            }}
                                          />
                                        }
                                      >
                                        <StatusChip tone="info" label={t("run.item.running")} />
                                      </Show>
                                      <Show when={plansByItem().get(item.id)}>
                                        {(plan) => (
                                          <>
                                            <span class="work-progress">
                                              <span
                                                class="work-progress-done"
                                                style={{ width: `${planProgressOf(plan()).percent}%` }}
                                              />
                                            </span>
                                            <span class="work-progress-label">
                                              {t("work.progress", planProgressOf(plan()).done, planProgressOf(plan()).total)}
                                            </span>
                                            <Show when={planProgressOf(plan()).doing}>
                                              {(doing) => <span class="work-progress-doing">{doing()}</span>}
                                            </Show>
                                          </>
                                        )}
                                      </Show>
                                    </span>
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
              <Show when={viewMode() === "board"}>
                <div class="work-board">
                  <For each={boardColumns()}>
                    {(column) => (
                      <section
                        class="work-col"
                        classList={{ "is-over": dropColumn() === column.status }}
                        aria-label={t(statusLabelKey(column.status))}
                        onDragOver={(event) => {
                          event.preventDefault();
                          setDropColumn(column.status);
                          if (dropIndex() < 0) setDropIndex(column.items.length);
                        }}
                        onDragLeave={(event) => {
                          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                          if (dropColumn() !== column.status) return;
                          setDropColumn(null);
                          setDropIndex(-1);
                        }}
                        onDrop={(event) => drop(event, column.status, column.items.length)}
                      >
                        <header class="work-col-head">
                          <span class={`work-dot is-${column.status}`} />
                          {t(statusLabelKey(column.status))}
                          <span class="work-col-count">{column.items.length}</span>
                        </header>
                        <div class="work-col-body">
                          <For each={column.items}>
                            {(entry, index) => (
                              <div
                                class="work-card work-board-card"
                                classList={{
                                  "is-drop": dropColumn() === column.status && dropIndex() === index(),
                                }}
                                draggable={true}
                                role="button"
                                tabIndex={0}
                                onDragStart={(event) => {
                                  event.dataTransfer?.setData("text/plain", entry.item.id);
                                  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
                                }}
                                onDragOver={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  setDropColumn(column.status);
                                  setDropIndex(index());
                                }}
                                onDrop={(event) => drop(event, column.status, index())}
                                onClick={() => openItem(entry.item.id)}
                                onKeyDown={(event) => {
                                  if (event.target !== event.currentTarget) return;
                                  if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    openItem(entry.item.id);
                                  }
                                }}
                              >
                                <div class="work-card-head">
                                  <span class="work-card-title">{entry.item.title}</span>
                                  <Show when={entry.item.origin === "agent"}>
                                    <StatusChip label={t("work.agent")} tone="info" />
                                  </Show>
                                </div>
                                <span class="work-card-progress">
                                  <Show
                                    when={executingItem(entry.item.id)}
                                    fallback={
                                      <ctx.ui.IconButton
                                        class={plansByItem().get(entry.item.id) ? "play-icon" : undefined}
                                        icon={plansByItem().get(entry.item.id) ? "fill-triangle-down" : "brain"}
                                        label={t(plansByItem().get(entry.item.id) ? "work.card.execute" : "work.card.plan")}
                                        disabled={planning()}
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          cardAction(entry.item.id);
                                        }}
                                      />
                                    }
                                  >
                                    <StatusChip tone="info" label={t("run.item.running")} />
                                  </Show>
                                  <Show when={plansByItem().get(entry.item.id)}>
                                    {(plan) => (
                                      <>
                                        <span class="work-progress">
                                          <span
                                            class="work-progress-done"
                                            style={{ width: `${planProgressOf(plan()).percent}%` }}
                                          />
                                        </span>
                                        <span class="work-progress-label">
                                          {t("work.progress", planProgressOf(plan()).done, planProgressOf(plan()).total)}
                                        </span>
                                      </>
                                    )}
                                  </Show>
                                </span>
                                <Show when={runItems().get(entry.item.id)}>
                                  {(status) => (
                                    <span class="work-run-badge">
                                      <StatusChip
                                        label={t(`run.item.${status()}`)}
                                        tone={runItemTone(status())}
                                      />
                                    </span>
                                  )}
                                </Show>
                              </div>
                            )}
                          </For>
                          <Show when={column.items.length === 0}>
                            <span class="work-board-empty">{t("work.board.empty")}</span>
                          </Show>
                        </div>
                      </section>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={viewMode() === "graph"}>
                <WorkGraph
                  server={props.target().server}
                  initiativeID={selectedInitiative()?.id}
                  revision={reload()}
                  onOpen={openItem}
                  onAction={cardAction}
                  hasPlan={(id) => Boolean(plansByItem().get(id))}
                  isRunning={executingItem}
                />
              </Show>
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
                  <span class="work-detail-id" title={current().item.id}>
                    {t("work.item.id", current().item.id.slice(0, 8))}
                  </span>
                  <Show
                    when={activePlan()}
                    fallback={<span class="work-run-hint">{t("work.execute.planFirst")}</span>}
                  >
                    {(plan) => (
                      <ctx.ui.Button
                        size="small"
                        variant="contrast"
                        class={isExecuting(plan()) ? "" : "play-icon"}
                        icon={isExecuting(plan()) ? undefined : "fill-triangle-down"}
                        disabled={runDisabled(plan())}
                        onClick={() => void toggleRun(plan())}
                      >
                        <Show when={isExecuting(plan())}>
                          <span class="work-pause-icon" />
                        </Show>
                        {isExecuting(plan()) ? t("pause") : t("execute")}
                      </ctx.ui.Button>
                    )}
                  </Show>
                  <ctx.ui.Button
                    size="small"
                    variant="neutral"
                    icon="brain"
                    busy={planning()}
                    onClick={() => planDetail(current())}
                  >
                    {t("work.plan")}
                  </ctx.ui.Button>
                  <Show when={current().plan?.status === "done" && current().item.status === "doing"}>
                    <ctx.ui.Button
                      size="small"
                      variant="contrast"
                      icon="circle-check"
                      disabled={statusSaving()}
                      onClick={() => void changeStatus("done")}
                    >
                      {t("work.accept")}
                    </ctx.ui.Button>
                  </Show>
                  <ctx.ui.Button size="small" variant="neutral" icon="pencil-line" onClick={startEdit}>
                    {t("work.edit")}
                  </ctx.ui.Button>
                  <ctx.ui.IconButton
                    icon="trash"
                    label={t("work.item.delete")}
                    disabled={deleting()}
                    onClick={() => void deleteItem(current().item)}
                  />
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
                    {t("work.detail.initiative")}: {current().initiative.name}
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
                        <ctx.ui.IconButton
                          icon="arrow-up-right"
                          label={t("work.plan.open")}
                          onClick={() => openPlan(plan())}
                        />
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

                  <Show when={current().mergePending}>
                    <span class="work-dep-label">{t("work.merge.pending")}</span>
                  </Show>

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
