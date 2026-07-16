import { spawnSync } from "node:child_process";

const env = { ...process.env };
delete env.TELEGRAM_BOT_TOKEN;
delete env.TELEGRAM_ALLOWED_USER_ID;
delete env.TELEGRAM_ALLOWED_CHAT_ID;
delete env.CODEX_IM_ALLOWED_WORKSPACES;

const result = spawnSync(process.execPath, ["dist/daemon.js"], {
  cwd: process.cwd(),
  encoding: "utf8",
  env,
});

if (result.status !== 1 || !result.stderr.includes('"event":"gateway_crashed"')) {
  process.stderr.write(result.stdout);
  process.stderr.write(result.stderr);
  throw new Error("Built daemon did not reach runtime configuration validation");
}

if (result.stderr.includes("Dynamic require")) {
  throw new Error("Built daemon contains an unusable dynamic require shim");
}

process.stdout.write("Built daemon smoke test passed.\n");
