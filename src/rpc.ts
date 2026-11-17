/**
 * Server-side RPC handlers for the Plans panel.
 *
 * The desktop window calls these methods through the server that runs the
 * plugin, so the same hot-reloaded process that owns `plans.db` also serves
 * the panel. No GUI main-process copy of the schema is involved.
 */

import type { Plugin } from "@opencode/plugin";
import type { RpcHandlers } from "@opencode/plugin/promise/rpc";
import {
  PlansRpc,
  WORK_STATUS_ORDER,
  type Plan,
  type PlanFlow,
  type PlanResult,
  type Initiative,
  type InitiativeResult,
  type Status,
  type MergeEntryView,
  type RunItemView,
  type RunView,
  type WorkItem,
  type WorkItemDetail,
} from "./gui/contract.js";
import { getFlow, setFlow as persistFlow } from "./flow.js";
import { sortWorkItems } from "./work-list.js";
import { captureWorkItem } from "./work-capture.js";
import { notificationLocale, tn } from "./notifications.js";
import { emitPlanChange } from "./plan-events.js";
import { cancelProjectRun, preflightRun, resumeProjectRun, retryRunItem, startProjectRun } from "./run-engine.js";
import { beginWork, endWork } from "./work-execution.js";
import {
  activeRun,
  addInitiativeRepo,
  addWorkItemDep as addDepRow,
  countPlans,
  createInitiative,
  createWorkItem,
  deleteInitiative as deleteInitiativeRow,
  deletePlan,
  deleteWorkItem as deleteWorkItemRow,
  finishPlanExecutions,
  depEdges,
  getPlan,
  getPlanByWorkItem,
  getInitiative,
  getStore,
  getRun,
  getWorkItem as getWorkItemRow,
  listMergeQueue,
  listPlans,
  listRunItems,
  listInitiatives,
  listWorkItems as listInitiativeWorkItems,
  listWorkItemsAll,
  movePlan,
  moveWorkItem as moveWorkItemRow,
  placeWorkItem as placeWorkItemRow,
  planProgress,
  plansDbPath,
  recomputeImplicitDeps,
  removeInitiativeRepo,
  removeWorkItemDep as removeDepRow,
  updateInitiative as updateInitiativeRow,
  requireStore,
  resolveInitiative,
  savePlan,
  schemaVersion,
  ensureInitiativeRepo as ensureInitiativeRepoRow,
  setInitiativePrimary,
  setInitiativeRunSettings,
  setStep,
  setPlanWorkItem as setPlanWorkItemRow,
  setWorkItemRepo as setWorkItemRepoRow,
  setWorkItemParent as setParentRow,
  setWorkItemStatus as setStatusRow,
  updatePlan,
  updateWorkItem,
  workItemChildren,
  workItemDeps,
  type Db,
  type Plan as StorePlan,
  type Initiative as StoreInitiative,
  type SaveOk,
  type WorkItemRow as StoreWorkItemRow,
  type WriteError,
} from "./store.js";

type Ctx = Plugin.Context;

const toPlan = (plan: StorePlan): Plan => ({
  id: plan.id,
  projectID: plan.project_id,
  projectDirectory: plan.project_directory,
  sessionID: plan.session_id,
  ...(plan.message_id ? { messageID: plan.message_id } : {}),
  title: plan.title,
  body: plan.body,
  status: plan.status,
  createdAt: plan.created_at,
  updatedAt: plan.updated_at,
  ...(plan.completed_at ? { completedAt: plan.completed_at } : {}),
  ...(plan.work_item_id ? { workItemID: plan.work_item_id } : {}),
  ...(plan.touches && plan.touches.length > 0 ? { touches: plan.touches } : {}),
  steps: plan.steps.map((step) => ({
    id: step.step_id,
    position: step.position,
    text: step.text,
    status: step.status,
  })),
});

const fromWrite = (result: SaveOk | WriteError): PlanResult =>
  result.ok ? { ok: true, plan: toPlan(result.plan) } : { ok: false, error: result.error };

const toInitiativeRepo = (repo: StoreInitiative["repos"][number]) => ({
  id: repo.id,
  directory: repo.directory,
  label: repo.label,
  primary: repo.primary,
  position: repo.position,
});

