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
  type Project,
  type ProjectResult,
  type Status,
  type WorkItem,
  type WorkItemDetail,
} from "./gui/contract.js";
import { getFlow, setFlow as persistFlow } from "./flow.js";
import { sortWorkItems } from "./work-list.js";
import { captureWorkItem } from "./work-capture.js";
import { notificationLocale, tn } from "./notifications.js";
import { emitPlanChange } from "./plan-events.js";
import {
  addProjectLocation,
  addWorkItemDep as addDepRow,
  countPlans,
  createProject,
  deletePlan,
  getPlan,
  getPlanByWorkItem,
  getProject,
  getStore,
  getWorkItem as getWorkItemRow,
  listPlans,
  listProjects,
  listWorkItems as listProjectWorkItems,
  listWorkItemsAll,
  movePlan,
  moveWorkItem as moveWorkItemRow,
  planProgress,
  plansDbPath,
  removeProjectLocation,
  removeWorkItemDep as removeDepRow,
  renameProject,
  requireStore,
  resolveProject,
  savePlan,
  schemaVersion,
  setPrimaryLocation,
  setStep,
  setWorkItemParent as setParentRow,
  setWorkItemStatus as setStatusRow,
  updatePlan,
  updateWorkItem,
  workItemChildren,
  workItemDeps,
  type Plan as StorePlan,
  type Project as StoreProject,
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
  steps: plan.steps.map((step) => ({
    id: step.step_id,
    position: step.position,
    text: step.text,
    status: step.status,
  })),
});

const fromWrite = (result: SaveOk | WriteError): PlanResult =>
  result.ok ? { ok: true, plan: toPlan(result.plan) } : { ok: false, error: result.error };

const toProject = (project: StoreProject): Project => ({
  id: project.id,
  name: project.name,
  createdAt: project.created_at,
  updatedAt: project.updated_at,
  locations: project.locations.map((location) => ({
    id: location.id,
    directory: location.directory,
    label: location.label,
    primary: location.primary,
    position: location.position,
  })),
});

const projectOk = (project: StoreProject): ProjectResult => ({ ok: true, project: toProject(project) });

const projectError = (
  error: string,
  extra: { needsConfirmation?: boolean | undefined; items?: number | undefined } = {},
): ProjectResult => ({
  ok: false,
  error,
  ...(extra.needsConfirmation ? { needsConfirmation: true } : {}),
  ...(extra.items !== undefined ? { items: extra.items } : {}),
});

const toWorkItem = (item: StoreWorkItemRow): WorkItem => ({
  id: item.id,
  projectID: item.project_id,
  ...(item.location_id ? { locationID: item.location_id } : {}),
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
      });
      if (result.ok) emitPlanChange({ sessionID: result.plan.session_id, planID: result.plan.id });
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

    listProjects: async () => {
      const store = await requireStore();
      return listProjects(store.db).map(toProject);
    },

    createProject: async (input) => {
      const store = await requireStore();
      const result = createProject(store.db, {
        name: input.name,
        locations: input.locations.map((location) => ({
          directory: location.directory,
          ...(location.label ? { label: location.label } : {}),
        })),
      });
      return result.ok ? projectOk(result.project) : projectError(result.error);
    },

    renameProject: async (input) => {
      const store = await requireStore();
      const result = renameProject(store.db, input.id, input.name);
      return result.ok ? projectOk(result.project) : projectError(result.error);
    },

    addProjectLocation: async (input) => {
      const store = await requireStore();
      const result = addProjectLocation(store.db, input.projectID, {
        directory: input.directory,
        ...(input.label ? { label: input.label } : {}),
      });
      if (!result.ok) return projectError(result.error);
      const project = getProject(store.db, input.projectID);
      return project ? projectOk(project) : projectError("projeto não encontrado após adicionar o workspace");
    },

    removeProjectLocation: async (input) => {
      const store = await requireStore();
      const result = removeProjectLocation(store.db, input.projectID, input.locationID, {
        confirm: input.confirm === true,
      });
      if (!result.ok) {
        return projectError(result.error, {
          needsConfirmation: result.needsConfirmation === true,
          ...(result.items !== undefined ? { items: result.items } : {}),
        });
      }
      const project = getProject(store.db, input.projectID);
      return project ? projectOk(project) : projectError("projeto não encontrado após remover o workspace");
    },

    setProjectPrimary: async (input) => {
      const store = await requireStore();
      const result = setPrimaryLocation(store.db, input.projectID, input.locationID);
      if (!result.ok) return projectError(result.error);
      const project = getProject(store.db, input.projectID);
      return project ? projectOk(project) : projectError("projeto não encontrado após trocar o primary");
    },

    listWorkItems: async (input) => {
      const store = await requireStore();
      if (input.scope === "project") {
        if (!input.directory) return [];
        const resolved = resolveProject(store.db, input.directory);
        if (!resolved) return [];
        return [
          {
            project: toProject(resolved.project),
            items: sortWorkItems(listProjectWorkItems(store.db, resolved.project.id)).map(toWorkItem),
          },
        ];
      }

      const projects = listProjects(store.db);
      const byProject = new Map<string, StoreWorkItemRow[]>();
      for (const item of listWorkItemsAll(store.db)) {
        const bucket = byProject.get(item.project_id);
        if (bucket) bucket.push(item);
        else byProject.set(item.project_id, [item]);
      }
      return projects
        .map((project) => ({ project, items: sortWorkItems(byProject.get(project.id) ?? []) }))
        .filter((group) => group.items.length > 0)
        .sort((a, b) => a.project.name.localeCompare(b.project.name))
        .map((group) => ({ project: toProject(group.project), items: group.items.map(toWorkItem) }));
    },

    getWorkItem: async (input) => {
      const store = await requireStore();
      const item = getWorkItemRow(store.db, input.id);
      if (!item) return null;
      const project = getProject(store.db, item.project_id);
      if (!project) return null;
      const deps = workItemDeps(store.db, item.id);
      const parent = item.parent_id ? getWorkItemRow(store.db, item.parent_id) : undefined;
      const plan = getPlanByWorkItem(store.db, item.id);
      const progress = plan ? planProgress(plan) : undefined;
      return {
        item: toWorkItemFull(item),
        project: toProject(project),
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
      if (!input.directory) {
        return { ok: false, error: "directory é obrigatório para criar um work item" };
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
  };
}
