import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveDataDirectory } from "../config/paths.js";
import { readRuntimeHealth } from "./runtime-status.js";

export const LAUNCHD_SERVICE_LABEL = "com.qiyuey.codex-im";

export interface LaunchdInstallOptions {
  readonly runtimeRoot: string;
  readonly envFile?: string;
  readonly nodePath?: string;
  readonly homeDirectory?: string;
  readonly dataDirectory?: string;
}

export interface LaunchdServiceState {
  readonly installed: boolean;
  readonly loaded: boolean;
  readonly running: boolean;
  readonly pid: number | null;
  readonly lastExitCode: number | null;
  readonly target: string;
  readonly plistPath: string;
}

export function launchdPlistPath(homeDirectory = homedir()): string {
  return join(homeDirectory, "Library", "LaunchAgents", `${LAUNCHD_SERVICE_LABEL}.plist`);
}

export function renderLaunchdPlist(options: LaunchdInstallOptions): string {
  const runtimeRoot = resolve(options.runtimeRoot);
  const homeDirectory = options.homeDirectory ?? homedir();
  const dataDirectory = options.dataDirectory ?? resolveDataDirectory();
  const nodePath = options.nodePath ?? preferredNodePath();
  const envFile = resolve(options.envFile ?? join(runtimeRoot, ".env"));
  const daemonPath = join(runtimeRoot, "dist", "daemon.js");
  const path = [
    join(homeDirectory, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(LAUNCHD_SERVICE_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>${xml(`--env-file-if-exists=${envFile}`)}</string>
    <string>${xml(daemonPath)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(runtimeRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${xml(homeDirectory)}</string>
    <key>PATH</key><string>${xml(path)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(join(dataDirectory, "daemon.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(dataDirectory, "daemon.error.log"))}</string>
</dict>
</plist>
`;
}

export function installLaunchdService(options: LaunchdInstallOptions): LaunchdServiceState {
  requireMacOs();
  const homeDirectory = options.homeDirectory ?? homedir();
  const previousPid = readLaunchdServiceState(homeDirectory).pid;
  const plistPath = launchdPlistPath(homeDirectory);
  mkdirSync(dirname(plistPath), { mode: 0o700, recursive: true });
  mkdirSync(options.dataDirectory ?? resolveDataDirectory(), { mode: 0o700, recursive: true });
  const temporaryPath = `${plistPath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, renderLaunchdPlist(options), { mode: 0o644 });
    chmodSync(temporaryPath, 0o644);
    renameSync(temporaryPath, plistPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  const target = serviceTarget();
  runLaunchctl(["bootout", target], true);
  waitForUnloaded(homeDirectory);
  runLaunchctl(["bootstrap", `gui/${process.getuid?.() ?? 0}`, plistPath]);
  runLaunchctl(["kickstart", "-k", target]);
  return waitForRunning(homeDirectory, previousPid);
}

export function restartLaunchdService(): LaunchdServiceState {
  requireMacOs();
  const previousPid = readLaunchdServiceState().pid;
  runLaunchctl(["kickstart", "-k", serviceTarget()]);
  return waitForRunning(homedir(), previousPid);
}

export function uninstallLaunchdService(homeDirectory = homedir()): LaunchdServiceState {
  requireMacOs();
  runLaunchctl(["bootout", serviceTarget()], true);
  rmSync(launchdPlistPath(homeDirectory), { force: true });
  return readLaunchdServiceState(homeDirectory);
}

export function readLaunchdServiceState(homeDirectory = homedir()): LaunchdServiceState {
  const target = serviceTarget();
  const result = spawnSync("launchctl", ["print", target], { encoding: "utf8" });
  const output = result.status === 0 ? result.stdout : "";
  const pid = captureNumber(output, /^\s*pid = (\d+)/m);
  const lastExitCode = captureNumber(output, /^\s*last exit code = (-?\d+)/m);
  return {
    installed: existsSync(launchdPlistPath(homeDirectory)),
    loaded: result.status === 0,
    running: /^\s*state = running$/m.test(output),
    pid,
    lastExitCode,
    target,
    plistPath: launchdPlistPath(homeDirectory),
  };
}

function serviceTarget(): string {
  return `gui/${process.getuid?.() ?? 0}/${LAUNCHD_SERVICE_LABEL}`;
}

function preferredNodePath(): string {
  for (const path of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
    if (existsSync(path)) return path;
  }
  return process.execPath;
}

function waitForRunning(homeDirectory: string, previousPid: number | null): LaunchdServiceState {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = readLaunchdServiceState(homeDirectory);
    const runtime = readRuntimeHealth();
    if (
      state.running &&
      state.pid !== null &&
      state.pid !== previousPid &&
      runtime.running &&
      runtime.compatible &&
      runtime.pid === state.pid
    ) {
      return state;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error(
    `launchd service ${LAUNCHD_SERVICE_LABEL} did not reach a healthy new running PID`,
  );
}

function waitForUnloaded(homeDirectory: string): void {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!readLaunchdServiceState(homeDirectory).loaded) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error(`launchd service ${LAUNCHD_SERVICE_LABEL} did not unload before replacement`);
}

function runLaunchctl(args: readonly string[], allowFailure = false): void {
  const result = spawnSync("launchctl", [...args], { encoding: "utf8" });
  if (!allowFailure && result.status !== 0) {
    throw new Error(result.stderr.trim() || `launchctl ${args[0]} failed`);
  }
}

function requireMacOs(): void {
  if (process.platform !== "darwin") throw new Error("launchd service management requires macOS");
}

function captureNumber(value: string, pattern: RegExp): number | null {
  const match = pattern.exec(value);
  return match?.[1] === undefined ? null : Number.parseInt(match[1], 10);
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
