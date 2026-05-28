import path from "node:path";
import { opencodeClient } from "../../opencode/client.js";
import { getBrowserRoots } from "./browser-roots.js";
import {
  MAX_ENTRIES_PER_PAGE,
  pathToDisplayPath,
  type DirectoryEntry,
  type DirectoryScanError,
  type DirectoryScanResult,
} from "./file-tree.js";

function findBrowserRoot(dirPath: string): string | null {
  const normalizedPath = path.resolve(dirPath);
  const roots = getBrowserRoots()
    .map((root) => path.resolve(root))
    .sort((a, b) => b.length - a.length);

  for (const root of roots) {
    if (normalizedPath === root || normalizedPath.startsWith(root + path.sep)) {
      return root;
    }
  }

  return null;
}

function relativeRemotePath(root: string, dirPath: string): string {
  const relative = path.relative(root, dirPath);
  return relative === "" ? "." : relative.replace(/\\/g, "/");
}

/**
 * Browse directories on the OpenCode server host, not the Telegram bot host.
 * OPEN_BROWSER_ROOTS is therefore interpreted as remote OpenCode filesystem
 * roots. This matters when the bot talks to a remote OpenCode server whose
 * worktree paths do not exist locally on the bot machine.
 */
export async function scanRemoteDirectory(
  dirPath: string,
  page: number = 0,
): Promise<DirectoryScanResult | DirectoryScanError> {
  const root = findBrowserRoot(dirPath);
  if (!root) {
    return { error: `Path is outside allowed roots: ${dirPath}`, code: "EACCES" };
  }

  const remotePath = relativeRemotePath(root, dirPath);
  const { data, error } = await opencodeClient.file.list({ directory: root, path: remotePath });
  if (error || !data) {
    return {
      error: error instanceof Error ? error.message : `Cannot browse directory: ${dirPath}`,
      code: "UNKNOWN",
    };
  }

  const subdirs: DirectoryEntry[] = data
    .filter((entry) => entry.type === "directory" && !entry.name.startsWith("."))
    .map((entry) => ({ name: entry.name, fullPath: entry.absolute }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  const parentPath = path.dirname(dirPath);
  const hasParent = path.resolve(dirPath) !== path.resolve(root);
  const totalPages = Math.max(1, Math.ceil(subdirs.length / MAX_ENTRIES_PER_PAGE));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const start = safePage * MAX_ENTRIES_PER_PAGE;

  return {
    entries: subdirs.slice(start, start + MAX_ENTRIES_PER_PAGE),
    totalCount: subdirs.length,
    page: safePage,
    currentPath: dirPath,
    displayPath: pathToDisplayPath(dirPath),
    hasParent,
    parentPath: hasParent ? parentPath : null,
  };
}
