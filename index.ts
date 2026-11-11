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
import { insertPlanExemption, PLAN_SAVE_INSTRUCTION, renderBuildContext } from "./src/inject.js";
import { deleteTool, doctorTool, getTool, listTool, saveTool, updateTool } from "./plans.js";
import { PlansRpc } from "./src/gui/contract.js";
import { notificationLocale, tn, type NotificationLocale } from "./src/notifications.js";
import { onPlanChange } from "./src/plan-events.js";
import { createRpcHandlers } from "./src/rpc.js";
import { claimSaveNudge, planAlreadySaved, saveNudgeKey } from "./src/save-guard.js";
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

/**
 * The server context has no locale of its own; the GUI writes the current
 * interface locale to storage, and anything unknown falls back to EN-US.
 */
async function commandLocale(ctx: Ctx): Promise<NotificationLocale> {
  try {
    return notificationLocale((await ctx.storage.get("locale")) as string | null | undefined);
  } catch {
    return "en-us";
  }
}

export async function registerTools(ctx: Ctx) {
  return ctx.tool.transform((editor) => {
    // editor.namespace() only labels the catalog group; the per-tool
    // options.namespace is what actually prefixes the qualified name
    // (tools.plans.*) in Code Mode.
    editor.namespace({
      name: "plans",
      description:
        "Persisted plans: save a final plan, list or read the active ones, and track steps with plans.update. Backed by a dedicated SQLite plans.db.",
    });
    // Add each tool separately so TypeScript keeps its input schema.
    // `pinned` keeps the essential tools visible in the Code Mode catalog even
    // when the per-namespace budget would otherwise drop their signatures.
    editor.add({ ...saveTool(ctx), options: { namespace: "plans", pinned: true } });
    editor.add({ ...listTool(ctx), options: { namespace: "plans", pinned: true } });
    editor.add({ ...getTool(ctx), options: { namespace: "plans", pinned: true } });
    editor.add({ ...updateTool(ctx), options: { namespace: "plans", pinned: true } });
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
        const locale = await commandLocale(ctx);
        try {
          const messages = await ctx.session.context({ sessionID });
          const captured = findLastPlanMessage(messages as unknown as SessionMessageLike[], {
            requireSteps: true,
          });
          if (!captured) {
            await ctx.session.synthetic({
              sessionID,
              text: tn(locale, "save.none"),
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
              text: tn(locale, "save.failed", result.error),
            });
            return;
          }

          const progress = planProgress(result.plan);
          await ctx.session.synthetic({
            sessionID,
            text: [
              tn(locale, "save.saved", result.plan.title),
              tn(locale, "save.id", result.plan.id),
              tn(locale, "save.progress", progress.done, progress.total),
            ].join("\n"),
          });
        } catch (error) {
          await ctx.session.synthetic({
            sessionID,
            text: tn(locale, "save.failed", errorText(error)),
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
      insertPlanExemption(event.messages);
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

/**
 * After a Plan-agent turn, nudge it once when it presented a plan with steps
 * but did not persist it. This is a nudge, never an automatic save.
 */
async function runSaveGuard(ctx: Ctx, signal: AbortSignal) {
  try {
    for await (const event of ctx.event.subscribe({
      types: ["session.execution.succeeded"],
      signal,
    })) {
      if (event.type !== "session.execution.succeeded") continue;
      const sessionID = String(event.data.sessionID);
      try {
        const session = await ctx.session.get({ sessionID });
        if (String(session.agent ?? "") !== "plan") continue;
        const messages = await ctx.session.context({ sessionID });
        const captured = findLastPlanMessage(messages as unknown as SessionMessageLike[], {
          requireSteps: true,
        });
        if (!captured?.messageID) continue;
        // Claim synchronously before any further await so concurrent events
        // (or a new guard instance after a reload) cannot double-nudge.
        if (!claimSaveNudge(captured.messageID)) continue;
        const store = await requireStore();
        if (planAlreadySaved(store, sessionID, captured)) continue;
        const key = saveNudgeKey(captured.messageID);
        if ((await ctx.storage.get(key)) !== undefined) continue;
        await ctx.storage.set(key, true);
        const locale = await commandLocale(ctx);
        await ctx.session.synthetic({
          sessionID: sessionID as never,
          text: tn(locale, "plan.nudge"),
          description: tn(locale, "plan.nudge.action"),
          resume: true,
          metadata: { source: "plans", kind: "save-nudge", messageID: captured.messageID },
        });
        console.info("[plans] save nudge injected", {
          sessionID,
          messageID: captured.messageID,
        });
      } catch (error) {
        console.error(`[plans] save guard failed: ${errorText(error)}`);
      }
    }
  } catch (error) {
    if (!signal.aborted) console.error(`[plans] save guard stopped: ${errorText(error)}`);
  }
}

export default Plugin.define({
  id: "plans",
  async setup(ctx) {
    const guardController = new AbortController();
    const guard = runSaveGuard(ctx, guardController.signal);
    // Registered first: tool and RPC writes publish through its `changed`
    // event, and the bus listener must exist before anything can write.
    const rpcRegistration = await ctx.rpc.register(PlansRpc, createRpcHandlers(ctx));
    const offPlanChange = onPlanChange((change) => {
      void rpcRegistration.events.emit("changed", change).catch((error: unknown) => {
        console.error(`[plans] could not emit plan change: ${errorText(error)}`);
      });
    });
    const registrations = await Promise.all([
      registerTools(ctx),
      registerCommand(ctx),
      ctx.session.hook("context", (event) => injectContext(ctx, event)),
    ]);
    registrations.push(rpcRegistration);

    return async () => {
      offPlanChange();
      guardController.abort();
      await guard.catch(() => undefined);
      for (const registration of registrations) {
        await registration.dispose().catch(() => undefined);
      }
    };
  },
});
