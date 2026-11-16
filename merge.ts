/**
 * merge — tools of the single merge session of a project run (F4 s5).
 *
 * The session is bound to its run through `runs.merge_session_id`, so the
 * tools infer the run from the calling session. `merge.next` claims the next
 * queued item (one `merging` at a time); `merge.done` verifies the branch is
 * really contained in the integration HEAD before marking it, and `merge.fail`
 * stops the queue and lets the engine fail the run.
 */

import { Plugin } from "@opencode/plugin";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import { z } from "zod";
import { currentSha, isAncestor } from "./src/git.js";
import { runForMergeSession } from "./src/merge-session.js";
import { resumeAfterMerge } from "./src/run-engine.js";
import { itemBranch, runPaths } from "./src/run-paths.js";
import {
  claimNextMerge,
  finishMerge,
  getMergeEntry,
  getInitiative,
  getWorkItem,
  listMergeQueue,
  requireStore,
  setRunItemStatus,
  stopMergeQueue,
  type MergeEntryRow,
  type RunRow,
} from "./src/store.js";

type ToolResult = { content: string; metadata?: Record<string, unknown> };
type Ctx = Plugin.Context;

/** Catalog group label. Code Mode truncates this at ~119 characters. */
export const MERGE_NAMESPACE = {
  name: "merge",
  description: "Merge queue of a project run: list, claim and finish entries.",
} as const;

function fail(error: string): ToolResult {
  return { content: `❌ ${error}`, metadata: { rejected: true } };
}

function entryLine(entry: MergeEntryRow, title: string): string {
  return `- [${entry.status}] ${title} (entry=${entry.id}, branch=${itemBranch(entry.work_item_id)})`;
}

async function contextFor(toolCtx: ToolContext): Promise<{ run: RunRow } | { error: ToolResult }> {
  const store = await requireStore();
  const run = runForMergeSession(store.db, String(toolCtx.sessionID));
  if (!run) return { error: fail("esta sessão não é a sessão de merge de um run") };
  return { run };
}

const empty = z.object({});

