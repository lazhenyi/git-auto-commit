import { spawnSync } from "node:child_process";
import { GacError } from "./errors.ts";
import type { ChangeStatus, FileChange } from "./types.ts";

export interface GitRunOptions {
  cwd?: string;
  /** Return the result instead of throwing when git exits non-zero. */
  allowFailure?: boolean;
  input?: string;
  env?: NodeJS.ProcessEnv;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function git(args: string[], options: GitRunOptions = {}): GitResult {
  const result = spawnSync("git", args, {
    cwd: options.cwd,
    input: options.input,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });

  if (result.error) {
    throw new GacError(`Could not run git: ${result.error.message}`, {
      hint: "Make sure git is installed and on your PATH.",
    });
  }

  const out: GitResult = {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.status ?? 1,
  };

  if (out.code !== 0 && !options.allowFailure) {
    throw new GacError(formatGitError(args, out), {
      hint: "Run the same command manually to inspect the full output.",
    });
  }

  return out;
}

function formatGitError(args: string[], result: GitResult): string {
  const detail = (result.stderr || result.stdout).trim();
  return `git ${args.join(" ")} failed (exit ${result.code})${detail ? `:\n${detail}` : ""}`;
}

export function isGitAvailable(): boolean {
  const result = spawnSync("git", ["--version"], { encoding: "utf8" });
  return !result.error && result.status === 0;
}

export function repoRoot(cwd?: string): string {
  const result = git(["rev-parse", "--show-toplevel"], { cwd, allowFailure: true });
  if (result.code !== 0) {
    throw new GacError("Not inside a git work tree.", {
      hint: "Run `gac` from a repository, or `git init` first.",
    });
  }
  return result.stdout.trim();
}

export function currentBranch(cwd: string): string {
  const result = git(["symbolic-ref", "--short", "-q", "HEAD"], { cwd, allowFailure: true });
  if (result.code === 0 && result.stdout.trim()) return result.stdout.trim();
  const sha = git(["rev-parse", "--short", "HEAD"], { cwd, allowFailure: true });
  return sha.code === 0 ? `detached@${sha.stdout.trim()}` : "(unborn)";
}

export function recentSubjects(cwd: string, count = 20): string[] {
  const result = git(["log", `-n${count}`, "--pretty=format:%s"], { cwd, allowFailure: true });
  if (result.code !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function hasHead(cwd: string): boolean {
  return git(["rev-parse", "--verify", "-q", "HEAD"], { cwd, allowFailure: true }).code === 0;
}

/** The well-known hash of an empty tree, used before the first commit exists. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function diffBase(cwd: string, stagedOnly: boolean): string[] {
  if (stagedOnly) return ["--cached"];
  return hasHead(cwd) ? ["HEAD"] : [EMPTY_TREE];
}

/** Candidate paths that also have unstaged edits in the work tree. */
export function pathsWithUnstagedChanges(cwd: string, paths: string[]): string[] {
  const wanted = new Set(paths);
  return statusEntries(cwd)
    .filter((entry) => wanted.has(entry.path) && entry.worktree !== " " && entry.worktree !== "?")
    .map((entry) => entry.path);
}

export function hasStagedChanges(cwd: string): boolean {
  return git(["diff", "--cached", "--quiet"], { cwd, allowFailure: true }).code === 1;
}

export function hasUpstream(cwd: string): boolean {
  return git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
    cwd,
    allowFailure: true,
  }).code === 0;
}

export function shortHead(cwd: string): string {
  const result = git(["rev-parse", "--short", "HEAD"], { cwd, allowFailure: true });
  return result.code === 0 ? result.stdout.trim() : "";
}

export interface StatusEntry {
  /** Status of the index (HEAD -> index). */
  index: string;
  /** Status of the work tree (index -> work tree). */
  worktree: string;
  path: string;
  from?: string;
}

/**
 * Parses `git status --porcelain=v1 -z` output.
 * Entries are `XY path\0`, and renames/copies add an extra `from\0` token.
 */
export function parseStatusZ(raw: string): StatusEntry[] {
  const tokens = raw.split("\0");
  const entries: StatusEntry[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    // The two status letters are followed by a space (even when one is empty).
    if (token.length < 4) continue;
    const index = token[0] ?? " ";
    const worktree = token[1] ?? " ";
    const path = token.slice(3);
    const entry: StatusEntry = { index, worktree, path };
    if (index === "R" || index === "C" || worktree === "R" || worktree === "C") {
      const from = tokens[i + 1];
      if (from) {
        entry.from = from;
        i += 1;
      }
    }
    entries.push(entry);
  }

  return entries;
}

export function statusEntries(cwd: string): StatusEntry[] {
  const result = git(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=no"],
    { cwd },
  );
  return parseStatusZ(result.stdout);
}

export interface NumstatEntry {
  path: string;
  insertions: number;
  deletions: number;
  binary: boolean;
  from?: string;
}

/** `git diff [--cached] --numstat` parsed into per-file line counts. */
export function parseNumstat(raw: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!match) continue;
    const [, added, removed, rest] = match;
    const insertions = added === "-" ? 0 : Number(added);
    const deletions = removed === "-" ? 0 : Number(removed);
    // Renames are printed as `path/{old => new}` or `old => new` here.
    const path = rest ?? "";
    entries.push({
      path,
      insertions,
      deletions,
      binary: added === "-" && removed === "-",
    });
  }
  return entries;
}

export function numstat(cwd: string, stagedOnly: boolean): NumstatEntry[] {
  const args = [
    "-c",
    "core.quotePath=false",
    "diff",
    ...diffBase(cwd, stagedOnly),
    "--numstat",
    "--no-color",
    "--no-ext-diff",
  ];
  const result = git(args, { cwd, allowFailure: true });
  return result.code === 0 ? parseNumstat(result.stdout) : [];
}

