/**
 * plans — tool definitions (registration lives in ./index.ts under the
 * "plans" namespace).
 *
 * In Code Mode these are callable as tools.plans.save / tools.plans.list /
 * ...; in regular sessions the effective names are plans_save,
 * plans_list, ... (`options.namespace` is what prefixes them).
 *
 * The tools talk to `plans.db` directly through `./src/store.ts` (the same
 * data layer as the side-panel GUI). There is no external CLI.
 */

import { Plugin } from "@opencode/plugin";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import { z } from "zod";
import {
  deletePlan,
  doctorInfo,
  getPlan,
  listPlans,
  renderDoctor,
  renderPlanFull,
  renderPlanSummary,
  requireStore,
  savePlan,
  setStep,
  updatePlan,
  type PlanStatus,
} from "./src/store.js";

type ToolResult = { content: string; metadata?: Record<string, unknown> };
type Ctx = Plugin.Context;

function fail(error: string): ToolResult {
  return { content: `❌ ${error}`, metadata: { rejected: true } };
}

const STATUS = z.enum(["active", "done", "archived", "superseded"]);

function projectID(ctx: Ctx): string {
  return String(ctx.location.project.id);
}

function projectDirectory(ctx: Ctx): string {
  return String(ctx.location.project.canonical ?? ctx.location.directory);
}

const saveInput = z.object({
  body: z
    .string()
    .min(1)
    .describe("Full plan Markdown, exactly as presented to the user. The body is persisted verbatim."),
  title: z
    .string()
    .optional()
    .describe("Short title. Derived from the first heading/line when omitted."),
  id: z
    .string()
    .optional()
    .describe("Existing plan id to update. Omit to create a new plan."),
  steps: z
    .array(z.string())
    .optional()
    .describe("Optional explicit step list. Derived from the body's checklist when omitted."),
});

const listInput = z.object({
  scope: z
    .enum(["session", "project"])
    .optional()
    .describe("'session' (default) lists only this session's plans; 'project' lists every session in this project."),
  status: z
    .union([STATUS, z.literal("all")])
    .optional()
    .describe("Filter by status. Defaults to active."),
  limit: z.number().int().min(1).max(200).optional().describe("Maximum plans. Defaults to 50."),
});

const getInput = z.object({
  id: z.string().min(1).describe("Plan id, as returned by plans.list or plans.save."),
  scope: z
    .enum(["session", "project"])
    .optional()
    .describe("'session' (default) only reads a plan of this session; 'project' allows another session's plan."),
});

const updateInput = z.object({
  id: z.string().min(1).describe("Plan id."),
  stepID: z
    .string()
    .optional()
    .describe("Step id (s1, s2, …) to mark. Use with stepStatus, or use position instead."),
  position: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Zero-based step position to mark when stepID is unknown."),
  stepStatus: z
    .enum(["todo", "doing", "done"])
    .optional()
    .describe("New step status. Mark 'doing' before starting a step and 'done' when finished."),
  status: STATUS.optional().describe("New plan status."),
  title: z.string().optional().describe("New title (rarely needed)."),
  body: z.string().optional().describe("Replacement plan Markdown (rarely needed)."),
});

const doctorInput = z.object({});

