import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveDataDirectory } from "../config/paths.js";

export function resolveRuntimeLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDataDirectory(env), "daemon.lock");
}

export class SingleInstanceLock {
  private held = false;

  constructor(
    private readonly path = resolveRuntimeLockPath(),
    private readonly pid = process.pid,
  ) {}

  acquire(): void {
    if (this.held) return;
    mkdirSync(dirname(this.path), { mode: 0o700, recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(this.path, "wx", 0o600);
        try {
          writeFileSync(fd, `${this.pid}\n`);
        } finally {
          closeSync(fd);
        }
        this.held = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const owner = readOwner(this.path);
        if (owner !== null && isProcessAlive(owner)) {
          throw new Error(`Codex IM daemon is already running with PID ${owner}`);
        }
        rmSync(this.path, { force: true });
      }
    }
    throw new Error("Unable to acquire Codex IM daemon lock");
  }

  release(): void {
    if (!this.held) return;
    const owner = readOwner(this.path);
    if (owner === this.pid) rmSync(this.path, { force: true });
    this.held = false;
  }
}

function readOwner(path: string): number | null {
  try {
    const value = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
