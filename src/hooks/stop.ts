import { pathToFileURL } from "node:url";
import { parseCompletionEventType } from "../core/validation.js";
import { openEventStore } from "../storage/open-store.js";

const MAX_INPUT_BYTES = 256 * 1024;

export interface StopHookInput {
  readonly session_id?: unknown;
  readonly turn_id?: unknown;
  readonly transcript_path?: unknown;
  readonly cwd?: unknown;
  readonly hook_event_name?: unknown;
  readonly event_type?: unknown;
}

export function enqueueStopEvent(
  input: StopHookInput,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (input.hook_event_name !== "Stop") return false;
  if (typeof input.transcript_path !== "string" || input.transcript_path.length === 0) {
    return false;
  }

  const threadId = requireString(input.session_id, "session_id");
  const turnId = requireString(input.turn_id, "turn_id");
  const cwd = requireString(input.cwd, "cwd");
  const { database, store } = openEventStore(env);
  try {
    store.enqueue({
      codexThreadId: threadId,
      codexTurnId: turnId,
      cwd,
      eventType: parseCompletionEventType(input.event_type),
      idempotencyKey: `${threadId}:${turnId}`,
      payload: {},
      ingress: { producer: "stop_hook" },
    });
    return true;
  } finally {
    database.close();
  }
}

async function main(): Promise<void> {
  try {
    const raw = await readStdin();
    enqueueStopEvent(JSON.parse(raw) as StopHookInput);
  } catch {
    // Notification capture must never block or fail the Codex turn.
    process.stderr.write("codex-im: unable to queue completion event\n");
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_INPUT_BYTES) throw new Error("Hook input is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function requireString(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    value.includes("\0")
  ) {
    throw new Error(`Missing or invalid ${name}`);
  }
  return value;
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryPoint === import.meta.url) await main();
