/**
 * `/work <title>`: capture a need without a model turn.
 *
 * The project is resolved from the session directory (created on first use),
 * and the item starts in the backlog, owned by the user.
 */

import {
  createWorkItem,
  ensureProjectForDirectory,
  type Db,
  type Project,
  type WorkItemRow,
} from "./store.js";

export type CaptureWorkInput = {
  directory: string;
  title: string;
  body?: string | undefined;
};

export type CaptureWorkResult =
  | { ok: true; item: WorkItemRow; project: Project; createdProject: boolean }
  | { ok: false; error: string };

export function captureWorkItem(db: Db, input: CaptureWorkInput): CaptureWorkResult {
  const title = input.title.trim();
  if (!title) return { ok: false, error: "o título do work item é obrigatório" };

  const project = ensureProjectForDirectory(db, input.directory);
  if (!project.ok) return project;

  const item = createWorkItem(db, {
    projectID: project.project.id,
    locationID: project.location.id,
    title,
    body: input.body,
    origin: "user",
  });
  if (!item.ok) return item;

  return {
    ok: true,
    item: item.item,
    project: project.project,
    createdProject: project.created,
  };
}
