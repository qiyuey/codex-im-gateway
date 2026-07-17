import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface, type Interface } from "node:readline";
import type { InitializeResponse } from "./protocol/InitializeResponse.js";
import type { RequestId } from "./protocol/RequestId.js";
import type { ServerNotification } from "./protocol/ServerNotification.js";
import type { ServerRequest } from "./protocol/ServerRequest.js";
import type { ThreadGoalGetParams } from "./protocol/v2/ThreadGoalGetParams.js";
import type { ThreadGoalGetResponse } from "./protocol/v2/ThreadGoalGetResponse.js";
import type { ThreadListParams } from "./protocol/v2/ThreadListParams.js";
import type { ThreadListResponse } from "./protocol/v2/ThreadListResponse.js";
import type { ThreadReadParams } from "./protocol/v2/ThreadReadParams.js";
import type { ThreadReadResponse } from "./protocol/v2/ThreadReadResponse.js";
import type { ThreadResumeParams } from "./protocol/v2/ThreadResumeParams.js";
import type { ThreadResumeResponse } from "./protocol/v2/ThreadResumeResponse.js";
import type { ThreadStartParams } from "./protocol/v2/ThreadStartParams.js";
import type { ThreadStartResponse } from "./protocol/v2/ThreadStartResponse.js";
import type { ToolRequestUserInputResponse } from "./protocol/v2/ToolRequestUserInputResponse.js";
import type { Turn } from "./protocol/v2/Turn.js";
import type { TurnInterruptParams } from "./protocol/v2/TurnInterruptParams.js";
import type { TurnInterruptResponse } from "./protocol/v2/TurnInterruptResponse.js";
import type { TurnStartParams } from "./protocol/v2/TurnStartParams.js";
import type { TurnStartResponse } from "./protocol/v2/TurnStartResponse.js";

interface JsonRpcResponse {
  readonly id: RequestId;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

interface JsonRpcRequest {
  readonly id: RequestId;
  readonly method: string;
  readonly params?: unknown;
}

interface JsonRpcNotification {
  readonly method: string;
  readonly params?: unknown;
}

interface PendingRequest {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AppServerClientOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly requestTimeoutMs?: number;
  readonly clientVersion?: string;
}

export interface CanonicalTurnResult {
  readonly threadId: string;
  readonly turnId: string;
  readonly status: "completed" | "failed" | "interrupted" | "in_progress";
  readonly finalMessage: string;
  readonly cwd: string;
  readonly durationMs?: number | null;
}

export interface WatchedThreadSnapshot {
  readonly threadId: string;
  readonly cwd: string;
  readonly latestTurn: CanonicalTurnResult | null;
  readonly latestTerminalTurn: CanonicalTurnResult | null;
  readonly latestTerminalTurnId: string | null;
  readonly blockedGoal: {
    readonly objective: string;
    readonly updatedAt: number;
  } | null;
}

export type UserInputRequest = Extract<ServerRequest, { method: "item/tool/requestUserInput" }>;

export interface ResolvedServerRequest {
  readonly threadId: string;
  readonly requestId: RequestId;
}

export interface CompletedTurnRef {
  readonly threadId: string;
  readonly turnId: string;
}

export class AppServerClient extends EventEmitter {
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly requestTimeoutMs: number;
  private readonly clientVersion: string;
  private readonly pending = new Map<number, PendingRequest>();
  private process: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private connectPromise: Promise<InitializeResponse> | null = null;
  private nextId = 1;
  private readonly activeTurns = new Map<string, string>();
  private readonly threadSessions = new Map<string, ThreadResumeResponse>();

  constructor(options: AppServerClientOptions = {}) {
    super();
    this.command = options.command ?? "codex";
    this.args = options.args ?? ["app-server"];
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.clientVersion = options.clientVersion ?? "0.1.0";
  }

  async connect(): Promise<InitializeResponse> {
    if (this.isConnected()) throw new Error("App-server client is already connected");
    return this.establishConnection();
  }

  isConnected(): boolean {
    return Boolean(
      this.process &&
        this.process.exitCode === null &&
        !this.process.stdin.destroyed &&
        this.process.stdin.writable,
    );
  }

  private async establishConnection(): Promise<InitializeResponse> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.spawnAndInitialize();
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async spawnAndInitialize(): Promise<InitializeResponse> {
    const child = spawn(this.command, [...this.args], { stdio: ["pipe", "pipe", "pipe"] });
    this.process = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", () => {
      // Drain diagnostics without logging potentially sensitive app-server output.
    });
    child.once("error", (error) => this.handleDisconnect(child, error));
    child.once("exit", (code, signal) => {
      this.handleDisconnect(
        child,
        new Error(`app-server exited (code=${String(code)}, signal=${String(signal)})`),
      );
    });

