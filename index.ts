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
import { Tool } from "@opencode/schema/tool";
import { findLastPlanMessage, type SessionMessageLike } from "./src/capture.js";
import {
  appendTailBlock,
  appendWorkItemsBlock,
  hasCompaction,
  PLANS_FLOW_OPEN,
  plansFlowBlock,
  pushRoutingRule,
  renderPlanContext,
  renderWorkItemsContext,
  WORK_ITEMS_OPEN,
  type InjectMessage,
} from "./src/inject.js";
import { PLANS_NAMESPACE, deleteTool, doctorTool, getTool, linkTool, listTool, saveTool, updateTool } from "./plans.js";
import { INITIATIVE_NAMESPACE, createInitiativeTool, getInitiativeTool, listInitiativeTool } from "./initiative.js";
import { WORK_NAMESPACE, getWorkTool, listWorkTool, saveWorkTool, updateWorkTool } from "./work.js";
import { MERGE_NAMESPACE, mergeDoneTool, mergeFailTool, mergeListTool, mergeNextTool } from "./merge.js";
import { registerAgents } from "./src/agents.js";
import { getFlow } from "./src/flow.js";
import { planMessageAgents } from "./src/flow-rules.js";
import { applyPlanReminder } from "./src/plan-reminder.js";
import { PlansRpc } from "./src/gui/contract.js";
import { notificationLocale, tn, type NotificationLocale } from "./src/notifications.js";
import { emitPlanChange, onPlanChange } from "./src/plan-events.js";
import { createRpcHandlers } from "./src/rpc.js";
import { recoverRuns } from "./src/run-engine.js";
import { isFreshProcess } from "./src/runtime-pid.js";
import {
  getPlanByWorkItem,
  getWorkItem,
  listPlans,
  listWorkItems,
  planProgress,
  requireStore,
  resolveInitiative,
  savePlan,
  type Store,
} from "./src/store.js";
import { captureWorkItem } from "./src/work-capture.js";

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
    editor.namespace(PLANS_NAMESPACE);
    // Add each tool separately so TypeScript keeps its input schema.
    // `pinned` keeps the essential tools visible in the Code Mode catalog even
    // when the per-namespace budget would otherwise drop their signatures.
    editor.add({ ...saveTool(ctx), options: { namespace: "plans", pinned: true } });
    editor.add({ ...listTool(ctx), options: { namespace: "plans", pinned: true } });
    editor.add({ ...getTool(ctx), options: { namespace: "plans", pinned: true } });
    editor.add({ ...updateTool(ctx), options: { namespace: "plans", pinned: true } });
    editor.add({ ...linkTool(ctx), options: { namespace: "plans", pinned: true } });
    editor.add({ ...deleteTool(ctx), options: { namespace: "plans" } });
    editor.add({ ...doctorTool(ctx), options: { namespace: "plans" } });

    // Initiatives group the needs across repositories. The agent creates and
    // lists them; renaming and the description stay in the panel.
    editor.namespace(INITIATIVE_NAMESPACE);
    editor.add({ ...listInitiativeTool(ctx), options: { namespace: "initiative", pinned: true } });
    editor.add({ ...getInitiativeTool(ctx), options: { namespace: "initiative", pinned: true } });
    editor.add({ ...createInitiativeTool(ctx), options: { namespace: "initiative", pinned: true } });

    // Work items are the needs; plans are the how. A separate group keeps the
    // backlog tools out of the plan catalog budget.
    editor.namespace(WORK_NAMESPACE);
    editor.add({ ...listWorkTool(ctx), options: { namespace: "work", pinned: true } });
    editor.add({ ...getWorkTool(ctx), options: { namespace: "work", pinned: true } });
    editor.add({ ...saveWorkTool(ctx), options: { namespace: "work", pinned: true } });
    editor.add({ ...updateWorkTool(ctx), options: { namespace: "work", pinned: true } });

    // The merge session's tools: it is the only writer of the integration.
    editor.namespace(MERGE_NAMESPACE);
    editor.add({ ...mergeListTool(ctx), options: { namespace: "merge", pinned: true } });
    editor.add({ ...mergeNextTool(ctx), options: { namespace: "merge", pinned: true } });
    editor.add({ ...mergeDoneTool(ctx), options: { namespace: "merge", pinned: true } });
    editor.add({ ...mergeFailTool(ctx), options: { namespace: "merge", pinned: true } });
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
          // Native flow captures only the Plan agent, exactly like before the
          // dedicated agents existed; dedicated also accepts the planner.
          const captured = findLastPlanMessage(messages as unknown as SessionMessageLike[], {
            requireSteps: true,
            agents: planMessageAgents(getFlow()),
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

    editor.add({
      name: "work",
      description: "Cria um work item a partir de uma frase (título)",
      async execute({ sessionID, prompt }) {
        const locale = await commandLocale(ctx);
        const title = (prompt.text ?? "").trim();
        if (!title) {
          await ctx.session.synthetic({ sessionID, text: tn(locale, "work.titleRequired") });
          return;
        }

        try {
          const session = await ctx.session.get({ sessionID });
          const store = await requireStore();
          const result = captureWorkItem(store.db, {
            directory: String(session.location.directory),
            title,
          });
          if (!result.ok) {
            await ctx.session.synthetic({
              sessionID,
              text: tn(locale, "work.failed", result.error),
            });
            return;
          }

          emitPlanChange({ sessionID: String(sessionID) });
          await ctx.session.synthetic({
            sessionID,
            text: [
              tn(locale, "work.created", result.item.title),
              tn(locale, "work.project", result.initiative.name),
              tn(locale, "work.id", result.item.id),
            ].join("\n"),
          });
        } catch (error) {
          await ctx.session.synthetic({
            sessionID,
            text: tn(locale, "work.failed", errorText(error)),
          }).catch(() => undefined);
        }
      },
    });
  });
}

