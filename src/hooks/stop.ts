import { parseCompletionEventType } from "../core/validation.js";
import { openEventStore } from "../storage/open-store.js";

const MAX_INPUT_BYTES = 256 * 1024;

interface StopHookInput {
  readonly session_id?: unknown;
  readonly turn_id?: unknown;
  readonly cwd?: unknown;
  readonly hook_event_name?: unknown;
  readonly event_type?: unknown;
}

async function main(): Promise<void> {
  try {
    const raw = await readStdin();
    const input = JSON.parse(raw) as StopHookInput;
    const threadId = requireString(input.session_id, "session_id");
    const turnId = requireString(input.turn_id, "turn_id");
    const cwd = requireString(input.cwd, "cwd");
    if (input.hook_event_name !== "Stop") return;

    const { database, store } = openEventStore();
    try {
      store.enqueue({
        codexThreadId: threadId,
        codexTurnId: turnId,
        cwd,
        eventType: parseCompletionEventType(input.event_type),
        idempotencyKey: `${threadId}:${turnId}`,
        payload: {},
      });
    } finally {
      database.close();
    }
  } catch {
    // Completion notification must never block or fail the Codex turn.
    process.stderr.write("codex-im-gateway: unable to queue completion event\n");
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
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing ${name}`);
  return value;
}

await main();