    try {
      const response = await this.requestConnected<InitializeResponse>("initialize", {
        clientInfo: {
          name: "codex_im_gateway",
          title: "Codex IM",
          version: this.clientVersion,
        },
        capabilities: { experimentalApi: true },
      });
      this.notify("initialized", {});
      return response;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async readTurn(threadId: string, turnId: string): Promise<CanonicalTurnResult> {
    await this.resumeThread(threadId);
    const params: ThreadReadParams = { threadId, includeTurns: true };
    const response = await this.request<ThreadReadResponse>("thread/read", params);
    const turn = response.thread.turns.find((candidate) => candidate.id === turnId);
    if (!turn) throw new Error(`Turn ${turnId} is unavailable in thread ${threadId}`);

    const finalMessage = finalAgentMessage(turn) ?? turn.error?.message ?? "";
    const status = turn.status === "inProgress" ? "in_progress" : turn.status;
    return {
      threadId: response.thread.id,
      turnId: turn.id,
      status,
      finalMessage,
      cwd: response.thread.cwd,
      durationMs: turn.durationMs ?? null,
    };
  }

  async readThreadSnapshot(threadId: string): Promise<WatchedThreadSnapshot> {
    await this.resumeThread(threadId);
    const threadParams: ThreadReadParams = { threadId, includeTurns: true };
    const goalParams: ThreadGoalGetParams = { threadId };
    const [threadResponse, goalResponse] = await Promise.all([
      this.request<ThreadReadResponse>("thread/read", threadParams),
      this.request<ThreadGoalGetResponse>("thread/goal/get", goalParams),
    ]);
    const visibleTurns = threadResponse.thread.turns.filter(
      (turn) =>
        isCanonicalCodexTurn(turn) && (turn.status === "inProgress" || isStableTerminalTurn(turn)),
    );
    const latest = visibleTurns.at(-1) ?? null;
    const latestTerminal = visibleTurns.findLast((turn) => isStableTerminalTurn(turn));
    const goal = goalResponse.goal;
    return {
      threadId: threadResponse.thread.id,
      cwd: threadResponse.thread.cwd,
      latestTurn: latest
        ? mapTurnResult(threadResponse.thread.id, latest, "", threadResponse.thread.cwd)
        : null,
      latestTerminalTurn: latestTerminal
        ? mapTurnResult(threadResponse.thread.id, latestTerminal, "", threadResponse.thread.cwd)
        : null,
      latestTerminalTurnId: latestTerminal?.id ?? null,
      blockedGoal:
        goal?.status === "blocked"
          ? { objective: goal.objective, updatedAt: goal.updatedAt }
          : null,
    };
  }

  async resumeThread(threadId: string): Promise<ThreadResumeResponse> {
    const active = this.threadSessions.get(threadId);
    if (active) return active;
    const params: ThreadResumeParams = { threadId };
    const response = await this.request<ThreadResumeResponse>("thread/resume", params);
    this.threadSessions.set(threadId, response);
    return response;
  }

  async startThread(cwd: string): Promise<ThreadStartResponse> {
    const params: ThreadStartParams = { cwd, sandbox: "danger-full-access" };
    const response = await this.request<ThreadStartResponse>("thread/start", params);
    this.threadSessions.set(response.thread.id, response);
    return response;
  }

  async listThreads(limit = 10, cursor?: string): Promise<ThreadListResponse> {
    const params: ThreadListParams = {
      limit,
      ...(cursor ? { cursor } : {}),
      sortKey: "updated_at",
      sortDirection: "desc",
      archived: false,
    };
    return this.request<ThreadListResponse>("thread/list", params);
  }

  async runTurn(
    threadId: string,
    text: string,
    onDelta?: (fullText: string) => void,
    completionTimeoutMs = 30 * 60_000,
  ): Promise<CanonicalTurnResult> {
    const resumed = await this.resumeThread(threadId);
    const params: TurnStartParams = {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      sandboxPolicy: { type: "dangerFullAccess" },
    };
    let turnId: string | null = null;
    let streamedText = "";

    let resolveCompletion!: (turn: Turn) => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<Turn>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const timer = setTimeout(
      () => rejectCompletion(new Error(`Codex turn timed out for thread ${threadId}`)),
      completionTimeoutMs,
    );
    const handler = (notification: ServerNotification) => {
      if (
        notification.method === "item/agentMessage/delta" &&
        notification.params.threadId === threadId &&
        (!turnId || notification.params.turnId === turnId)
      ) {
        streamedText += notification.params.delta;
        onDelta?.(streamedText);
      }
      if (
        notification.method === "turn/completed" &&
        notification.params.threadId === threadId &&
        (!turnId || notification.params.turn.id === turnId)
      ) {
        resolveCompletion(notification.params.turn);
      }
    };
    this.on("notification", handler);

    try {
      const response = await this.request<TurnStartResponse>("turn/start", params);
      turnId = response.turn.id;
      this.activeTurns.set(threadId, turnId);
      const turn = response.turn.status === "inProgress" ? await completion : response.turn;
      return mapTurnResult(threadId, turn, streamedText, resumed.cwd);
    } finally {
      clearTimeout(timer);
      this.off("notification", handler);
      this.activeTurns.delete(threadId);
    }
  }

  async interruptThread(threadId: string): Promise<boolean> {
    const turnId = this.activeTurns.get(threadId);
    if (!turnId) return false;
    const params: TurnInterruptParams = { threadId, turnId };
    await this.request<TurnInterruptResponse>("turn/interrupt", params);
    return true;
  }

  onUserInputRequest(handler: (request: UserInputRequest) => void): () => void {
    this.on("userInputRequest", handler);
    return () => this.off("userInputRequest", handler);
  }

  onServerRequestResolved(handler: (request: ResolvedServerRequest) => void): () => void {
    this.on("serverRequestResolved", handler);
    return () => this.off("serverRequestResolved", handler);
  }

  onTurnCompleted(handler: (turn: CompletedTurnRef) => void): () => void {
    this.on("turnCompleted", handler);
    return () => this.off("turnCompleted", handler);
  }

  respondToUserInput(requestId: RequestId, response: ToolRequestUserInputResponse): void {
    this.send({ id: requestId, result: response });
  }

  rejectUserInput(requestId: RequestId, message: string): void {
    this.send({ id: requestId, error: { code: -32602, message } });
  }

  async request<TResult>(method: string, params: unknown): Promise<TResult> {
    if (!this.isConnected()) await this.establishConnection();
    return this.requestConnected<TResult>(method, params);
  }

  private requestConnected<TResult>(method: string, params: unknown): Promise<TResult> {
    const id = this.nextId++;
    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-server request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: (result) => resolve(result as TResult),
        reject,
        timer,
      });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async close(): Promise<void> {
    const child = this.process;
    this.process = null;
    this.lines?.close();
    this.lines = null;
    this.threadSessions.clear();
    this.failAll(new Error("App-server client closed"));
    if (!child || child.exitCode !== null) return;

    child.stdin.end();
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const force = setTimeout(() => child.kill("SIGTERM"), 1_000);
    await exited;
    clearTimeout(force);
  }

