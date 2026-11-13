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
  parseSteps,
  renderDoctor,
  renderPlanFull,
  renderPlanSummary,
  requireStore,
  savePlan,
  setStep,
  updatePlan,
  type PlanStatus,
} from "./src/store.js";
import { normalizeStepText } from "./src/plan-body.js";
import { emitPlanChange } from "./src/plan-events.js";

type ToolResult = { content: string; metadata?: Record<string, unknown> };
type Ctx = Plugin.Context;

/** Catalog group label. Code Mode truncates this at ~119 characters. */
export const PLANS_NAMESPACE = {
  name: "plans",
  description:
    "Persisted plans: save, list, read and track steps in a dedicated plans.db.",
} as const;

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
    .describe("Full markdown; steps in '## Passos'."),
  title: z
    .string()
    .optional()
    .describe("Short title; defaults to first heading."),
  id: z
    .string()
    .optional()
    .describe("Id to replace; omit to create."),
  steps: z
    .array(z.string())
    .optional()
    .describe("Explicit steps; else parsed from body."),
});

const listInput = z.object({
  scope: z
    .enum(["session", "project"])
    .default("session")
    .describe("'session' (default) or 'project'."),
  status: z
    .union([STATUS, z.literal("all")])
    .optional()
    .describe("Filter by status; defaults to active."),
  limit: z.number().int().min(1).max(200).optional().describe("Max plans (default 50)."),
});

// Accept both the documented object (`{ id, scope? }`) and a bare plan id.
// Agents often pass the id directly for read-only lookups; the JSON schema
// stays an object, so the model still sees the canonical call shape.
const getInput = z.preprocess(
  (value) => (typeof value === "string" ? { id: value } : value),
  z.object({
    id: z.string().min(1).describe("Plan id, from plans.list or plans.save."),
    scope: z
      .enum(["session", "project"])
      .default("session")
      .describe("'session' (default) or 'project'."),
  }),
);

const updateInput = z.object({
  id: z.string().min(1).describe("Plan id."),
  stepID: z
    .string()
    .optional()
    .describe("Step id (s1…); fallback is position."),
  position: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Zero-based step index; fallback to stepID."),
  stepStatus: z
    .enum(["todo", "doing", "done"])
    .optional()
    .describe("New status; pair with stepID."),
  status: STATUS.optional().describe("New plan status."),
  title: z.string().optional().describe("New title (rarely needed)."),
  body: z
    .string()
    .optional()
    .describe("Rewrites text/structure; not for status."),
});

const doctorInput = z.object({});

export function saveTool(ctx: Ctx) {
  return {
    name: "save",
    description:
      "Save the plan now: Plan mode allows it (writes plans.db, not repo files). Do not wait for permission.",
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
        emitPlanChange({ sessionID: result.plan.session_id, planID: result.plan.id });
        const checklist =
          result.plan.steps.length > 0
            ? result.plan.steps
                .map((step) => `- [${step.status}] (${step.step_id}) ${step.text}`)
                .join("\n")
            : "Sem passos extraídos.";
        return {
          content: [
            `Plano salvo: ${result.plan.title}`,
            renderPlanSummary(result.plan),
            checklist,
            "O checklist acima já está atualizado; não chame plans.get para confirmar. Use plans.get apenas se precisar do body completo.",
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
      "List plans with status and step progress; this session by default, project with scope.",
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
      "Read one plan in full: metadata, live step statuses, original markdown. Bare id accepted.",
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
      "Mark a step (stepID + stepStatus) or set plan status. Never edits text; use plans.save.",
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

        if (input.body !== undefined && (hasStep || input.stepStatus !== undefined)) {
          return fail(
            "não combine body com stepID/position/stepStatus. Para marcar passos use plans.update com stepID + stepStatus (os IDs aparecem em plans.get); para reescrever o texto/estrutura use plans.save com id",
          );
        }

        if (input.body !== undefined) {
          const next = parseSteps(input.body);
          const current = plan.steps;
          const sameTexts =
            next.length === current.length &&
            next.every(
              (step, index) =>
                normalizeStepText(step.text) === normalizeStepText(current[index]!.text),
            );
          const sameStatuses =
            next.length === current.length &&
            next.every((step, index) => step.status === current[index]!.status);
          if (sameTexts && !sameStatuses) {
            return fail(
              "esse body só troca os checkboxes: os textos dos passos não mudaram. Use plans.update com stepID + stepStatus; os IDs aparecem em plans.get",
            );
          }
        }

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

        emitPlanChange({ sessionID: result.plan.session_id, planID: result.plan.id });

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
      "Diagnose the plans subsystem: database path, schema version, plan/step counts.",
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
    description: "Permanently delete a plan. Prefer status=archived unless the user asked to delete.",
    input: z.object({ id: z.string().min(1).describe("Plan id.") }),
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
        emitPlanChange({ sessionID: result.plan.session_id, planID: result.plan.id });
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
