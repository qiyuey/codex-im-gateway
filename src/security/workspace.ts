import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

export async function isWorkspaceAllowed(
  candidatePath: string,
  allowedRoots: readonly string[],
): Promise<boolean> {
  try {
    const candidate = await realpath(candidatePath);
    for (const configured of allowedRoots) {
      const root = await realpath(configured);
      const relation = relative(root, candidate);
      if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) return true;
    }
    return false;
  } catch {
    return false;
  }
}
