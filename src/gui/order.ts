/**
 * Ordering for the plans list: project sections come from a sorted list, and
 * the renderer opens a header whenever the project changes between two items.
 *
 * Pure and framework-free, so the order the user sees is testable without the
 * GUI. The panel keeps the store order (recency); the global overlay orders by
 * project first.
 */

import type { Plan } from "./contract";

/** Section key: the project directory (or its id when the path is empty). */
export function projectKeyOf(plan: Plan): string {
  return plan.projectDirectory || plan.projectID;
}

/** Short project name: the basename, disambiguated by its parent when shared. */
export function projectLabel(path: string, paths: readonly string[] = []): string {
  const parts = path.split("/").filter(Boolean);
  const base = parts.at(-1) ?? path;
  const sameBase = paths.filter((item) => (item.split("/").filter(Boolean).at(-1) ?? item) === base);
  if (sameBase.length <= 1) return base;
  const parent = parts.at(-2);
  return parent ? `${parent}/${base}` : base;
}

/**
 * Project order (label, locale compare), then newest first inside the project.
 * Returns a new array; the input is untouched.
 */
export function orderPlans(
  plans: Plan[],
  label: (project: string) => string = (project) => project,
): Plan[] {
  return [...plans].sort((a, b) => {
    const byProject = label(projectKeyOf(a)).localeCompare(label(projectKeyOf(b)));
    if (byProject !== 0) return byProject;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}