const toInitiative = (initiative: StoreInitiative): Initiative => ({
  id: initiative.id,
  name: initiative.name,
  ...(initiative.description ? { description: initiative.description } : {}),
  createdAt: initiative.created_at,
  updatedAt: initiative.updated_at,
  ...(initiative.base_branch ? { baseBranch: initiative.base_branch } : {}),
  maxParallel: initiative.max_parallel,
  ...(initiative.verify_command ? { verifyCommand: initiative.verify_command } : {}),
  repos: initiative.repos.map((repo) => ({
    id: repo.id,
    directory: repo.directory,
    label: repo.label,
    primary: repo.primary,
    position: repo.position,
  })),
});

function buildRunView(db: Db, run: NonNullable<ReturnType<typeof getRun>>): RunView {
  const items: RunItemView[] = listRunItems(db, run.id).map((item) => ({
    itemID: item.work_item_id,
    title: getWorkItemRow(db, item.work_item_id)?.title ?? item.work_item_id,
    status: item.status,
    ...(item.branch ? { branch: item.branch } : {}),
    ...(item.worktree ? { worktree: item.worktree } : {}),
    ...(item.session_id ? { sessionID: item.session_id } : {}),
    ...(item.started_at ? { startedAt: item.started_at } : {}),
    ...(item.finished_at ? { finishedAt: item.finished_at } : {}),
    ...(item.merged_sha ? { mergedSha: item.merged_sha } : {}),
    ...(item.error ? { error: item.error } : {}),
  }));
  const queue: MergeEntryView[] = listMergeQueue(db, run.id).map((entry) => ({
    id: entry.id,
    itemID: entry.work_item_id,
    title: getWorkItemRow(db, entry.work_item_id)?.title ?? entry.work_item_id,
    status: entry.status,
    enqueuedAt: entry.enqueued_at,
    ...(entry.claimed_at ? { claimedAt: entry.claimed_at } : {}),
    ...(entry.finished_at ? { finishedAt: entry.finished_at } : {}),
    ...(entry.error ? { error: entry.error } : {}),
  }));
  return {
    id: run.id,
    initiativeID: run.initiative_id,
    baseRef: run.base_ref,
    status: run.status,
    maxParallel: run.max_parallel,
    ...(run.merge_session_id ? { mergeSessionID: run.merge_session_id } : {}),
    startedAt: run.started_at,
    ...(run.finished_at ? { finishedAt: run.finished_at } : {}),
    ...(run.error ? { error: run.error } : {}),
    items,
    queue,
  };
}

const initiativeOk = (initiative: StoreInitiative): InitiativeResult => ({ ok: true, initiative: toInitiative(initiative) });

const initiativeError = (
  error: string,
  extra: { needsConfirmation?: boolean | undefined; items?: number | undefined } = {},
): InitiativeResult => ({
  ok: false,
  error,
  ...(extra.needsConfirmation ? { needsConfirmation: true } : {}),
  ...(extra.items !== undefined ? { items: extra.items } : {}),
});

const toWorkItem = (item: StoreWorkItemRow): WorkItem => ({
  id: item.id,
  initiativeID: item.initiative_id,
  ...(item.repo_id ? { repoID: item.repo_id } : {}),
  ...(item.parent_id ? { parentID: item.parent_id } : {}),
  title: item.title,
  status: item.status,
  rank: item.rank,
  origin: item.origin,
  createdAt: item.created_at,
  updatedAt: item.updated_at,
});

const toWorkItemFull = (item: StoreWorkItemRow): WorkItemDetail["item"] => ({
  ...toWorkItem(item),
  body: item.body,
  ...(item.closed_at ? { closedAt: item.closed_at } : {}),
});