  private notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  private send(message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
    if (!this.process?.stdin.writable) throw new Error("App-server client is not connected");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: JsonRpcResponse | JsonRpcRequest | JsonRpcNotification;
    try {
      message = JSON.parse(line) as JsonRpcResponse | JsonRpcRequest | JsonRpcNotification;
    } catch {
      this.emit("protocolError", new Error("app-server emitted invalid JSON"));
      return;
    }

    if ("id" in message && !("method" in message)) {
      const pending = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id as number);
      if (message.error)
        pending.reject(
          new Error(`app-server error ${message.error.code}: ${message.error.message}`),
        );
      else pending.resolve(message.result);
      return;
    }

    if ("id" in message && "method" in message) {
      const request = message as ServerRequest;
      if (request.method === "item/tool/requestUserInput") {
        if (this.emit("userInputRequest", request)) return;
      }
      this.send({ id: message.id, error: { code: -32601, message: "Method not supported" } });
      return;
    }

    const notification = message as ServerNotification;
    this.emit("notification", notification);
    if (notification.method === "serverRequest/resolved") {
      this.emit("serverRequestResolved", notification.params);
    } else if (notification.method === "turn/completed") {
      this.emit("turnCompleted", {
        threadId: notification.params.threadId,
        turnId: notification.params.turn.id,
      } satisfies CompletedTurnRef);
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private handleDisconnect(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.process !== child) return;
    this.failAll(error);
    this.process = null;
    this.lines?.close();
    this.lines = null;
    this.threadSessions.clear();
    this.activeTurns.clear();
  }
}

function mapTurnResult(
  threadId: string,
  turn: Turn,
  streamedText: string,
  cwd: string,
): CanonicalTurnResult {
  return {
    threadId,
    turnId: turn.id,
    status: turn.status === "inProgress" ? "in_progress" : turn.status,
    finalMessage: finalAgentMessage(turn) ?? turn.error?.message ?? streamedText,
    cwd,
    durationMs: turn.durationMs ?? null,
  };
}

function isCanonicalCodexTurn(turn: Turn): boolean {
  return UUID_V7_PATTERN.test(turn.id);
}

function isStableTerminalTurn(turn: Turn): boolean {
  if (
    !isCanonicalCodexTurn(turn) ||
    turn.status === "inProgress" ||
    typeof turn.completedAt !== "number"
  ) {
    return false;
  }
  if (turn.status === "completed") return Boolean(finalAgentMessage(turn)?.trim());
  if (turn.status === "failed")
    return Boolean(turn.error?.message || finalAgentMessage(turn)?.trim());
  return true;
}

function finalAgentMessage(turn: Turn): string | null {
  const messages = turn.items.filter(
    (item): item is Extract<(typeof turn.items)[number], { type: "agentMessage" }> =>
      item.type === "agentMessage",
  );
  const explicitFinal = messages.findLast((message) => message.phase === "final_answer");
  if (explicitFinal) return explicitFinal.text;
  if (messages.some((message) => message.phase !== null)) return null;
  return messages.at(-1)?.text ?? null;
}
