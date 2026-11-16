/**
 * Where a plan for an item starts. Pure so the rule is tested without the UI.
 */

import type { Initiative, InitiativeRepo } from "./gui/contract.js";

/**
 * The item's own repository, else the initiative's primary, else the first.
 * An initiative always has at least one repository by construction.
 */
export function repoForItem(initiative: Initiative, repoID?: string | null): InitiativeRepo | undefined {
  const explicit = repoID ? initiative.repos.find((repo) => repo.id === repoID) : undefined;
  return explicit ?? initiative.repos.find((repo) => repo.primary) ?? initiative.repos[0];
}
