import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function resolveDataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CODEX_IM_DATA_DIR ?? env.PLUGIN_DATA;
  if (configured && configured.trim().length > 0) {
    return resolve(configured);
  }
  return join(homedir(), ".local", "share", "codex-im");
}

export function resolveDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDataDirectory(env), "gateway.sqlite");
}