/** Executing agents get the backlog only after a compaction: the prompt is the plan. */
const EXECUTING_AGENTS = new Set(["build", "executor"]);

/** Tools whose permission denial Plan rewrites into a Plan-directory message. */
const PLAN_EDIT_TOOLS = new Set(["edit", "write", "patch"]);

/** The core's Plan plugin only rewrites denials, not arbitrary failures. */
function isPermissionBlocked(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { _tag?: unknown })._tag === "Permission.BlockedError"
  );
}

/**
 * Plan's `tool.hook` shape, kept as a safety net.
 *
 * With `edit * deny` and no allow rule the runtime hides edit/write/patch from
 * the planner's catalog (`whollyDisabled`), so no call reaches this hook today;
 * it fires again if a path is ever re-allowed. The message is flow-accurate:
 * "outside the Plan directory" would be false for every path. Dedicated flow
 * only; the core already handles the native Plan.
 */
async function registerPlanToolHook(ctx: Ctx) {
  return ctx.tool.hook("execute.after", (event) => {
    if (getFlow() !== "dedicated") return;
    if (String(event.agent) !== "planner") return;
    if (event.status !== "error") return;
    if (!PLAN_EDIT_TOOLS.has(event.tool)) return;
    if (!isPermissionBlocked(event.error.error)) return;
    event.error = new Tool.Error({
      message: `Cannot use ${event.tool} to modify files: the plans flow is read-only; save the plan with plans.save.`,
    });
  });
}

/** The tail list for the session's project: open items and their plans. */
function workItemsText(store: Store, directory: string): string | undefined {
  const resolved = resolveInitiative(store.db, directory);
  if (!resolved) return undefined;
  const items = listWorkItems(store.db, resolved.initiative.id);
  const plans = new Map<string, NonNullable<ReturnType<typeof getPlanByWorkItem>>>();
  for (const item of items) {
    const plan = getPlanByWorkItem(store.db, item.id);
    if (plan) plans.set(item.id, plan);
  }
  return renderWorkItemsContext(items, resolved.initiative.name, plans) || undefined;
}

/**
 * Two layers, one cache rule: the routing rule is constant and re-pushed on
 * every request, so the head of the prompt stays byte-identical; the plan
 * block is dynamic, so it only goes to the tail after a compaction, when the
 * plan text is no longer in the conversation.
 */
