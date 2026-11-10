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
      planAlreadySaved(store, "project-1", "session-1", {
        messageID: "msg-1",
        body: "# Plan\n\n## Passos\n\n- [ ] A\n- [ ] B\n",
      }),
    ).toBe(true);

    expect(
      planAlreadySaved(store, "project-1", "session-1", {
        messageID: "msg-other",
        body: "# Other\n\n## Passos\n\n- [ ] A\n- [ ] B\n",
      }),
    ).toBe(true);

    expect(
      planAlreadySaved(store, "project-1", "session-1", {
        messageID: "msg-other",
        body: "# Other\n\n## Passos\n\n- [ ] X\n",
      }),
    ).toBe(false);
  });
});
