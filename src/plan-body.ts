/**
 * Pure plan-body helpers: step extraction, template building and reassembly.
 *
 * No Node imports: the server tools and the GUI bundle share this module.
 * The stored body keeps an internal `<!-- plans:steps -->` placeholder where
 * the checklist was; `renderPlanBody` puts the live steps back and never
 * exposes the marker to the agent.
 */

export type ChecklistStatus = "todo" | "doing" | "done";

export type BodyStep = {
  /** Exact item text from the body. */
  text: string;
  status: ChecklistStatus;
  /** Zero-based line index in the source body. */
  lineIndex: number;
  /** Original source line. */
  line: string;
  /** Heading that opened the step section, when the item is inside one. */
  sectionHeadingIndex: number | null;
};

export const STEPS_PLACEHOLDER = "<!-- plans:steps -->";

const TASK_RE = /^\s*[-*+]\s+\[([ xX~>])\]\s+(.+?)\s*$/;
const NUM_RE = /^\s*\d+[.)]\s+(.+?)\s*$/;
const BULLET_RE = /^\s*[-*+]\s+(.+?)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const STEP_SECTION_RE =
  /\b(passos|steps|tarefas|tasks|checklist|implementa[cç][aã]o|implementation)\b/i;

function isFence(line: string): boolean {
  return /^\s*```/.test(line);
}

/** Remove a leading step id rendered by `plans.get`, e.g. `(s1) `. */
function stripStepId(text: string): string {
  return text.replace(/^\(s\d+\)\s*/i, "");
}

/** Strip the light Markdown the model puts around a checklist item. */
export function cleanStepText(text: string): string {
  return stripStepId(text.trim())
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeStepText(text: string): string {
  return cleanStepText(text).toLowerCase();
}

function statusFromMarker(marker: string): ChecklistStatus {
  return /x/i.test(marker) ? "done" : /[~>]/.test(marker) ? "doing" : "todo";
}

function dedupeSteps(steps: readonly BodyStep[]): BodyStep[] {
  const seen = new Set<string>();
  const out: BodyStep[] = [];
  for (const step of steps) {
    const key = normalizeStepText(step.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(step);
  }
  return out;
}

/**
 * Extract the plan's checklist, keeping each item's exact text and source line.
 *
 * Priority:
 *  1. task-list items inside a step section (`## Passos`, `## Steps`, ...);
 *  2. numbered/bulleted items inside a step section;
 *  3. task-list items anywhere (legacy plans).
 *
 * Fenced code blocks are ignored so shell snippets never become steps.
 * Arbitrary numbered/bulleted lists outside a step section are not steps:
 * "Invariantes", "Decisões" and acceptance criteria must not become a
 * checklist by accident.
 */
export function extractSteps(body: string): BodyStep[] {
  const lines = body.split(/\r?\n/);
  const sectionTasks: BodyStep[] = [];
  const sectionItems: BodyStep[] = [];
  const tasks: BodyStep[] = [];
  let inFence = false;
  let sectionLevel = 0;
  let sectionHeadingIndex: number | null = null;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const trimmed = line.trimEnd();
    if (isFence(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !trimmed.trim()) continue;

    const heading = HEADING_RE.exec(trimmed);
    if (heading) {
      const level = heading[1]?.length ?? 0;
      const text = heading[2] ?? "";
      if (STEP_SECTION_RE.test(text)) {
        sectionLevel = level;
        sectionHeadingIndex = index;
      } else if (sectionLevel && level <= sectionLevel) {
        sectionLevel = 0;
        sectionHeadingIndex = null;
      }
      continue;
    }

    const task = TASK_RE.exec(trimmed);
    if (task) {
      const text = stripStepId(task[2] ?? "");
      if (!text) continue;
      const step: BodyStep = {
        text,
        status: statusFromMarker(task[1] ?? ""),
        lineIndex: index,
        line,
        sectionHeadingIndex,
      };
      tasks.push(step);
      if (sectionHeadingIndex !== null) sectionTasks.push(step);
      continue;
    }

    const num = NUM_RE.exec(trimmed);
    if (num) {
      const text = stripStepId(num[1] ?? "");
      if (!text) continue;
      if (sectionHeadingIndex !== null) {
        sectionItems.push({
          text,
          status: "todo",
          lineIndex: index,
          line,
          sectionHeadingIndex,
        });
      }
      continue;
    }

    const bullet = BULLET_RE.exec(trimmed);
    if (bullet) {
      const text = stripStepId(bullet[1] ?? "");
      if (!text) continue;
      if (sectionHeadingIndex !== null) {
        sectionItems.push({
          text,
          status: "todo",
          lineIndex: index,
          line,
          sectionHeadingIndex,
        });
      }
    }
  }

  const picked =
    sectionTasks.length > 0
      ? sectionTasks
      : sectionItems.length > 0
        ? sectionItems
        : tasks;

  return dedupeSteps(picked).slice(0, 100);
}

function isPlaceholder(line: string): boolean {
  return line.trim() === STEPS_PLACEHOLDER;
}

function hasContent(line: string | undefined): boolean {
  return !!line?.trim() && !isPlaceholder(line);
}

/** Drop headings whose own section ends up with no content (nested headings included). */
function removeEmptyHeadings(lines: readonly string[]): string[] {
  let current = [...lines];
  let changed = true;
  while (changed) {
    changed = false;
    const next: string[] = [];
    for (let index = 0; index < current.length; index++) {
      const line = current[index] ?? "";
      const heading = HEADING_RE.exec(line);
      if (!heading) {
        next.push(line);
        continue;
      }
      const level = heading[1]?.length ?? 0;
      let cursor = index + 1;
      let content = false;
      while (cursor < current.length) {
        const child = HEADING_RE.exec(current[cursor] ?? "");
        if (child && (child[1]?.length ?? 0) <= level) break;
        if (hasContent(current[cursor])) {
          content = true;
          break;
        }
        cursor++;
      }
      if (content) {
        next.push(line);
        continue;
      }
      changed = true;
      index = cursor - 1;
    }
    current = next;
  }
  return current;
}

function collapseBlankLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  let blanks = 0;
  for (const line of lines) {
    if (line.trim()) {
      blanks = 0;
      out.push(line);
      continue;
    }
    blanks++;
    if (blanks <= 1) out.push("");
  }
  while (out.length > 0 && !out[out.length - 1]?.trim()) out.pop();
  return out;
}

