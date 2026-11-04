/**
 * Server-side RPC handlers for the Plans panel.
 *
 * The desktop window calls these methods through the server that runs the
 * plugin, so the same hot-reloaded process that owns `plans.db` also serves
 * the panel. No GUI main-process copy of the schema is involved.
 */

import type { Plugin } from "@opencode/plugin";
import type { RpcHandlers } from "@opencode/plugin/promise/rpc";
import { PlansRpc, type Plan, type PlanResult, type PlanStatus, type Status } from "./gui/contract.js";
import {
  deletePlan,
  getPlan,
  getStore,
  listPlans,
  planProgress,
  plansDbPath,
  requireStore,
  schemaVersion,
  setStep,
  updatePlan,
  type Plan as StorePlan,
  type SaveOk,
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
  steps: plan.steps.map((step) => ({
    id: step.step_id,
    position: step.position,
    text: step.text,
    status: step.status,
  })),
});

const fromWrite = (result: SaveOk | WriteError): PlanResult =>
  result.ok ? { ok: true, plan: toPlan(result.plan) } : { ok: false, error: result.error };

function statusLabel(status: PlanStatus): string {
  switch (status) {
    case "done":
      return "concluído";
    case "archived":
      return "arquivado";
    case "superseded":
      return "substituído";
    default:
      return "reaberto";
  }
}

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

function statusAction(status: PlanStatus): string {
  switch (status) {
    case "done":
      return "Concluiu";
    case "archived":
      return "Arquivou";
    case "superseded":
      return "Substituiu";
    default:
      return "Reabriu";
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
      return listPlans(store.db, {
        projectID: String(ctx.location.project.id),
        status: input.status,
        limit: input.limit,
      }).map(toPlan);
    },

    get: async (id) => {
      const store = await requireStore();
      const plan = getPlan(store.db, id);
      return plan ? toPlan(plan) : null;
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

      if (input.status) {
        await notify(
          ctx,
          input.sessionID,
          `O usuário marcou o plano "${result.plan.title}" como ${statusLabel(input.status)}.`,
          result.plan.id,
          `${statusAction(input.status)} o plano "${result.plan.title}"`,
        );
      } else {
        await notify(
          ctx,
          input.sessionID,
          `O usuário atualizou o plano "${result.plan.title}".`,
          result.plan.id,
          `Atualizou o plano "${result.plan.title}"`,
        );
      }
      return fromWrite(result);
    },

    setStep: async (input) => {
      const store = await requireStore();
      const result = setStep(store.db, {
        id: input.id,
        stepID: input.stepID,
        done: input.done,
      });
      if (!result.ok) return fromWrite(result);

      const step = result.plan.steps.find((item) => item.step_id === input.stepID);
      const { done, total } = planProgress(result.plan);
      const stepText = step?.text ?? input.stepID;
      await notify(
        ctx,
        input.sessionID,
        `O usuário marcou o passo "${stepText}" como ${
          step?.status === "done" ? "concluído" : "pendente"
        } no plano "${result.plan.title}" (${done}/${total}).`,
        result.plan.id,
        `${step?.status === "done" ? "Concluiu" : "Reabriu"} o passo "${stepText}" (${done}/${total})`,
      );
      return fromWrite(result);
    },

    remove: async (input) => {
      const store = await requireStore();
      const result = deletePlan(store.db, input.id);
      if (!result.ok) return fromWrite(result);
      await notify(
        ctx,
        input.sessionID,
        `O usuário removeu o plano "${result.plan.title}".`,
        result.plan.id,
        `Removeu o plano "${result.plan.title}"`,
      );
      return fromWrite(result);
    },
  };
}
