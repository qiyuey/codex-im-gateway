#!/usr/bin/env node
import { parseArgs } from "node:util";
import { AppServerClient } from "./codex/app-server-client.js";
import { resolveDatabasePath } from "./config/paths.js";
import { type EventState, eventStates } from "./core/types.js";
import { LocalKillSwitch } from "./security/kill-switch.js";
import { openEventStore } from "./storage/open-store.js";

const command = process.argv[2] ?? "help";

if (command === "help" || command === "--help" || command === "-h") {
  process.stdout.write(
    `codex-im-gateway <command>\n\nCommands:\n  health\n  app-server-health\n  disable\n  enable\n  events [--state <state>] [--limit <n>]\n  recover\n`,
  );
  process.exit(0);
}

if (command === "app-server-health") {
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
    if (command === "health") {
      printJson({
        status: "ok",
        inboundEnabled: killSwitch.isInboundEnabled(),
        databasePath: resolveDatabasePath(),
        ...context.store.counts(),
      });
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
    } else if (command === "recover") {
      printJson({ recovered: context.store.recoverExpired() });
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
