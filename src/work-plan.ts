/**
 * Where a plan for an item starts. Pure so the rule is tested without the UI.
 */

import type { Project, ProjectLocation } from "./gui/contract.js";

/**
 * The item's own workspace, else the project's primary, else the first one.
 * The project always has at least one workspace by construction.
 */
export function locationForItem(
  project: Project,
  locationID?: string | null,
): ProjectLocation | undefined {
  const explicit = locationID ? project.locations.find((location) => location.id === locationID) : undefined;
  return explicit ?? project.locations.find((location) => location.primary) ?? project.locations[0];
}
