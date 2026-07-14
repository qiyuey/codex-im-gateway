import { chmod, mkdir, rm } from "node:fs/promises";
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
