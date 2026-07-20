import { chmod, copyFile, cp, mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { force: true, recursive: true });
await mkdir("dist", { recursive: true });

await build({
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  bundle: true,
  entryPoints: {
    cli: "src/cli.ts",
    daemon: "src/daemon.ts",
    "hooks/stop": "src/hooks/stop.ts",
    "mcp/server": "src/mcp/server.ts",
  },
  format: "esm",
  logLevel: "info",
  outdir: "dist",
  platform: "node",
  sourcemap: true,
  target: "node26",
});

await chmod("dist/cli.js", 0o755);
await chmod("dist/daemon.js", 0o755);
await chmod("dist/hooks/stop.js", 0o755);

await rm("artifacts", { force: true, recursive: true });
await Promise.all([
  mkdir("artifacts/plugin/dist", { recursive: true }),
  mkdir("artifacts/runtime/dist", { recursive: true }),
]);
await Promise.all([
  cp(".codex-plugin", "artifacts/plugin/.codex-plugin", { recursive: true }),
  cp("hooks", "artifacts/plugin/hooks", { recursive: true }),
  cp("skills", "artifacts/plugin/skills", { recursive: true }),
  cp("dist/hooks", "artifacts/plugin/dist/hooks", { recursive: true }),
  cp("dist/mcp", "artifacts/plugin/dist/mcp", { recursive: true }),
  copyFile("LICENSE", "artifacts/plugin/LICENSE"),
  copyFile("dist/daemon.js", "artifacts/runtime/dist/daemon.js"),
  copyFile("dist/daemon.js.map", "artifacts/runtime/dist/daemon.js.map"),
  copyFile("dist/cli.js", "artifacts/runtime/dist/cli.js"),
  copyFile("dist/cli.js.map", "artifacts/runtime/dist/cli.js.map"),
  copyFile(".env.example", "artifacts/runtime/.env.example"),
  copyFile("LICENSE", "artifacts/runtime/LICENSE"),
  copyFile("README.md", "artifacts/runtime/README.md"),
]);
await Promise.all([
  chmod("artifacts/plugin/dist/hooks/stop.js", 0o755),
  chmod("artifacts/runtime/dist/daemon.js", 0o755),
  chmod("artifacts/runtime/dist/cli.js", 0o755),
]);
