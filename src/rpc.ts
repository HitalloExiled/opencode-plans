/**
 * Server-side RPC handlers for the Plans panel.
 *
 * The desktop window calls these methods through the server that runs the
 * plugin, so the same hot-reloaded process that owns `plans.db` also serves
 * the panel. No GUI main-process copy of the schema is involved.
 */

import type { Plugin } from "@opencode/plugin";
import type { RpcHandlers } from "@opencode/plugin/promise/rpc";
import { PlansRpc, type Plan, type PlanResult, type Status } from "./gui/contract.js";
import { notificationLocale, tn } from "./notifications.js";
import {
  deletePlan,
  getPlan,
  getStore,
  listPlans,
  movePlan,
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
        projectID: String(ctx.location.project.id),
        sessionID: scope === "session" ? sessionID : undefined,
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

      const result = movePlan(store.db, input.id, input.sessionID);
      if (!result.ok) return fromWrite(result);
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
  };
}
