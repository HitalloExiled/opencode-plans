/**
 * plans plugin — persisted plans from Plan mode under the "plans" namespace,
 * plus a desktop side panel.
 *
 * - Code Mode: tools.plans.save / tools.plans.list / ...
 * - Regular sessions: plans_save / plans_list / ...
 * - GUI: the "Planos" side panel in the desktop app, over the same SQLite DB.
 *
 * Capture is explicit only: `plans.save` from the agent, `/save-plan` from
 * the user, or the panel button (which runs the same command). There is no
 * heuristic capture of every Plan response.
 */

import { Plugin } from "@opencode/plugin";
import type { SessionContext } from "@opencode/plugin/promise/session";
import { findLastPlanMessage, type SessionMessageLike } from "./src/capture.js";
import { PLAN_SAVE_INSTRUCTION, renderBuildContext } from "./src/inject.js";
import { deleteTool, doctorTool, getTool, listTool, saveTool, updateTool } from "./plans.js";
import { PlansRpc } from "./src/gui/contract.js";
import { createRpcHandlers } from "./src/rpc.js";
import { listPlans, planProgress, requireStore, savePlan } from "./src/store.js";

type Ctx = Plugin.Context;

function projectID(ctx: Ctx): string {
  return String(ctx.location.project.id);
}

function projectDirectory(ctx: Ctx): string {
  return String(ctx.location.project.canonical ?? ctx.location.directory);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function registerTools(ctx: Ctx) {
  return ctx.tool.transform((editor) => {
    // editor.namespace() only labels the catalog group; the per-tool
    // options.namespace is what actually prefixes the qualified name
    // (tools.plans.*) in Code Mode.
    editor.namespace({
      name: "plans",
      description:
        "Persisted plans from Plan mode: save a plan for future sessions, list/read active plans, and mark steps done as work completes. Backed by a dedicated SQLite plans.db. Use plans.list/get before resuming long-running work, and plans.update as you finish each step.",
    });
    // Add each tool separately so TypeScript keeps its input schema.
    editor.add({ ...saveTool(ctx), options: { namespace: "plans" } });
    editor.add({ ...listTool(ctx), options: { namespace: "plans" } });
    editor.add({ ...getTool(ctx), options: { namespace: "plans" } });
    editor.add({ ...updateTool(ctx), options: { namespace: "plans" } });
    editor.add({ ...deleteTool(ctx), options: { namespace: "plans" } });
    editor.add({ ...doctorTool(ctx), options: { namespace: "plans" } });
  });
}

async function registerCommand(ctx: Ctx) {
  return ctx.command.transform((editor) => {
    editor.add({
      name: "save-plan",
      description: "Salva o último plano apresentado pelo agente Plan nesta sessão",
      async execute({ sessionID, prompt }) {
        try {
          const messages = await ctx.session.context({ sessionID });
          const captured = findLastPlanMessage(messages as unknown as SessionMessageLike[]);
          if (!captured) {
            await ctx.session.synthetic({
              sessionID,
              text: "Nenhum plano do agente Plan foi encontrado nesta sessão. Gere um plano no modo Plan e tente novamente.",
            });
            return;
          }

          const store = await requireStore();
          const result = savePlan(store.db, {
            body: captured.body,
            title: prompt.text?.trim() || undefined,
            projectID: projectID(ctx),
            projectDirectory: projectDirectory(ctx),
            sessionID: String(sessionID),
            messageID: captured.messageID,
          });

          if (!result.ok) {
            await ctx.session.synthetic({
              sessionID,
              text: `Falha ao salvar o plano: ${result.error}`,
            });
            return;
          }

          const progress = planProgress(result.plan);
          await ctx.session.synthetic({
            sessionID,
            text: [
              `Plano salvo: ${result.plan.title}`,
              `id: ${result.plan.id}`,
              `${progress.done}/${progress.total} passos concluídos`,
            ].join("\n"),
          });
        } catch (error) {
          await ctx.session.synthetic({
            sessionID,
            text: `Falha ao salvar o plano: ${errorText(error)}`,
          }).catch(() => undefined);
        }
      },
    });
  });
}

async function injectContext(ctx: Ctx, event: SessionContext) {
  try {
    const store = await requireStore();
    const isPlan = String(event.agent) === "plan";

    if (isPlan) {
      event.system.push({ type: "text", text: PLAN_SAVE_INSTRUCTION });
      return;
    }

    // Subagents work on a slice of the parent's task; keep their context lean.
    const session = await ctx.session.get({ sessionID: event.sessionID });
    if (session.parentID) return;

    const sessionID = String(event.sessionID);
    const plans = listPlans(store.db, {
      projectID: projectID(ctx),
      sessionID,
      status: "active",
      limit: 5,
    });
    if (plans.length === 0) return;

    const sessionPlan = plans.find((plan) => plan.session_id === sessionID) ?? plans[0];
    const text = renderBuildContext(plans, sessionPlan);
    if (text) event.system.push({ type: "text", text });
  } catch (error) {
    console.error(`[plans] context injection failed: ${errorText(error)}`);
  }
}

export default Plugin.define({
  id: "plans",
  async setup(ctx) {
    const registrations = await Promise.all([
      registerTools(ctx),
      registerCommand(ctx),
      ctx.rpc.register(PlansRpc, createRpcHandlers(ctx)),
      ctx.session.hook("context", (event) => injectContext(ctx, event)),
    ]);

    return async () => {
      for (const registration of registrations) {
        await registration.dispose().catch(() => undefined);
      }
    };
  },
});
