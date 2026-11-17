import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { pidChanged } = await import("../src/runtime-pid");

const temp = () => mkdtempSync(join(tmpdir(), "plans-pid-"));

describe("pidChanged", () => {
  test("stamps the first pid and treats a reload on the same pid as the same process", () => {
    const dir = temp();
    try {
      const path = join(dir, "runtime.json");
      expect(pidChanged(path, 111)).toBe(true);
      expect(pidChanged(path, 111)).toBe(false);
      expect(pidChanged(path, 222)).toBe(true);
      expect(pidChanged(path, 222)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unreadable stamp counts as a fresh process", () => {
    const dir = temp();
    try {
      const path = join(dir, "runtime.json");
      writeFileSync(path, "not json");
      expect(pidChanged(path, 333)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