export function saveTool(ctx: Ctx) {
  return {
    name: "save",
    description:
      "Persist a plan for future sessions. Call this with the final plan markdown when you present an actionable plan. It creates a new plan by default; pass id to update an existing one. This only writes the plans database, never the repository.",
    input: saveInput,
    async execute(input: z.infer<typeof saveInput>, toolCtx: ToolContext): Promise<ToolResult> {
      try {
        const store = await requireStore();
        if (input.id) {
          const existing = getPlan(store.db, input.id);
          if (existing && existing.session_id !== String(toolCtx.sessionID)) {
            return fail("plano pertence a outra sessão; peça ao usuário para mover o plano no painel");
          }
        }
        const result = savePlan(store.db, {
          id: input.id,
          title: input.title,
          body: input.body,
          projectID: projectID(ctx),
          projectDirectory: projectDirectory(ctx),
          sessionID: String(toolCtx.sessionID),
          messageID: String(toolCtx.messageID),
          steps: input.steps?.map((text) => ({ text })),
        });
        if (!result.ok) return fail(result.error);
        return {
          content: [
            `Plano salvo: ${result.plan.title}`,
            renderPlanSummary(result.plan),
            `Use plans.get ${result.plan.id} para reler o plano completo.`,
          ].join("\n"),
          metadata: {
            planID: result.plan.id,
            status: result.plan.status,
            steps: result.plan.steps.length,
          },
        };
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function listTool(ctx: Ctx) {
  return {
    name: "list",
    description:
      "List persisted plans. Defaults to the current session only; use scope='project' to list every session in this project. Shows status and step progress. Use plans.get for the full plan before resuming work.",
    input: listInput,
    async execute(input: z.infer<typeof listInput>, toolCtx: ToolContext): Promise<ToolResult> {
      try {
        const store = await requireStore();
        const scope = input.scope ?? "session";
        const status = input.status ?? "active";
        const plans = listPlans(store.db, {
          projectID: projectID(ctx),
          sessionID: scope === "session" ? String(toolCtx.sessionID) : undefined,
          status: status as PlanStatus | "all",
          limit: input.limit ?? 50,
        });
        if (plans.length === 0) {
          return {
            content:
              scope === "session"
                ? status === "all"
                  ? "Nenhum plano nesta sessão. Use plans.save para persistir um plano."
                  : `Nenhum plano com status '${status}' nesta sessão. Use status='all' para ver todos.`
                : status === "all"
                  ? "Nenhum plano salvo neste projeto."
                  : `Nenhum plano com status '${status}' neste projeto. Use status='all' para ver todos.`,
            metadata: { count: 0, scope },
          };
        }
        const header = `Planos (${scope === "session" ? "sessão atual" : "projeto atual"}, status=${status}): ${plans.length}`;
        return {
          content: [
            header,
            ...plans.map((plan) =>
              scope === "project" ? `${renderPlanSummary(plan)} session=${plan.session_id}` : renderPlanSummary(plan),
            ),
            "",
            "Use plans.get <id> para ler o plano completo.",
          ].join("\n"),
          metadata: { count: plans.length, scope, planIDs: plans.map((plan) => plan.id) },
        };
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function getTool(ctx: Ctx) {
  return {
    name: "get",
    description:
      "Read one persisted plan in full: metadata, checklist and original Markdown. Defaults to plans of this session; pass scope='project' to read another session's plan.",
    input: getInput,
    async execute(input: z.infer<typeof getInput>, toolCtx: ToolContext): Promise<ToolResult> {
      try {
        const store = await requireStore();
        const plan = getPlan(store.db, input.id);
        if (!plan) return fail(`plano não encontrado: ${input.id}`);
        if (input.scope !== "project" && plan.session_id !== String(toolCtx.sessionID)) {
          return fail("plano pertence a outra sessão; use scope='project' para leitura ou mova o plano no painel");
        }
        return {
          content: renderPlanFull(plan),
          metadata: { planID: plan.id, status: plan.status, steps: plan.steps.length },
        };
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function updateTool(ctx: Ctx) {
  return {
    name: "update",
    description:
      "Update a persisted plan: mark a step todo/doing/done (stepID or position + stepStatus) and/or change the plan status. Mark 'doing' before starting a step and 'done' when finished, so the user's panel shows where you stopped. Only one step per plan can be 'doing'.",
    input: updateInput,
    async execute(input: z.infer<typeof updateInput>, toolCtx: ToolContext): Promise<ToolResult> {
      try {
        const store = await requireStore();
        const plan = getPlan(store.db, input.id);
        if (!plan) return fail(`plano não encontrado: ${input.id}`);
        if (plan.session_id !== String(toolCtx.sessionID)) {
          return fail("plano pertence a outra sessão; peça ao usuário para mover o plano no painel");
        }

        const hasStep = input.stepID !== undefined || input.position !== undefined;
        const hasPlanChange =
          input.status !== undefined || input.title !== undefined || input.body !== undefined;
        if (hasStep && input.stepStatus === undefined) {
          return fail("informe stepStatus ('todo' | 'doing' | 'done') junto com stepID/position");
        }
        if (!hasStep && !hasPlanChange) {
          return fail("informe stepID/position + stepStatus ou status/title/body");
        }

        let result = hasStep
          ? setStep(store.db, {
              id: input.id,
              stepID: input.stepID,
              position: input.position,
              status: input.stepStatus!,
            })
          : updatePlan(store.db, { id: input.id });

        if (!result.ok) return fail(result.error);

        if (hasPlanChange) {
          result = updatePlan(store.db, {
            id: input.id,
            status: input.status,
            title: input.title,
            body: input.body,
          });
          if (!result.ok) return fail(result.error);
        }

        return {
          content: [
            `Plano atualizado: ${result.plan.title}`,
            renderPlanSummary(result.plan),
          ].join("\n"),
          metadata: {
            planID: result.plan.id,
            status: result.plan.status,
            steps: result.plan.steps.length,
          },
        };
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function doctorTool(ctx: Ctx) {
  return {
    name: "doctor",
    description:
      "Diagnose the plans subsystem: database path, schema version, plan/step counts. Use it when plans seem missing.",
    input: doctorInput,
    async execute(): Promise<ToolResult> {
      try {
        const store = await requireStore();
        const info = doctorInfo(store);
        return { content: renderDoctor(info), metadata: { ...info } };
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function deleteTool(ctx: Ctx) {
  return {
    name: "delete",
    description: "Permanently delete a persisted plan and its steps. Prefer plans.update with status='archived' unless the user asked to delete it.",
    input: z.object({ id: z.string().min(1) }),
    async execute(input: { id: string }, toolCtx: ToolContext): Promise<ToolResult> {
      try {
        const store = await requireStore();
        const plan = getPlan(store.db, input.id);
        if (!plan) return fail(`plano não encontrado: ${input.id}`);
        if (plan.session_id !== String(toolCtx.sessionID)) {
          return fail("plano pertence a outra sessão; peça ao usuário para mover o plano no painel");
        }
        const result = deletePlan(store.db, input.id);
        if (!result.ok) return fail(result.error);
        return {
          content: `Plano removido: ${result.plan.title} (${result.plan.id})`,
          metadata: { planID: result.plan.id, deleted: true },
        };
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