async function onContext(ctx: Ctx, event: SessionContext) {
  const agent = String(event.agent);
  const dedicated = getFlow() === "dedicated";
  // Outside the try/catch: a broken database must not drop the rule. The rule
  // is constant and goes to every agent, exactly like the native flow: the
  // planner/executor clone Plan/Build, so their system must match too.
  pushRoutingRule(event.system);

  // The backlog list is dynamic, so it rides the tail, never the system. Every
  // planning agent (the native Plan included) gets it each turn; an executor
  // only after a compaction, so its prompt stays the plan.
  try {
    if (!EXECUTING_AGENTS.has(agent)) {
      const store = await requireStore();
      const text = workItemsText(store, projectDirectory(ctx));
      if (text) appendWorkItemsBlock(event.messages as InjectMessage[], text);
    }
  } catch (error) {
    console.error(`[plans] work items injection failed: ${errorText(error)}`);
  }

  if (agent === "plan") return;
  try {
    const messages = event.messages as InjectMessage[];
    const last = messages.at(-1);
    // The dedicated flow replicates Plan mode for the planner: the same
    // reminder the core injects before the prompt, reconciled per request so a
    // compaction or revert cannot strip it.
    //
    // It is deliberately NOT persisted as a synthetic message. The text is
    // byte-identical to the core's, so a persisted copy is indistinguishable
    // from Plan's own reminder; the core's reconciler would then treat it as
    // stale for any agent other than `plan` and append `leave` on every
    // request, which our hook would answer with `enter` again — an endless
    // enter/leave ping-pong. Splicing per request gives the model the same
    // bytes without leaving a copy the core can fight.
    if (dedicated) {
      applyPlanReminder(messages, agent);
      // The extension rides the tail too: the Plan/Build clone stays byte
      // identical, only the new bytes are appended.
      const flowBlock = plansFlowBlock(agent);
      if (flowBlock) appendTailBlock(messages, flowBlock, PLANS_FLOW_OPEN);
    }
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

    // After a compaction the list may be gone from the conversation; the
    // executor included, this is where it comes back.
    const itemsText = workItemsText(store, projectDirectory(ctx));
    if (itemsText) appendTailBlock(messages, itemsText, WORK_ITEMS_OPEN);

    const plans = listPlans(store.db, {
      projectID: projectID(ctx),
      sessionID,
      status: "active",
      limit: 5,
    });
    if (plans.length === 0) return;

    const sessionPlan = plans.find((plan) => plan.session_id === sessionID) ?? plans[0];
    if (!sessionPlan) return;
    const linked = sessionPlan.work_item_id ? getWorkItem(store.db, sessionPlan.work_item_id) : undefined;
    const text = renderPlanContext(
      sessionPlan,
      linked ? { id: linked.id, title: linked.title } : undefined,
    );
    if (text) appendTailBlock(messages, text);
  } catch (error) {
    console.error(`[plans] context injection failed: ${errorText(error)}`);
  }
}

export default Plugin.define({
  id: "plans",
  async setup(ctx) {
    // A run never resumes on its own: running -> interrupted, in-flight merges
    // back to the queue. Only a real restart recovers: a hot reload keeps the
    // same pid and its promises are still alive, so the run must survive it.
    try {
      const store = await requireStore();
      if (isFreshProcess()) recoverRuns(store.db);
    } catch (error) {
      console.error(`[plans] could not recover runs: ${errorText(error)}`);
    }

    // Registered first: tool and RPC writes publish through its `changed`
    // event, and the bus listener must exist before anything can write.
    const rpcRegistration = await ctx.rpc.register(PlansRpc, createRpcHandlers(ctx));
    const offPlanChange = onPlanChange((change) => {
      void rpcRegistration.events.emit("changed", change).catch((error: unknown) => {
        console.error(`[plans] could not emit plan change: ${errorText(error)}`);
      });
    });
    const agentRegistration = await registerAgents(ctx);
    const registrations = await Promise.all([
      registerTools(ctx),
      registerCommand(ctx),
      registerPlanToolHook(ctx),
      ctx.session.hook("compaction", (event) => {
        compactedSessions.add(String(event.sessionID));
      }),
      ctx.session.hook("context", (event) => onContext(ctx, event)),
    ]);
    registrations.push(rpcRegistration, agentRegistration);

    return async () => {
      offPlanChange();
      for (const registration of registrations) {
        await registration.dispose().catch(() => undefined);
      }
    };
  },
});
