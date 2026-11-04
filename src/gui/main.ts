/**
 * Plans GUI — main-process data layer (the `plans` IPC provider).
 *
 * All database work lives in `../store.ts`, shared with the `plans.*` server
 * tools. This module only maps rows to the IPC shapes declared in
 * `./contract.ts` and exposes them through `ctx.provide`.
 */

import type { MainContext } from "@opencode/plugin/gui/main";
import { PlansApi } from "./contract";
import type { Plan, PlanResult, PlanStatus, RemoveInput, Status } from "./contract";
import {
  deletePlan,
  getPlan,
  getStore,
  listPlans,
  planProgress,
  plansDbPath,
  schemaVersion,
  setStep,
  updatePlan,
  requireStore,
  type Plan as StorePlan,
} from "../store.js";

const toPlan = (plan: StorePlan): Plan => ({
  id: plan.id,
  projectID: plan.project_id,
  projectDirectory: plan.project_directory,
  sessionID: plan.session_id,
  messageID: plan.message_id ?? undefined,
  title: plan.title,
  body: plan.body,
  status: plan.status,
  createdAt: plan.created_at,
  updatedAt: plan.updated_at,
  completedAt: plan.completed_at ?? undefined,
  steps: plan.steps.map((step) => ({
    id: step.step_id,
    position: step.position,
    text: step.text,
    status: step.status,
  })),
});

const statusLabel = (status: PlanStatus): string => {
  switch (status) {
    case "done":
      return "concluído";
    case "abandoned":
      return "arquivado";
    case "superseded":
      return "substituído";
    default:
      return "reaberto";
  }
};

/**
 * Tell the session that the user changed a plan from the panel. The message is
 * synthetic and does not resume the agent: it lands in the timeline and in the
 * next model request, where the plans context already reflects the new state.
 */
async function notify(
  ctx: MainContext,
  sessionID: string | undefined,
  text: string,
  planID: string,
): Promise<void> {
  if (!sessionID) return;
  try {
    await ctx.client.session.synthetic({
      sessionID,
      text,
      description: "Painel Planos",
      resume: false,
      metadata: { source: "plans", planID },
    });
  } catch (error) {
    ctx.log.write("warn", "plans: could not notify the session", {
      sessionID,
      planID,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function main(ctx: MainContext): void {
  ctx.provide(PlansApi, {
    status: async (): Promise<Status> => {
      const { store, reason } = await getStore();
      return {
        driver: store ? "sqlite" : "none",
        dbPath: plansDbPath(),
        version: store ? schemaVersion(store.db) : 0,
        error: reason || undefined,
      };
    },

    list: async (options): Promise<Plan[]> => {
      const { db } = await requireStore();
      return listPlans(db, {
        projectID: options.projectID,
        status: options.status,
        limit: options.limit,
      }).map(toPlan);
    },

    get: async (id): Promise<Plan | undefined> => {
      const { db } = await requireStore();
      const plan = getPlan(db, id);
      return plan ? toPlan(plan) : undefined;
    },

    update: async (input): Promise<PlanResult> => {
      const { db } = await requireStore();
      const result = updatePlan(db, {
        id: input.id,
        status: input.status,
        title: input.title,
        body: input.body,
      });
      if (!result.ok) return { ok: false, error: result.error };
      if (input.status) {
        await notify(
          ctx,
          input.sessionID,
          `O usuário marcou o plano "${result.plan.title}" como ${statusLabel(input.status)}.`,
          result.plan.id,
        );
      } else {
        await notify(ctx, input.sessionID, `O usuário atualizou o plano "${result.plan.title}".`, result.plan.id);
      }
      return { ok: true, plan: toPlan(result.plan) };
    },

    setStep: async (input): Promise<PlanResult> => {
      const { db } = await requireStore();
      const result = setStep(db, {
        id: input.id,
        stepID: input.stepID,
        done: input.done,
      });
      if (!result.ok) return { ok: false, error: result.error };
      const step = result.plan.steps.find((item) => item.step_id === input.stepID);
      const { done, total } = planProgress(result.plan);
      await notify(
        ctx,
        input.sessionID,
        `O usuário marcou o passo "${step?.text ?? input.stepID}" como ${
          step?.status === "done" ? "concluído" : "pendente"
        } no plano "${result.plan.title}" (${done}/${total}).`,
        result.plan.id,
      );
      return { ok: true, plan: toPlan(result.plan) };
    },

    remove: async (input: RemoveInput): Promise<PlanResult> => {
      const { db } = await requireStore();
      const result = deletePlan(db, input.id);
      if (!result.ok) return { ok: false, error: result.error };
      await notify(ctx, input.sessionID, `O usuário removeu o plano "${result.plan.title}".`, result.plan.id);
      return { ok: true, plan: toPlan(result.plan) };
    },
  });
}