/**
 * Remove the extracted step lines and leave one placeholder where the
 * checklist was. When `withSteps` is false, remove placeholders instead.
 */
export function buildTemplate(body: string, withSteps = true): string {
  const lines = body.split(/\r?\n/);

  const steps = extractSteps(body);
  if (steps.length === 0) {
    // Already a template: keep its placeholder rather than deleting it.
    if (lines.some(isPlaceholder)) return body;
    const cleaned = lines.filter((line) => !isPlaceholder(line));
    if (!withSteps) return collapseBlankLines(cleaned).join("\n").trim();

    // Explicit steps with no extracted checklist: use the existing step
    // heading when there is one, else add a dedicated section after the title.
    const stepHeadingPos = cleaned.findIndex((line) => {
      const heading = HEADING_RE.exec(line);
      return !!heading && STEP_SECTION_RE.test(heading[2] ?? "");
    });
    if (stepHeadingPos >= 0) {
      cleaned.splice(stepHeadingPos + 1, 0, "", STEPS_PLACEHOLDER);
      return collapseBlankLines(cleaned).join("\n").trim();
    }

    const headingPos = cleaned.findIndex((line) => HEADING_RE.test(line));
    const insertAt = headingPos >= 0 ? headingPos + 1 : 0;
    cleaned.splice(insertAt, 0, "", "## Passos", "", STEPS_PLACEHOLDER);
    return collapseBlankLines(cleaned).join("\n").trim();
  }

  const removed = new Set(steps.map((step) => step.lineIndex));
  const anchorHeading =
    steps.find((step) => step.sectionHeadingIndex !== null)?.sectionHeadingIndex ?? null;
  const firstRemoved = Math.min(...steps.map((step) => step.lineIndex));

  const kept: { line: string; index: number }[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (removed.has(index) || isPlaceholder(lines[index] ?? "")) {
      continue;
    }
    kept.push({ line: lines[index] ?? "", index });
  }

  let insertAt: number;
  if (anchorHeading !== null) {
    const anchorPos = kept.findIndex((item) => item.index === anchorHeading);
    insertAt = anchorPos >= 0 ? anchorPos + 1 : 0;
    if (insertAt > 0 && kept[insertAt - 1]?.line.trim()) {
      kept.splice(insertAt, 0, { line: "", index: -1 });
      insertAt++;
    }
    kept.splice(insertAt, 0, { line: STEPS_PLACEHOLDER, index: -1 });
    if (kept[insertAt + 1]?.line.trim()) {
      kept.splice(insertAt + 1, 0, { line: "", index: -1 });
    }
  } else {
    insertAt = kept.filter((item) => item.index < firstRemoved).length;
    const block = ["", "## Passos", "", STEPS_PLACEHOLDER, ""];
    if (insertAt > 0 && kept[insertAt - 1]?.line.trim()) block.unshift("");
    kept.splice(insertAt, 0, ...block.map((line) => ({ line, index: -1 })));
  }

  return collapseBlankLines(kept.map((item) => item.line)).join("\n").trim();
}

function renderStepList(
  steps: readonly { text: string; status: ChecklistStatus; id?: string }[],
): string {
  if (steps.length === 0) return "(nenhum passo extraído do texto)";
  return steps
    .map((step) => {
      const mark = step.status === "done" ? "x" : step.status === "doing" ? "~" : " ";
      const id = step.id ? ` (${step.id})` : "";
      return `- [${mark}]${id} ${step.text}`;
    })
    .join("\n");
}

/**
 * Reassemble the stored template with the live steps. The placeholder never
 * reaches the caller, even if the body has more than one or an unknown shape.
 */
export function renderPlanBody(
  body: string,
  steps: readonly { text: string; status: ChecklistStatus; id?: string }[],
): string {
  const list = renderStepList(steps).split("\n");
  const lines = body.split(/\r?\n/);
  const hasPlaceholder = lines.some(isPlaceholder);

  if (hasPlaceholder) {
    let inserted = false;
    const next: string[] = [];
    for (const line of lines) {
      if (!isPlaceholder(line)) {
        next.push(line);
        continue;
      }
      if (!inserted) {
        next.push(...list);
        inserted = true;
      }
    }
    return collapseBlankLines(next).join("\n").trim();
  }

  const template = buildTemplate(body, steps.length > 0);
  if (template.split(/\r?\n/).some(isPlaceholder)) {
    return renderPlanBody(template, steps);
  }

  if (steps.length === 0) {
    return collapseBlankLines(body.split(/\r?\n/).filter((line) => !isPlaceholder(line)))
      .join("\n")
      .trim();
  }

  return collapseBlankLines(["## Passos", "", ...list, "", ...body.split(/\r?\n/)]).join("\n").trim();
}

/** The plan body without its extracted checklist, for the GUI detail. */
export function bodyWithoutSteps(body: string): string {
  const template = buildTemplate(body, false);
  const withoutPlaceholder = template
    .split(/\r?\n/)
    .filter((line) => !isPlaceholder(line));
  return collapseBlankLines(removeEmptyHeadings(withoutPlaceholder)).join("\n").trim();
}
