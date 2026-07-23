import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Codex keeps Chats without a Project in its product-managed local workspace.
 * This is an internal compatibility boundary, not a user-selectable directory.
 */
export function resolveCodexChatsWorkspace(homeDirectory = homedir()): string {
  return join(homeDirectory, "Documents", "Codex");
}
