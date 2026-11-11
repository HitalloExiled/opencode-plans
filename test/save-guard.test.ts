import { describe, expect, test } from "bun:test";

const { DatabaseSync } = (await import("node:sqlite")) as any;

import { claimSaveNudge, planAlreadySaved } from "../src/save-guard";
import { initSchema, savePlan, type Db } from "../src/store";

const open = (): Db => {
  const db = new DatabaseSync(":memory:") as Db;
  initSchema(db);
  return db;
};

const base = {
  projectID: "project-1",
  projectDirectory: "/tmp/project-1",
  sessionID: "session-1",
};

describe("save guard", () => {
  test("claims a plan message exactly once", () => {
    const id = `claim-${crypto.randomUUID()}`;
    expect(claimSaveNudge(id)).toBe(true);
    expect(claimSaveNudge(id)).toBe(false);
  });

  test("detects a saved plan by message id and by step text", () => {
    const db = open();
    const saved = savePlan(db, {
      ...base,
      messageID: "msg-1",
      body: "# Plan\n\n## Passos\n\n- [ ] A\n- [ ] B\n",
    });
    if (!saved.ok) throw new Error(saved.error);
    const store = { db, driver: "native" as const };

    expect(
      planAlreadySaved(store, "session-1", {
        messageID: "msg-1",
        body: "# Plan\n\n## Passos\n\n- [ ] A\n- [ ] B\n",
      }),
    ).toBe(true);

    expect(
      planAlreadySaved(store, "session-1", {
        messageID: "msg-other",
        body: "# Other\n\n## Passos\n\n- [ ] A\n- [ ] B\n",
      }),
    ).toBe(true);

    expect(
      planAlreadySaved(store, "session-1", {
        messageID: "msg-other",
        body: "# Other\n\n## Passos\n\n- [ ] X\n",
      }),
    ).toBe(false);
  });

  test("finds the plan by session alone, whatever the guard's project", () => {
    // Regression: the guard instance's ctx.location can be another project
    // (the home instance sees every session). A project filter here missed the
    // saved plan and nudged a saved message.
    const db = open();
    const saved = savePlan(db, {
      ...base,
      projectID: "other-project",
      messageID: "msg-2",
      body: "# Plan\n\n## Passos\n\n- [ ] A\n",
    });
    if (!saved.ok) throw new Error(saved.error);
    const store = { db, driver: "native" as const };

    expect(
      planAlreadySaved(store, "session-1", {
        messageID: "msg-other",
        body: "# Plan\n\n## Passos\n\n- [ ] A\n",
      }),
    ).toBe(true);
  });

  test("does not match a plan from another session", () => {
    const db = open();
    const saved = savePlan(db, {
      ...base,
      messageID: "msg-3",
      body: "# Plan\n\n## Passos\n\n- [ ] A\n",
    });
    if (!saved.ok) throw new Error(saved.error);
    const store = { db, driver: "native" as const };

    expect(
      planAlreadySaved(store, "session-2", {
        messageID: "msg-other",
        body: "# Plan\n\n## Passos\n\n- [ ] A\n",
      }),
    ).toBe(false);
  });
});