export function mergeListTool(ctx: Ctx) {
  return {
    name: "list",
    description: "List the run's merge queue: entries, status and branch.",
    input: empty,
    async execute(_input: z.infer<typeof empty>, toolCtx: ToolContext): Promise<ToolResult> {
      try {
        const found = await contextFor(toolCtx);
        if ("error" in found) return found.error;
        const store = await requireStore();
        const entries = listMergeQueue(store.db, found.run.id);
        if (entries.length === 0) {
          return { content: "Fila de merge vazia. Pare e aguarde um novo item.", metadata: { count: 0 } };
        }
        const titles = new Map(
          entries.map((entry) => [entry.work_item_id, getWorkItem(store.db, entry.work_item_id)?.title ?? entry.work_item_id]),
        );
        return {
          content: [
            `Fila de merge do run ${found.run.id} (status=${found.run.status}): ${entries.length}`,
            ...entries.map((entry) => entryLine(entry, titles.get(entry.work_item_id) ?? entry.work_item_id)),
          ].join("\n"),
          metadata: { count: entries.length, runID: found.run.id },
        };
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function mergeNextTool(ctx: Ctx) {
  return {
    name: "next",
    description: "Claim the next queued item to merge; empty means nothing to do.",
    input: empty,
    async execute(_input: z.infer<typeof empty>, toolCtx: ToolContext): Promise<ToolResult> {
      try {
        const found = await contextFor(toolCtx);
        if ("error" in found) return found.error;
        const store = await requireStore();
        const entries = listMergeQueue(store.db, found.run.id);
        if (entries.some((entry) => entry.status === "failed")) {
          return fail("a fila parou depois de um merge falho; o run vai falhar");
        }

        const claimed = claimNextMerge(store.db, found.run.id);
        if (!claimed.ok) return fail(claimed.error);
        if (!claimed.entry) {
          return { content: "Nenhum item na fila. Pare e aguarde um novo item.", metadata: { entry: null } };
        }

        const item = getWorkItem(store.db, claimed.entry.work_item_id);
        const branch = itemBranch(claimed.entry.work_item_id);
        const project = getInitiative(store.db, found.run.initiative_id);
        const verify = project?.verify_command?.trim();
        return {
          content: [
            `Item da fila: "${item?.title ?? claimed.entry.work_item_id}" (work item ${claimed.entry.work_item_id})`,
            `entry: ${claimed.entry.id}`,
            `branch: ${branch}`,
            "",
            `Mergeie com git merge --no-edit ${branch} neste worktree (resolva conflitos aqui).`,
            verify ? `Verificação: ${verify}` : "Verificação: não configurada",
            `Depois marque com merge.done({ entryID: "${claimed.entry.id}" }); se não der, merge.fail com o motivo.`,
          ].join("\n"),
          metadata: { entry: claimed.entry.id, workItemID: claimed.entry.work_item_id, branch },
        };
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function mergeDoneTool(ctx: Ctx) {
  return {
    name: "done",
    description: "Mark the claimed merge as done after merging and verifying.",
    input: z.object({
      entryID: z.string().min(1).describe("Entry id from merge.next."),
      mergedSha: z.string().optional().describe("Merged commit; defaults to HEAD."),
    }),
    async execute(input: { entryID: string; mergedSha?: string }, toolCtx: ToolContext): Promise<ToolResult> {
      try {
        const found = await contextFor(toolCtx);
        if ("error" in found) return found.error;
        const store = await requireStore();
        const entry = getMergeEntry(store.db, input.entryID);
        if (!entry) return fail(`entrada da fila não encontrada: ${input.entryID}`);
        if (entry.run_id !== found.run.id) return fail("essa entrada pertence a outro run");
        if (entry.status !== "merging") return fail(`a entrada não está em merging: ${entry.status}`);

        const integration = runPaths(found.run.id).integration;
        const branch = itemBranch(entry.work_item_id);
        if (!(await isAncestor(integration, branch, "HEAD"))) {
          return fail(
            `a branch ${branch} não está contida no HEAD da integração; mergeie e verifique antes de marcar done`,
          );
        }
        const sha = input.mergedSha?.trim() || (await currentSha(integration));
        if (!sha) return fail("não foi possível resolver o SHA da integração");

        finishMerge(store.db, { id: entry.id, status: "merged", mergedSha: sha });
        setRunItemStatus(store.db, {
          runID: found.run.id,
          workItemID: entry.work_item_id,
          status: "merged",
          mergedSha: sha,
        });
        resumeAfterMerge(ctx, store.db, found.run.id);
        return {
          content: [
            `Merge concluído: ${entry.work_item_id} em ${sha.slice(0, 8)}.`,
            "Continue com merge.next; se a fila estiver vazia, pare.",
          ].join("\n"),
          metadata: { entry: entry.id, mergedSha: sha },
        };
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function mergeFailTool(ctx: Ctx) {
  return {
    name: "fail",
    description: "Mark the claimed merge as failed with the reason; stops the queue.",
    input: z.object({
      entryID: z.string().min(1).describe("Entry id from merge.next."),
      error: z.string().min(1).describe("Why the merge failed."),
    }),
    async execute(input: { entryID: string; error: string }, toolCtx: ToolContext): Promise<ToolResult> {
      try {
        const found = await contextFor(toolCtx);
        if ("error" in found) return found.error;
        const store = await requireStore();
        const entry = getMergeEntry(store.db, input.entryID);
        if (!entry) return fail(`entrada da fila não encontrada: ${input.entryID}`);
        if (entry.run_id !== found.run.id) return fail("essa entrada pertence a outro run");
        if (entry.status !== "merging") return fail(`a entrada não está em merging: ${entry.status}`);

        finishMerge(store.db, { id: entry.id, status: "failed", error: input.error });
        setRunItemStatus(store.db, {
          runID: found.run.id,
          workItemID: entry.work_item_id,
          status: "failed",
          error: input.error,
        });
        // A broken integration stops the queue; queued items will not run.
        stopMergeQueue(store.db, found.run.id, "fila parada após merge falho");
        for (const itemID of listMergeQueue(store.db, found.run.id)
          .filter((queued) => queued.status === "failed" && queued.id !== entry.id)
          .map((queued) => queued.work_item_id)) {
          setRunItemStatus(store.db, {
            runID: found.run.id,
            workItemID: itemID,
            status: "skipped",
            error: "fila de merge parada",
          });
        }
        resumeAfterMerge(ctx, store.db, found.run.id);
        return {
          content: [
            `Merge falhou: ${entry.work_item_id} — ${input.error}`,
            "A fila parou e o run vai falhar; não chame merge.next.",
          ].join("\n"),
          metadata: { entry: entry.id, failed: true },
        };
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
