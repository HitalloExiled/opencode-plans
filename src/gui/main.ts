/**
 * Plans GUI — main-process data layer (the `plans` IPC provider).
 *
 * All database work lives in `../store.ts`, shared with the `plans.*` server
 * tools. This module only maps rows to the IPC shapes declared in
 * `./contract.ts` and exposes them through `ctx.provide`.
 */

import type { MainContext } from "@opencode/plugin/gui/main";
import { PlansApi } from "./contract";
import type { Plan, PlanResult, Status } from "./contract";
import {
  deletePlan,
  getPlan,
  getStore,
  listPlans,
  plansDbPath,
  schemaVersion,
  setStep,
  updatePlan,
  requireStore,
  type Plan as StorePlan,
  type SaveOk,
  type WriteError,
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

const fromWrite = (result: SaveOk | WriteError): PlanResult =>
  result.ok ? { ok: true, plan: toPlan(result.plan) } : { ok: false, error: result.error };

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
      return fromWrite(
        updatePlan(db, {
          id: input.id,
          status: input.status,
          title: input.title,
          body: input.body,
        }),
      );
    },

    setStep: async (input): Promise<PlanResult> => {
      const { db } = await requireStore();
      return fromWrite(
        setStep(db, {
          id: input.id,
          stepID: input.stepID,
          done: input.done,
        }),
      );
    },

    remove: async (id): Promise<PlanResult> => {
      const { db } = await requireStore();
      return fromWrite(deletePlan(db, id));
    },
  });
}
