import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { isWorkspaceAllowed } from "../security/workspace.js";

export const NO_PROJECT_ID = "none";

export interface ProjectThread {
  readonly id: string;
  readonly cwd: string;
  readonly name: string | null;
  readonly preview: string;
}

export interface ThreadProject {
  readonly id: string;
  readonly label: string;
  readonly root: string;
  readonly threads: readonly ProjectThread[];
}

export interface ThreadProjectCatalog {
  readonly projects: readonly ThreadProject[];
  readonly noProjectThreads: readonly ProjectThread[];
}

export async function buildThreadProjectCatalog(
  threads: readonly ProjectThread[],
  allowedRoots: readonly string[],
): Promise<ThreadProjectCatalog> {
  const projects = new Map<string, { root: string; threads: ProjectThread[] }>();
  const noProjectThreads: ProjectThread[] = [];

  for (const thread of threads) {
    if (!(await isWorkspaceAllowed(thread.cwd, allowedRoots))) continue;
    const projectRoot = await findProjectRoot(thread.cwd, allowedRoots);
    if (!projectRoot) {
      noProjectThreads.push(thread);
      continue;
    }
    const existing = projects.get(projectRoot);
    if (existing) existing.threads.push(thread);
    else projects.set(projectRoot, { root: projectRoot, threads: [thread] });
  }

  return {
    projects: [...projects.values()].map((project) => ({
      id: projectId(project.root),
      label: basename(project.root) || project.root,
      root: project.root,
      threads: project.threads,
    })),
    noProjectThreads,
  };
}

async function findProjectRoot(
  candidatePath: string,
  allowedRoots: readonly string[],
): Promise<string | null> {
  let candidate: string;
  try {
    candidate = await realpath(candidatePath);
  } catch {
    return null;
  }
  const boundary = await nearestAllowedRoot(candidate, allowedRoots);
  if (!boundary) return null;

  let current = candidate;
  while (true) {
    if (await exists(join(current, ".git"))) return current;
    if (current === boundary) return null;
    const parent = dirname(current);
    if (parent === current || !isContained(boundary, parent)) return null;
    current = parent;
  }
}

async function nearestAllowedRoot(
  candidate: string,
  allowedRoots: readonly string[],
): Promise<string | null> {
  const matches: string[] = [];
  for (const root of allowedRoots) {
    try {
      const canonicalRoot = await realpath(root);
      if (isContained(canonicalRoot, candidate)) matches.push(canonicalRoot);
    } catch {
      // Invalid allowlist roots are ignored consistently with isWorkspaceAllowed.
    }
  }
  return matches.sort((left, right) => right.length - left.length)[0] ?? null;
}

function isContained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function projectId(root: string): string {
  return createHash("sha256").update(root).digest("base64url").slice(0, 16);
}
