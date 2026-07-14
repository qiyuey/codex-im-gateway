import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isWorkspaceAllowed } from "../src/security/workspace.js";

describe("isWorkspaceAllowed", () => {
  it("accepts descendants but rejects sibling and symlink escapes", async () => {
    const base = await mkdtemp(join(tmpdir(), "gateway-workspace-"));
    const allowed = join(base, "allowed");
    const child = join(allowed, "child");
    const outside = join(base, "outside");
    const escapeLink = join(allowed, "escape");
    try {
      await mkdir(child, { recursive: true });
      await mkdir(outside);
      await symlink(outside, escapeLink);
      expect(await isWorkspaceAllowed(child, [allowed])).toBe(true);
      expect(await isWorkspaceAllowed(outside, [allowed])).toBe(false);
      expect(await isWorkspaceAllowed(escapeLink, [allowed])).toBe(false);
    } finally {
      await rm(base, { force: true, recursive: true });
    }
  });
});
