/**
 * Plans list grouping: one section per project, in label order.
 *
 * Pure and framework-free so the sectioning is testable without the GUI; the
 * reactive view only wires the filtered plans and the label resolver in.
 */

import type { Plan } from "./contract";

export type PlanGroup = {
  /** Stable key: the project directory (or project id when it is empty). */
  key: string;
  project: string;
  plans: Plan[];
};

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
 * Sections ordered by `label(project)` (locale compare). Plans keep the order
 * they arrive in (the store returns newest first), so recency holds inside
 * each project.
 */
export function groupPlans(
  plans: Plan[],
  label: (project: string) => string = (project) => project,
): PlanGroup[] {
  const byProject = new Map<string, Plan[]>();
  for (const plan of plans) {
    const key = plan.projectDirectory || plan.projectID;
    const list = byProject.get(key);
    if (list) list.push(plan);
    else byProject.set(key, [plan]);
  }
  return [...byProject.keys()]
    .sort((a, b) => label(a).localeCompare(label(b)))
    .map((key) => ({ key, project: key, plans: byProject.get(key) ?? [] }));
}
