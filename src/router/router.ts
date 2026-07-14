export interface ThreadBinding {
  readonly codexThreadId: string;
  readonly codexTurnId: string | null;
}

export interface RouteInput {
  readonly replyToMessageId?: string;
  readonly replyBinding?: ThreadBinding | null;
  readonly topicBinding?: ThreadBinding | null;
  readonly explicitThreadId?: string | null;
  readonly activeThreadId?: string | null;
}

export type RouteDecision =
  | {
      readonly kind: "routed";
      readonly threadId: string;
      readonly source: "reply" | "topic" | "explicit" | "active";
    }
  | { readonly kind: "error"; readonly code: "unknown_reply" | "selection_required" };

export function routeMessage(input: RouteInput): RouteDecision {
  if (input.replyToMessageId) {
    if (!input.replyBinding) return { kind: "error", code: "unknown_reply" };
    return { kind: "routed", threadId: input.replyBinding.codexThreadId, source: "reply" };
  }
  if (input.topicBinding) {
    return { kind: "routed", threadId: input.topicBinding.codexThreadId, source: "topic" };
  }
  if (input.explicitThreadId) {
    return { kind: "routed", threadId: input.explicitThreadId, source: "explicit" };
  }
  if (input.activeThreadId) {
    return { kind: "routed", threadId: input.activeThreadId, source: "active" };
  }
  return { kind: "error", code: "selection_required" };
}