const STATUS_BY_CODE: Record<string, ChangeStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "typechange",
  U: "unmerged",
  "?": "untracked",
  "!": "ignored",
};

export function statusFromCode(code: string): ChangeStatus {
  return STATUS_BY_CODE[code] ?? "modified";
}

/**
 * Builds the candidate file list for a commit.
 *
 * - `stagedOnly: false` → every work-tree change (index + working tree + untracked).
 * - `stagedOnly: true`  → only paths with staged changes.
 */
export function collectChanges(cwd: string, stagedOnly: boolean): FileChange[] {
  const entries = statusEntries(cwd);
  const stats = new Map<string, NumstatEntry>();
  for (const entry of numstat(cwd, stagedOnly)) stats.set(entry.path, entry);

  const files = new Map<string, FileChange>();

  for (const entry of entries) {
    const staged = entry.index !== " " && entry.index !== "?" && entry.index !== "!";
    const changed = entry.worktree !== " " || staged;
    if (entry.index === "!" || entry.worktree === "!") continue;
    if (!changed) continue;
    if (stagedOnly && !staged) continue;

    const code = entry.index !== " " && entry.index !== "?" ? entry.index : entry.worktree;
    const stat = stats.get(entry.path);
    files.set(entry.path, {
      path: entry.path,
      status: statusFromCode(code),
      insertions: stat?.insertions ?? 0,
      deletions: stat?.deletions ?? 0,
      binary: stat?.binary ?? false,
      excluded: false,
      ...(entry.from ? { from: entry.from } : {}),
    });
  }

  // `git diff HEAD` covers changes that `git status` may fold together; make sure
  // nothing from the numstat list is silently dropped.
  for (const stat of stats.values()) {
    if (files.has(stat.path)) continue;
    if (stats.size > 0 && stat.path.includes("=>")) continue;
    files.set(stat.path, {
      path: stat.path,
      status: "modified",
      insertions: stat.insertions,
      deletions: stat.deletions,
      binary: stat.binary,
      excluded: false,
      ...(stat.from ? { from: stat.from } : {}),
    });
  }

  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function diffText(cwd: string, stagedOnly: boolean): string {
  const args = [
    "-c",
    "core.quotePath=false",
    "diff",
    ...diffBase(cwd, stagedOnly),
    "--no-color",
    "--no-ext-diff",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "-U3",
  ];
  const result = git(args, { cwd, allowFailure: true });
  if (result.code !== 0) {
    throw new GacError(`Could not read the diff:\n${result.stderr.trim()}`);
  }
  return result.stdout;
}

/**
 * Stages only the given paths, tolerating paths that git cannot match
 * (for example a deletion that is already in the index).
 */
export function stagePaths(cwd: string, paths: string[]): void {
  if (paths.length === 0) return;

  const stagedDeletions = new Set(
    statusEntries(cwd)
      .filter((entry) => entry.index === "D" && entry.worktree === " ")
      .map((entry) => entry.path),
  );
  const toStage = paths.filter((path) => !stagedDeletions.has(path));
  if (toStage.length === 0) return;

  const input = `${toStage.join("\0")}\0`;
  const args = ["add", "--all", "--pathspec-from-file=-", "--pathspec-file-nul"];
  const result = git(args, { cwd, input, allowFailure: true });
  if (result.code === 0) return;

  // Fall back to one path at a time so a single stale path does not abort the run.
  for (const path of toStage) {
    git(["add", "--all", "--", path], { cwd, allowFailure: true });
  }
}

/**
 * Stages every work-tree change.
 *
 * A pathspec-restricted `git add` fails on already-staged deletions
 * (`git add --all -- path` exits 128 when `path` matches nothing), and in the
 * default mode the candidate list *is* every change, so a full `git add --all`
 * is both simpler and safer.
 */
export function stageAll(cwd: string): void {
  git(["add", "--all"], { cwd });
}

export interface CommitOptions {
  cwd: string;
  message: string;
  body?: string;
  /** Restrict the commit to these paths (uses a pathspec). */
  paths?: string[];
  noVerify?: boolean;
  allowEmpty?: boolean;
}

export function commit(options: CommitOptions): string {
  const args = ["commit", "-m", options.message];
  if (options.body) args.push("-m", options.body);
  if (options.noVerify) args.push("--no-verify");
  if (options.allowEmpty) args.push("--allow-empty");
  if (options.paths && options.paths.length > 0) args.push("--", ...options.paths);

  const result = git(args, { cwd: options.cwd, allowFailure: true });
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new GacError(`git commit failed${detail ? `:\n${detail}` : "."}`, {
      hint:
        "Fix the reported problem and retry. " +
        "If a git hook is blocking the commit, rerun with --no-verify.",
    });
  }
  return shortHead(options.cwd);
}

export function push(cwd: string): void {
  const args = hasUpstream(cwd) ? ["push"] : ["push", "--set-upstream", "origin", "HEAD"];
  const result = git(args, { cwd, allowFailure: true });
  if (result.code !== 0) {
    throw new GacError(`git ${args.join(" ")} failed:\n${(result.stderr || result.stdout).trim()}`);
  }
}

export function gitConfigValue(cwd: string, key: string): string | undefined {
  const result = git(["config", "--get", key], { cwd, allowFailure: true });
  if (result.code !== 0) return undefined;
  const value = result.stdout.trim();
  return value || undefined;
}

export function setAlias(name: string, command: string): void {
  git(["config", "--global", "alias." + name, command]);
}

export function unsetAlias(name: string): void {
  git(["config", "--global", "--unset", "alias." + name], { allowFailure: true });
}
