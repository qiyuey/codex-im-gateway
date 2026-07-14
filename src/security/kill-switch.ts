import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveDataDirectory } from "../config/paths.js";

export class LocalKillSwitch {
  readonly path: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.path = join(resolveDataDirectory(env), "inbound.disabled");
  }

  isInboundEnabled(): boolean {
    return !existsSync(this.path);
  }

  disable(): void {
    mkdirSync(dirname(this.path), { mode: 0o700, recursive: true });
    writeFileSync(this.path, `${Date.now()}\n`, { mode: 0o600 });
  }

  enable(): void {
    rmSync(this.path, { force: true });
  }
}