/** Tell the session that the user changed a plan from the panel. */
async function notify(
  ctx: Ctx,
  sessionID: string | undefined,
  text: string,
  planID: string,
  description: string,
): Promise<void> {
  if (!sessionID) return;
  try {
    await ctx.session.synthetic({
      sessionID: sessionID as never,
      text,
      description,
      resume: false,
      metadata: { source: "plans", planID },
    });
  } catch (error) {
    console.error(
      `[plans] could not notify session ${sessionID}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function createRpcHandlers(ctx: Ctx): RpcHandlers<typeof PlansRpc> {
  return {
    status: async (): Promise<Status> => {
      const { store, reason } = await getStore();
      return {
        driver: store ? "sqlite" : "none",
        dbPath: plansDbPath(),
        version: store ? schemaVersion(store.db) : 0,
        ...(reason ? { error: reason } : {}),
      };
    },

    list: async (input) => {
      const store = await requireStore();
      const scope = input.scope ?? "session";
      const sessionID = input.sessionID ? String(input.sessionID) : undefined;
      if (scope === "session" && !sessionID) return [];
      return listPlans(store.db, {
        projectID: scope === "all" ? undefined : String(ctx.location.project.id),
        sessionID: scope === "session" ? sessionID : undefined,
        status: input.status,
        limit: input.limit,
        offset: input.offset,
      }).map(toPlan);
    },

    count: async (input) => {
      const store = await requireStore();
      const scope = input.scope ?? "session";
      const sessionID = input.sessionID ? String(input.sessionID) : undefined;
      if (scope === "session" && !sessionID) return 0;
      return countPlans(store.db, {
        projectID: scope === "all" ? undefined : String(ctx.location.project.id),
        sessionID: scope === "session" ? sessionID : undefined,
        status: input.status,
      });
    },

    get: async (id) => {
      const store = await requireStore();
      const plan = getPlan(store.db, id);
      return plan ? toPlan(plan) : null;
    },

    save: async (input) => {
      const store = await requireStore();
      if (input.id) {
        const existing = getPlan(store.db, input.id);
        if (!existing) return { ok: false, error: `plano não encontrado: ${input.id}` };
        if (existing.session_id !== input.sessionID) {
          return { ok: false, error: "plano pertence a outra sessão; peça ao usuário para mover o plano no painel" };
        }
      }
      const result = savePlan(store.db, {
        id: input.id,
        title: input.title,
        body: input.body,
        steps: input.steps?.map((text) => ({ text })),
        projectID: String(ctx.location.project.id),
        projectDirectory: String(ctx.location.project.canonical ?? ctx.location.directory),
        sessionID: input.sessionID,
        workItemID: input.workItemID ?? null,
        touches: input.touches,
      });
      if (result.ok) {
        emitPlanChange({ sessionID: result.plan.session_id, planID: result.plan.id });
        if (result.plan.work_item_id) {
          const item = getWorkItemRow(store.db, result.plan.work_item_id);
          if (item) recomputeImplicitDeps(store.db, item.initiative_id);
        }
      }
      return fromWrite(result);
    },

    update: async (input) => {
      const store = await requireStore();
      const result = updatePlan(store.db, {
        id: input.id,
        status: input.status,
        title: input.title,
        body: input.body,
      });
      if (!result.ok) return fromWrite(result);
      emitPlanChange({ sessionID: result.plan.session_id, planID: result.plan.id });

      const locale = notificationLocale(input.locale);
      if (input.status) {
        await notify(
          ctx,
          result.plan.session_id,
          tn(locale, "plan.status", result.plan.title, tn(locale, `status.${input.status}`)),
          result.plan.id,
          tn(
            locale,
            "plan.status.action",
            tn(locale, `status.${input.status}.action`),
            result.plan.title,
          ),
        );
      } else {
        await notify(
          ctx,
          result.plan.session_id,
          tn(locale, "plan.updated", result.plan.title),
          result.plan.id,
          tn(locale, "plan.updated.action", result.plan.title),
        );
      }
      return fromWrite(result);
    },

    setStep: async (input) => {
      const store = await requireStore();
      const result = setStep(store.db, {
        id: input.id,
        stepID: input.stepID,
        status: input.status,
      });
      if (!result.ok) return fromWrite(result);
      emitPlanChange({ sessionID: result.plan.session_id, planID: result.plan.id });

      const step = result.plan.steps.find((item) => item.step_id === input.stepID);
      const { done, total } = planProgress(result.plan);
      const stepText = step?.text ?? input.stepID;
      const locale = notificationLocale(input.locale);
      await notify(
        ctx,
        result.plan.session_id,
        tn(
          locale,
          "step.status",
          stepText,
          tn(locale, `step.${input.status}`),
          result.plan.title,
          done,
          total,
        ),
        result.plan.id,
        tn(
          locale,
          "step.status.action",
          tn(locale, `step.${input.status}.action`),
          stepText,
          done,
          total,
        ),
      );
      return fromWrite(result);
    },

    remove: async (input) => {
      const store = await requireStore();
      const result = deletePlan(store.db, input.id);
      if (!result.ok) return fromWrite(result);
      emitPlanChange({ sessionID: result.plan.session_id, planID: result.plan.id });
      const locale = notificationLocale(input.locale);
      await notify(
        ctx,
        result.plan.session_id,
        tn(locale, "plan.removed", result.plan.title),
        result.plan.id,
        tn(locale, "plan.removed.action", result.plan.title),
      );
      return fromWrite(result);
    },

    move: async (input) => {
      const store = await requireStore();
      const plan = getPlan(store.db, input.id);
      if (!plan) return { ok: false, error: `plano não encontrado: ${input.id}` };
      if (plan.project_id !== String(ctx.location.project.id)) {
        return { ok: false, error: "o plano pertence a outro projeto" };
      }
      if (plan.session_id === input.sessionID) return { ok: true, plan: toPlan(plan) };

      const from = plan.session_id;
      const result = movePlan(store.db, input.id, input.sessionID);
      if (!result.ok) return fromWrite(result);
      emitPlanChange({ sessionID: from, planID: result.plan.id });
      emitPlanChange({ sessionID: result.plan.session_id, planID: result.plan.id });
      const locale = notificationLocale(input.locale);
      await notify(
        ctx,
        result.plan.session_id,
        tn(locale, "plan.moved", result.plan.title),
        result.plan.id,
        tn(locale, "plan.moved.action", result.plan.title),
      );
      return fromWrite(result);
    },

    /**
     * Remember the interface locale for server-side messages (the /save-plan
     * command). The server context has no locale; EN-US is the fallback.
     */
    setLocale: async (locale) => {
      await ctx.storage.set("locale", locale);
      return null;
    },

    getFlow: async () => getFlow() as PlanFlow,

    setFlow: async (flow) => persistFlow(flow as PlanFlow),

    listInitiatives: async () => {
      const store = await requireStore();
      return listInitiatives(store.db).map(toInitiative);
    },

    createInitiative: async (input) => {
      const store = await requireStore();
      const result = createInitiative(store.db, {
        name: input.name,
        description: input.description,
        repos: (input.repos ?? []).map((repo) => ({
          directory: repo.directory,
          ...(repo.label ? { label: repo.label } : {}),
        })),
      });
      return result.ok ? initiativeOk(result.initiative) : initiativeError(result.error);
    },

    updateInitiative: async (input) => {
      const store = await requireStore();
      const result = updateInitiativeRow(store.db, {
        id: input.id,
        name: input.name,
        description: input.description,
      });
      return result.ok ? initiativeOk(result.initiative) : initiativeError(result.error);
    },

    addInitiativeRepo: async (input) => {
      const store = await requireStore();
      const result = addInitiativeRepo(store.db, input.initiativeID, {
        directory: input.directory,
        ...(input.label ? { label: input.label } : {}),
      });
      if (!result.ok) return initiativeError(result.error);
      const initiative = getInitiative(store.db, input.initiativeID);
      return initiative ? initiativeOk(initiative) : initiativeError("iniciativa não encontrado após adicionar o repositório");
    },

    removeInitiativeRepo: async (input) => {
      const store = await requireStore();
      const result = removeInitiativeRepo(store.db, input.initiativeID, input.repoID, {
        confirm: input.confirm === true,
      });
      if (!result.ok) {
        return initiativeError(result.error, {
          needsConfirmation: result.needsConfirmation === true,
          ...(result.items !== undefined ? { items: result.items } : {}),
        });
      }
      const initiative = getInitiative(store.db, input.initiativeID);
      return initiative ? initiativeOk(initiative) : initiativeError("iniciativa não encontrado após remover o repositório");
    },

    setInitiativePrimary: async (input) => {
      const store = await requireStore();
      const result = setInitiativePrimary(store.db, input.initiativeID, input.repoID);
      if (!result.ok) return initiativeError(result.error);
      const initiative = getInitiative(store.db, input.initiativeID);
      return initiative ? initiativeOk(initiative) : initiativeError("iniciativa não encontrado após trocar o primary");
    },

    listWorkItems: async (input) => {
      const store = await requireStore();
      if (input.scope === "project") {
        if (!input.directory) return [];
        const resolved = resolveInitiative(store.db, input.directory);
        if (!resolved) return [];
        return [
          {
            initiative: toInitiative(resolved.initiative),
            items: sortWorkItems(listInitiativeWorkItems(store.db, resolved.initiative.id)).map(toWorkItem),
          },
        ];
      }

      const initiatives = listInitiatives(store.db);
      const byProject = new Map<string, StoreWorkItemRow[]>();
      for (const item of listWorkItemsAll(store.db)) {
        const bucket = byProject.get(item.initiative_id);
        if (bucket) bucket.push(item);
        else byProject.set(item.initiative_id, [item]);
      }
      return initiatives
        .map((initiative) => ({ initiative, items: sortWorkItems(byProject.get(initiative.id) ?? []) }))
        .filter((group) => group.items.length > 0)
        .sort((a, b) => a.initiative.name.localeCompare(b.initiative.name))
        .map((group) => ({ initiative: toInitiative(group.initiative), items: group.items.map(toWorkItem) }));
    },

    getWorkItem: async (input) => {
      const store = await requireStore();
      const item = getWorkItemRow(store.db, input.id);
      if (!item) return null;
      const initiative = getInitiative(store.db, item.initiative_id);
      if (!initiative) return null;
      const deps = workItemDeps(store.db, item.id);
      const parent = item.parent_id ? getWorkItemRow(store.db, item.parent_id) : undefined;
      const plan = getPlanByWorkItem(store.db, item.id);
      const progress = plan ? planProgress(plan) : undefined;
      return {
        item: toWorkItemFull(item),
        initiative: toInitiative(initiative),
        blockedBy: deps.blockedBy.map(toWorkItem),
        blocks: deps.blocks.map(toWorkItem),
        parent: parent ? toWorkItem(parent) : null,
        children: workItemChildren(store.db, item.id).map(toWorkItem),
        plan: plan && progress
          ? {
              id: plan.id,
              title: plan.title,
              status: plan.status,
              done: progress.done,
              total: progress.total,
              updatedAt: plan.updated_at,
              sessionID: plan.session_id,
            }
          : null,
      };
    },

    saveWorkItem: async (input) => {
      const store = await requireStore();
      if (input.id) {
        const result = updateWorkItem(store.db, { id: input.id, title: input.title, body: input.body });
        return result.ok ? { ok: true, item: toWorkItem(result.item) } : { ok: false, error: result.error };
      }
      if (input.initiativeID) {
        const result = createWorkItem(store.db, {
          initiativeID: input.initiativeID,
          title: input.title,
          body: input.body,
          origin: "user",
        });
        if (!result.ok) return { ok: false, error: result.error };
        emitPlanChange({ sessionID: "" });
        return { ok: true, item: toWorkItem(result.item) };
      }
      if (!input.directory) {
        return { ok: false, error: "iniciativa ou diretório é obrigatório para criar um work item" };
      }
      const result = captureWorkItem(store.db, {
        directory: input.directory,
        title: input.title,
        body: input.body,
      });
      return result.ok ? { ok: true, item: toWorkItem(result.item) } : { ok: false, error: result.error };
    },

    setWorkItemStatus: async (input) => {
      const store = await requireStore();
      const result = setStatusRow(store.db, { id: input.id, status: input.status });
      return result.ok ? { ok: true, item: toWorkItem(result.item) } : { ok: false, error: result.error };
    },

    moveWorkItem: async (input) => {
      const store = await requireStore();
      const result = moveWorkItemRow(store.db, { id: input.id, direction: input.direction });
      return result.ok ? { ok: true, item: toWorkItem(result.item) } : { ok: false, error: result.error };
    },

    placeWorkItem: async (input) => {
      const store = await requireStore();
      const result = placeWorkItemRow(store.db, {
        id: input.id,
        status: input.status,
        position: input.position,
      });
      return result.ok ? { ok: true, item: toWorkItem(result.item) } : { ok: false, error: result.error };
    },

    getWorkGraph: async (input) => {
      const store = await requireStore();
      const items = listInitiativeWorkItems(store.db, input.initiativeID);
      const nodes = items.map((item) => {
        const plan = getPlanByWorkItem(store.db, item.id);
        const progress = plan ? planProgress(plan) : undefined;
        return {
          id: item.id,
          title: item.title,
          status: item.status,
          rank: item.rank,
          createdAt: item.created_at,
          ...(plan && progress
            ? {
                plan: {
                  id: plan.id,
                  title: plan.title,
                  status: plan.status,
                  done: progress.done,
                  total: progress.total,
                },
              }
            : {}),
        };
      });
      const edges = depEdges(store.db, input.initiativeID).map((edge) => ({
        itemID: edge.itemID,
        blocksID: edge.blocksID,
        kind: edge.kind === "implicit" ? ("implicit" as const) : ("explicit" as const),
        ...(edge.reason ? { reason: edge.reason } : {}),
      }));
      return { nodes, edges };
    },

    setPlanWorkItem: async (input) => {
      const store = await requireStore();
      const result = setPlanWorkItemRow(store.db, { id: input.id, workItemID: input.workItemID });
      if (!result.ok) return { ok: false, error: result.error };
      emitPlanChange({ sessionID: "", planID: input.id });
      return { ok: true };
    },

    deleteWorkItem: async (input) => {
      const store = await requireStore();
      const result = deleteWorkItemRow(store.db, input.id);
      if (!result.ok) return { ok: false, error: result.error };
      emitPlanChange({ sessionID: "" });
      return { ok: true };
    },

    deleteInitiative: async (input) => {
      const store = await requireStore();
      const result = deleteInitiativeRow(store.db, input.id);
      if (!result.ok) return { ok: false, error: result.error };
      emitPlanChange({ sessionID: "" });
      return { ok: true };
    },

    setWorkItemRepo: async (input) => {
      const store = await requireStore();
      const result = setWorkItemRepoRow(store.db, { id: input.id, repoID: input.repoID });
      return result.ok ? { ok: true, item: toWorkItem(result.item) } : { ok: false, error: result.error };
    },

    ensureInitiativeRepo: async (input) => {
      const store = await requireStore();
      const result = ensureInitiativeRepoRow(store.db, input.initiativeID, input.directory);
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, repo: toInitiativeRepo(result.repo), created: result.created };
    },

    addWorkItemDep: async (input) => {
      const store = await requireStore();
      const result = addDepRow(store.db, { itemID: input.itemID, blocksID: input.blocksID });
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    },

    removeWorkItemDep: async (input) => {
      const store = await requireStore();
      const result = removeDepRow(store.db, { itemID: input.itemID, blocksID: input.blocksID });
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    },

    setWorkItemParent: async (input) => {
      const store = await requireStore();
      const result = setParentRow(store.db, { id: input.id, parentID: input.parentID ?? null });
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    },
    runPreflight: async (input) => {
      const store = await requireStore();
      const result = await preflightRun(store.db, input.initiativeID, input.directory);
      if (!result.ok) return { ok: false, blockers: result.blockers, items: [] };
      return {
        ok: true,
        blockers: [],
        baseRef: result.value.baseRef,
        maxParallel: result.value.maxParallel,
        items: result.value.items.map((entry) => ({
          itemID: entry.item.id,
          title: entry.item.title,
          planID: entry.plan.id,
          planTitle: entry.plan.title,
          deps: entry.deps,
        })),
      };
    },

    runStart: async (input) => {
      const store = await requireStore();
      return startProjectRun(ctx, store.db, { initiativeID: input.initiativeID, directory: input.directory });
    },

    runActive: async (input) => {
      const store = await requireStore();
      const run = activeRun(store.db, input.initiativeID);
      return run ? buildRunView(store.db, run) : null;
    },

    runGet: async (input) => {
      const store = await requireStore();
      const run = getRun(store.db, input.runID);
      return run ? buildRunView(store.db, run) : null;
    },

    runCancel: async (input) => {
      const store = await requireStore();
      return cancelProjectRun(ctx, store.db, input.runID);
    },

    executionBegin: async (input) => {
      const store = await requireStore();
      const plan = getPlan(store.db, input.planID);
      if (!plan) return { ok: false, error: `plano não encontrado: ${input.planID}` };
      const itemID = input.workItemID ?? plan.work_item_id ?? undefined;
      // A plan without a work item keeps today's behavior: no branch.
      if (!itemID) return { ok: true, skipped: true };
      const result = await beginWork({
        db: store.db,
        repo: plan.project_directory,
        itemID,
        planID: plan.id,
        sessionID: input.sessionID ?? plan.session_id,
      });
      if (!result.ok) return { ok: false, error: result.error };
      return {
        ok: true,
        mode: result.mode,
        branch: result.branch,
        directory: result.directory,
        executionID: result.execution.id,
      };
    },

    executionEnd: async (input) => {
      const store = await requireStore();
      endWork(store.db, input.planID);
      finishPlanExecutions(store.db, input.planID);
      return { ok: true };
    },

    runResume: async (input) => {
      const store = await requireStore();
      return resumeProjectRun(ctx, store.db, input.runID);
    },

    runRetry: async (input) => {
      const store = await requireStore();
      return retryRunItem(ctx, store.db, input.runID, input.itemID);
    },

    runSettings: async (input) => {
      const store = await requireStore();
      const result = setInitiativeRunSettings(store.db, input.initiativeID, {
        baseBranch: input.baseBranch,
        maxParallel: input.maxParallel,
        verifyCommand: input.verifyCommand,
      });
      return result.ok ? initiativeOk(result.initiative) : initiativeError(result.error);
    },

  };
}
