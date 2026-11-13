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
import {
  appendTailBlock,
  hasCompaction,
  pushRoutingRule,
  renderPlanContext,
  type InjectMessage,
} from "./src/inject.js";
import { deleteTool, doctorTool, getTool, listTool, saveTool, updateTool } from "./plans.js";
import { PlansRpc } from "./src/gui/contract.js";
import { notificationLocale, tn, type NotificationLocale } from "./src/notifications.js";
import { onPlanChange } from "./src/plan-events.js";
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

/** Sessions compacted since their last injected plan block (one-shot per compaction). */
const compactedSessions = new Set<string>();

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

/**
 * Two layers, one cache rule: the routing rule is constant and re-pushed on
 * every request, so the head of the prompt stays byte-identical; the plan
 * block is dynamic, so it only goes to the tail after a compaction, when the
 * plan text is no longer in the conversation.
 */
async function onContext(ctx: Ctx, event: SessionContext) {
  // Outside the try/catch: a broken database must not drop the rule.
  pushRoutingRule(event.system);

  if (String(event.agent) === "plan") return;
  try {
    const messages = event.messages as InjectMessage[];
    const last = messages.at(-1);
    const structural = hasCompaction(messages);
    const flagged = compactedSessions.has(String(event.sessionID));
    // The compaction hook fires for the summarization request itself; that
    // request has no conversation tail, and injecting there would put the plan
    // into the summary. Keep the flag for the request that resumes the session.
    if (!structural && !flagged) return;
    if (flagged && (last?.role !== "user" && last?.role !== "tool")) return;
    // One-shot per compaction: consume the flag on the request that resumes the
    // session, even if there is no active plan to inject right now.
    if (flagged) compactedSessions.delete(String(event.sessionID));

    // Subagents work on a slice of the parent's task; keep their context lean.
    const session = await ctx.session.get({ sessionID: event.sessionID });
    if (session.parentID) return;

    const sessionID = String(event.sessionID);
    const store = await requireStore();
    const plans = listPlans(store.db, {
      projectID: projectID(ctx),
      sessionID,
      status: "active",
      limit: 5,
    });
    if (plans.length === 0) return;

    const sessionPlan = plans.find((plan) => plan.session_id === sessionID) ?? plans[0];
    if (!sessionPlan) return;
    const text = renderPlanContext(sessionPlan);
    if (text) appendTailBlock(messages, text);
  } catch (error) {
    console.error(`[plans] context injection failed: ${errorText(error)}`);
  }
}

export default Plugin.define({
  id: "plans",
  async setup(ctx) {
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
      ctx.session.hook("compaction", (event) => {
        compactedSessions.add(String(event.sessionID));
      }),
      ctx.session.hook("context", (event) => onContext(ctx, event)),
    ]);
    registrations.push(rpcRegistration);

    return async () => {
      offPlanChange();
      for (const registration of registrations) {
        await registration.dispose().catch(() => undefined);
      }
    };
  },
});
