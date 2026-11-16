/**
 * initiative — tool definitions (registration lives in ./index.ts under the
 * "initiative" namespace).
 *
 * An initiative is the user's grouping of needs across repositories. The agent
 * creates and lists them here; editing (rename, description) stays in the
 * panel. Work items are created with `work.save({ initiativeID })`.
 */

import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { createInitiative, listInitiatives, listWorkItems, requireStore } from "./src/store.js";
import { emitPlanChange } from "./src/plan-events.js";

type ToolResult = { content: string; metadata?: Record<string, unknown> };
type Ctx = Plugin.Context;

/** Catalog group label. Code Mode truncates this at ~119 characters. */
export const INITIATIVE_NAMESPACE = {
  name: "initiative",
  description: "User initiatives: groups of needs across repositories.",
} as const;

function fail(error: string): ToolResult {
  return { content: `❌ ${error}`, metadata: { rejected: true } };
}

const listInput = z.object({});

const createInput = z.object({
  name: z.string().min(1).max(200).describe("Initiative name."),
  description: z.string().max(2000).optional().describe("Optional description."),
});

export function listInitiativeTool(ctx: Ctx) {
  return {
    name: "list",
    description: "List initiatives: id, name, repositories and item counts.",
    input: listInput,
    async execute(_input: z.infer<typeof listInput>): Promise<ToolResult> {
      try {
        const store = await requireStore();
        const initiatives = listInitiatives(store.db);
        if (initiatives.length === 0) {
          return {
            content: "Nenhuma iniciativa ainda. Crie a primeira com initiative.create.",
            metadata: { count: 0 },
          };
        }
        const lines = initiatives.map((initiative) => {
          const items = listWorkItems(store.db, initiative.id).length;
          return `- ${initiative.name} (id=${initiative.id}, ${items} itens, ${initiative.repos.length} repositórios)`;
        });
        return {
          content: [`Initiatives (${initiatives.length}):`, ...lines].join("\n"),
          metadata: {
            count: initiatives.length,
            initiativeIDs: initiatives.map((initiative) => initiative.id),
          },
        };
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function createInitiativeTool(ctx: Ctx) {
  return {
    name: "create",
    description: "Create an initiative from a name and an optional description.",
    input: createInput,
    async execute(input: z.infer<typeof createInput>): Promise<ToolResult> {
      try {
        const store = await requireStore();
        const result = createInitiative(store.db, {
          name: input.name,
          description: input.description,
        });
        if (!result.ok) return fail(result.error);
        emitPlanChange({ sessionID: "" });
        return {
          content: `Iniciativa "${result.initiative.name}" criada (id=${result.initiative.id}). Repositórios entram pelo Planejar; use work.save com initiativeID para criar itens.`,
          metadata: { initiativeID: result.initiative.id, name: result.initiative.name },
        };
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
