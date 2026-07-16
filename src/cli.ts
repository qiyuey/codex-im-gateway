#!/usr/bin/env node
import { parseArgs } from "node:util";
import { collectGatewayHealth } from "./application/health.js";
import { AppServerClient } from "./codex/app-server-client.js";
import { type EventState, eventStates } from "./core/types.js";
import {
  installLaunchdService,
  readLaunchdServiceState,
  restartLaunchdService,
  uninstallLaunchdService,
} from "./runtime/launchd-service.js";
import { LocalKillSwitch } from "./security/kill-switch.js";
import { openEventStore, openNotificationStore } from "./storage/open-store.js";

const command = process.argv[2] ?? "help";

if (command === "help" || command === "--help" || command === "-h") {
  process.stdout.write(
    `codex-im <command>\n\nCommands:\n  health\n  doctor\n  app-server-health\n  service status\n  service install [--runtime-root <path>] [--env-file <path>]\n  service restart\n  service uninstall\n  disable\n  enable\n  events [--state <state>] [--limit <n>]\n  notifications [--state <state>] [--limit <n>]\n  recover\n`,
  );
  process.exit(0);
}

if (command === "service") {
  try {
    await runServiceCommand();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
} else if (command === "app-server-health") {
  const client = new AppServerClient();
  try {
    const response = await client.connect();
    printJson({
      status: "ok",
      platformFamily: response.platformFamily,
      platformOs: response.platformOs,
      userAgent: response.userAgent,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
} else {
  const context = openEventStore();
  const killSwitch = new LocalKillSwitch();
  try {
    if (command === "health" || command === "doctor") {
      const health = collectGatewayHealth();
      printJson(health);
      if (command === "doctor" && health.status !== "ok") process.exitCode = 1;
    } else if (command === "disable") {
      killSwitch.disable();
      printJson({ inboundEnabled: false });
    } else if (command === "enable") {
      killSwitch.enable();
      printJson({ inboundEnabled: true });
    } else if (command === "events") {
      const { values } = parseArgs({
        args: process.argv.slice(3),
        options: { limit: { type: "string", default: "20" }, state: { type: "string" } },
      });
      const state = values.state ? parseState(values.state) : undefined;
      const limit = Number.parseInt(values.limit, 10);
      printJson(context.store.list(state, limit));
    } else if (command === "notifications") {
      const { values } = parseArgs({
        args: process.argv.slice(3),
        options: { limit: { type: "string", default: "20" }, state: { type: "string" } },
      });
      const state = values.state ? parseState(values.state) : undefined;
      const limit = Number.parseInt(values.limit, 10);
      const notificationContext = openNotificationStore();
      try {
        printJson(notificationContext.store.list(state, limit));
      } finally {
        notificationContext.database.close();
      }
    } else if (command === "recover") {
      const notificationContext = openNotificationStore();
      try {
        printJson({
          recovered: context.store.recoverExpired(),
          notificationsRecovered: notificationContext.store.recoverExpired(),
        });
      } finally {
        notificationContext.database.close();
      }
    } else {
      throw new Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  } finally {
    context.database.close();
  }
}

function parseState(value: string): EventState {
  if (!eventStates.includes(value as EventState)) throw new Error(`Invalid event state: ${value}`);
  return value as EventState;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function runServiceCommand(): Promise<void> {
  const action = process.argv[3] ?? "status";
  if (action === "status") {
    printJson(readLaunchdServiceState());
    return;
  }
  if (action === "restart") {
    printJson(restartLaunchdService());
    return;
  }
  if (action === "uninstall") {
    printJson(uninstallLaunchdService());
    return;
  }
  if (action === "install") {
    const { values } = parseArgs({
      args: process.argv.slice(4),
      options: {
        "runtime-root": { type: "string", default: process.cwd() },
        "env-file": { type: "string" },
      },
    });
    printJson(
      installLaunchdService({
        runtimeRoot: values["runtime-root"],
        ...(values["env-file"] ? { envFile: values["env-file"] } : {}),
      }),
    );
    return;
  }
  throw new Error(`Unknown service command: ${action}`);
}
