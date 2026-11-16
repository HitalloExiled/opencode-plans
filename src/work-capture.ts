/**
 * `/work <title>`: capture a need without a model turn.
 *
 * The initiative is resolved from the session directory (created on first
 * use), and the item starts in the backlog, owned by the user.
 */

import {
  createWorkItem,
  ensureInitiativeForDirectory,
  type Db,
  type Initiative,
  type WorkItemRow,
} from "./store.js";

export type CaptureWorkInput = {
  directory: string;
  title: string;
  body?: string | undefined;
};

export type CaptureWorkResult =
  | { ok: true; item: WorkItemRow; initiative: Initiative; createdInitiative: boolean }
  | { ok: false; error: string };

export function captureWorkItem(db: Db, input: CaptureWorkInput): CaptureWorkResult {
  const title = input.title.trim();
  if (!title) return { ok: false, error: "o título do work item é obrigatório" };

  const ensured = ensureInitiativeForDirectory(db, input.directory);
  if (!ensured.ok) return ensured;

  const item = createWorkItem(db, {
    initiativeID: ensured.initiative.id,
    repoID: ensured.repo.id,
    title,
    body: input.body,
    origin: "user",
  });
  if (!item.ok) return item;

  return {
    ok: true,
    item: item.item,
    initiative: ensured.initiative,
    createdInitiative: ensured.created,
  };
}
