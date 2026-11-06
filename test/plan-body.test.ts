import { describe, expect, test } from "bun:test";
import {
  bodyWithoutSteps,
  buildTemplate,
  extractSteps,
  renderPlanBody,
  STEPS_PLACEHOLDER,
} from "../src/plan-body";

const body = [
  "# Plano — X",
  "",
  "## Objetivo",
  "Fazer X.",
  "",
  "## Passos",
  "- [ ] Um detalhe (importante)",
  "- [x] Dois",
  "",
  "## Critérios",
  "- [ ] aceite um",
  "",
].join("\n");

describe("plan-body", () => {
  test("extracts exact text from the dedicated step section", () => {
    const steps = extractSteps(body);
    expect(steps.map((step) => step.text)).toEqual(["Um detalhe (importante)", "Dois"]);
    expect(steps.map((step) => step.status)).toEqual(["todo", "done"]);
    // The acceptance checkbox outside the section is not a step.
    expect(steps.some((step) => step.text === "aceite um")).toBe(false);
  });

  test("does not turn arbitrary bullets into steps", () => {
    const noSteps = [
      "# Plano",
      "",
      "## Invariantes",
      "- Zero auth nos plugins",
      "- White-label",
      "",
      "## Decisões",
      "- Acoplamento híbrido",
      "- Poller via jobs.schedule",
    ].join("\n");
    expect(extractSteps(noSteps)).toEqual([]);
  });

  test("builds a template with the internal placeholder", () => {
    const template = buildTemplate(body);
    expect(template).toContain(STEPS_PLACEHOLDER);
    expect(template).not.toContain("- [ ] Um detalhe");
    expect(template).toContain("## Objetivo");
    expect(template).toContain("## Critérios");
  });

  test("reassembles the template with live statuses and no marker", () => {
    const template = buildTemplate(body);
    const rendered = renderPlanBody(template, [
      { id: "s1", text: "Um detalhe (importante)", status: "doing" },
      { id: "s2", text: "Dois", status: "done" },
    ]);
    expect(rendered).toContain("- [~] (s1) Um detalhe (importante)");
    expect(rendered).toContain("- [x] (s2) Dois");
    expect(rendered).not.toContain(STEPS_PLACEHOLDER);
    expect(rendered.match(/## Passos/g)).toHaveLength(1);
  });

  test("strips rendered step ids when a body is copied back", () => {
    const steps = extractSteps("## Passos\n- [ ] (s1) Um\n- [x] (s2) Dois\n");
    expect(steps.map((step) => step.text)).toEqual(["Um", "Dois"]);
    expect(steps.map((step) => step.status)).toEqual(["todo", "done"]);
  });

  test("reassembles a legacy body without a placeholder", () => {
    const rendered = renderPlanBody(body, [
      { text: "Um detalhe (importante)", status: "done" },
      { text: "Dois", status: "todo" },
    ]);
    expect(rendered).toContain("- [x] Um detalhe (importante)");
    expect(rendered).toContain("- [ ] Dois");
    expect(rendered).not.toContain(STEPS_PLACEHOLDER);
    expect(rendered.match(/## Passos/g)).toHaveLength(1);
    expect(rendered).toContain("## Critérios");
  });

  test("the GUI body drops the step section and keeps the rest", () => {
    const without = bodyWithoutSteps(body);
    expect(without).not.toContain("## Passos");
    expect(without).not.toContain("Um detalhe");
    expect(without).toContain("## Objetivo");
    expect(without).toContain("## Critérios");
    expect(without).toContain("aceite um");
  });

  test("never returns the placeholder, even with no steps", () => {
    const rendered = renderPlanBody(buildTemplate(body), []);
    expect(rendered).not.toContain(STEPS_PLACEHOLDER);
    expect(rendered).toContain("(nenhum passo extraído do texto)");
  });
});
