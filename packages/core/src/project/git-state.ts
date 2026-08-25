import { execFileSync } from "node:child_process";
import { relative, resolve, sep } from "node:path";

export interface GitProjectState {
  available: boolean;
  root?: string;
  branch?: string;
  head?: string;
  dirty: boolean;
  changedFiles: string[];
  trackedFiles: Set<string>;
  untrackedFiles: Set<string>;
}

function runGit(cwd: string, args: readonly string[], maxBuffer = 16 * 1024 * 1024): Buffer {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10_000,
    maxBuffer,
  });
}

function text(cwd: string, args: readonly string[]): string | undefined {
  try {
    const value = runGit(cwd, args).toString("utf8").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function nulPaths(cwd: string, args: readonly string[]): Set<string> {
  try {
    return new Set(
      runGit(cwd, args)
        .toString("utf8")
        .split("\0")
        .filter(Boolean)
        .map((path) => path.replaceAll("\\", "/")),
    );
  } catch {
    return new Set();
  }
}

function relativeRoot(root: string, cwd: string): string {
  const prefix = relative(resolve(root), resolve(cwd));
  if (!prefix || prefix === ".") return "";
  if (prefix === ".." || prefix.startsWith(`..${sep}`)) return "";
  return prefix.replaceAll(sep, "/");
}

function scopeRepoPath(path: string, prefix: string): string | undefined {
  const normalized = path.replaceAll("\\", "/");
  if (!prefix) return normalized;
  const rootPrefix = `${prefix.replace(/\/$/u, "")}/`;
  return normalized.startsWith(rootPrefix) ? normalized.slice(rootPrefix.length) : undefined;
}

function parseChangedFiles(cwd: string, root: string): string[] {
  let records: string[];
  try {
    records = runGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."])
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
  } catch {
    return [];
  }

  const prefix = relativeRoot(root, cwd);
  const changed = new Set<string>();
  let renameSourceExpected = false;
  for (const record of records) {
    if (renameSourceExpected) {
      const scoped = scopeRepoPath(record, prefix);
      if (scoped) changed.add(scoped);
      renameSourceExpected = false;
      continue;
    }
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    const repoPath = record.slice(3);
    const scoped = scopeRepoPath(repoPath, prefix);
    if (scoped) changed.add(scoped);
    if (status.includes("R") || status.includes("C")) renameSourceExpected = true;
  }
  return [...changed].sort();
}

export function readGitProjectState(cwd: string): GitProjectState {
  const root = text(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) {
    return {
      available: false,
      dirty: false,
      changedFiles: [],
      trackedFiles: new Set(),
      untrackedFiles: new Set(),
    };
  }

  const trackedFiles = nulPaths(cwd, ["ls-files", "--cached", "-z", "--", "."]);
  const untrackedFiles = nulPaths(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."]);
  const changedFiles = parseChangedFiles(cwd, root);
  const branch = text(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const head = text(cwd, ["rev-parse", "--verify", "HEAD"]);

  return {
    available: true,
    root: resolve(root),
    ...(branch ? { branch } : {}),
    ...(head ? { head } : {}),
    dirty: changedFiles.length > 0,
    changedFiles,
    trackedFiles,
    untrackedFiles,
  };
}
