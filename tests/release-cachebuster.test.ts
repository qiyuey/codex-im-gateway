import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(
  new URL("../.agents/skills/release/scripts/update-cachebuster.mjs", import.meta.url),
);

async function makePlugin(version: string) {
  const root = await mkdtemp(`${tmpdir()}/codex-im-release-`);
  await mkdir(`${root}/.codex-plugin`);
  await writeFile(
    `${root}/.codex-plugin/plugin.json`,
    `{\n  "name": "codex-im",\n  "version": ${JSON.stringify(version)},\n  "keywords": ["codex", "telegram"]\n}\n`,
  );
  return root;
}

async function readVersion(root: string) {
  const manifest = JSON.parse(await readFile(`${root}/.codex-plugin/plugin.json`, "utf8"));
  return manifest.version as string;
}

describe("release cachebuster", () => {
  it("replaces an existing Codex suffix", async () => {
    const root = await makePlugin("0.1.0+codex.old-token");

    const { stdout } = await execFileAsync(process.execPath, [
      scriptPath,
      root,
      "--cachebuster",
      "20260715010203",
    ]);

    expect(stdout).toBe("0.1.0+codex.old-token -> 0.1.0+codex.20260715010203\n");
    expect(await readVersion(root)).toBe("0.1.0+codex.20260715010203");
    expect(await readFile(`${root}/.codex-plugin/plugin.json`, "utf8")).toContain(
      '"keywords": ["codex", "telegram"]',
    );
  });

  it("preserves a prerelease base version", async () => {
    const root = await makePlugin("1.2.3-beta.1+codex.previous");

    await execFileAsync(process.execPath, [
      scriptPath,
      root,
      "--cachebuster",
      "local-20260715-010203",
    ]);

    expect(await readVersion(root)).toBe("1.2.3-beta.1+codex.local-20260715-010203");
  });

  it("rejects an invalid cachebuster without changing the manifest", async () => {
    const root = await makePlugin("0.1.0+codex.previous");

    await expect(
      execFileAsync(process.execPath, [scriptPath, root, "--cachebuster", "bad/value"]),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("cachebuster must contain") });
    expect(await readVersion(root)).toBe("0.1.0+codex.previous");
  });
});
