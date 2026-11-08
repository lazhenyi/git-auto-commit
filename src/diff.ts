import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { collectChanges, diffText } from "./git.ts";
import type { DiffBundle, DiffSegment, FileChange } from "./types.ts";

/** Files whose diff body is rarely useful for writing a commit message. */
export const DEFAULT_EXCLUDE = [
  "*.lock",
  "*.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "composer.lock",
  "Cargo.lock",
  "poetry.lock",
  "go.sum",
  "*.min.js",
  "*.min.css",
  "*.map",
  "*.snap",
  "*.svg",
  "dist/**",
  "vendor/**",
  "node_modules/**",
];

/** Per-untracked-file cap, so one generated file cannot eat the whole budget. */
const UNTRACKED_FILE_LIMIT = 12_000;
/** Minimum slice worth including when a diff segment has to be cut. */
const MIN_PARTIAL_SEGMENT = 600;

/** Converts a glob to a RegExp. Supports `*`, `**`, `?` and `{a,b}`. */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern.charAt(i);
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if (char === "{") {
      const end = pattern.indexOf("}", i);
      if (end > i) {
        const options = pattern.slice(i + 1, end).split(",").map(escapeRegExp);
        out += `(?:${options.join("|")})`;
        i = end;
      } else {
        out += "\\{";
      }
    } else {
      out += escapeRegExp(char);
    }
  }
  return new RegExp(`^${out}$`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isExcluded(path: string, patterns: string[]): boolean {
  const base = path.split("/").pop() ?? path;
  return patterns.some((pattern) => {
    const normalized = pattern.replace(/^\.\//, "");
    if (!normalized.includes("/")) {
      // A bare pattern matches any basename, like gitignore.
      return globToRegExp(normalized).test(base);
    }
    return globToRegExp(normalized).test(path);
  });
}

/** Splits `git diff` output into one segment per file. */
export function splitDiffSegments(raw: string): DiffSegment[] {
  const segments: DiffSegment[] = [];
  let current: DiffSegment | undefined;
  let buffer: string[] = [];

  const flush = (): void => {
    if (current) {
      current.text = buffer.join("\n");
      segments.push(current);
    }
    buffer = [];
    current = undefined;
  };

  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      const path = pathFromDiffHeader(line);
      current = { path, text: "" };
      buffer.push(line);
    } else if (current) {
      buffer.push(line);
    }
  }
  flush();

  // Drop the trailing empty line git leaves behind, keeping diffs copy-pasteable.
  for (const segment of segments) segment.text = segment.text.replace(/\n+$/, "");
  return segments;
}

function pathFromDiffHeader(line: string): string {
  // `diff --git a/path b/path`; paths with spaces are quoted, which we leave be.
  const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
  return (match?.[2] ?? line).replace(/^"|"$/g, "");
}

function isBinaryContent(buffer: Buffer): boolean {
  const probe = buffer.subarray(0, Math.min(buffer.length, 8000));
  return probe.includes(0);
}

/** Builds a git-style patch for an untracked file so the model can read it. */
export async function synthesizeUntrackedSegment(
  root: string,
  file: FileChange,
): Promise<DiffSegment | undefined> {
  const absolute = join(root, file.path);
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      const target = await readlink(absolute);
      return {
        path: file.path,
        untracked: true,
        text: [
          `diff --git a/${file.path} b/${file.path}`,
          "new file mode 120000",
          "--- /dev/null",
          `+++ b/${file.path}`,
          "@@ -0,0 +1 @@",
          `+${target}`,
        ].join("\n"),
      };
    }
    if (!info.isFile()) return undefined;
    if (info.size > 2 * 1024 * 1024) {
      return {
        path: file.path,
        untracked: true,
        text: `new file: ${file.path} (${formatBytes(info.size)}, binary or too large to include)`,
      };
    }
    const buffer = await readFile(absolute);
    if (isBinaryContent(buffer)) {
      return {
        path: file.path,
        untracked: true,
        text: `new file: ${file.path} (binary, ${formatBytes(info.size)})`,
      };
    }
    let content = buffer.toString("utf8").replace(/\r\n/g, "\n");
    let cut = false;
    if (content.length > UNTRACKED_FILE_LIMIT) {
      content = content.slice(0, UNTRACKED_FILE_LIMIT);
      cut = true;
    }
    const lines = content.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const body = lines.map((line) => `+${line}`).join("\n");
    return {
      path: file.path,
      untracked: true,
      text: [
        `diff --git a/${file.path} b/${file.path}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${file.path}`,
        `@@ -0,0 +1,${lines.length} @@`,
        body,
        cut ? "\\ No newline at end of file (truncated)" : "",
      ]
        .filter((line) => line !== "")
        .join("\n"),
    };
  } catch {
    return undefined;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface TruncateOptions {
  budget: number;
}

export interface TruncateResult {
  text: string;
  rawChars: number;
  truncated: boolean;
  truncatedFiles: string[];
}

/**
 * Concatenates diff segments until `budget` characters are used.
 * Whole segments are preferred; a segment is cut only when at least
 * `MIN_PARTIAL_SEGMENT` characters still fit. Everything else is reported.
 */
export function truncateSegments(segments: DiffSegment[], options: TruncateOptions): TruncateResult {
  const pieces: string[] = [];
  const truncatedFiles: string[] = [];
  const rawChars = segments.reduce((sum, segment) => sum + segment.text.length + 1, 0);
  let used = 0;
  let truncated = false;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment) continue;
    const remaining = options.budget - used;
    const cost = segment.text.length + 1;

    if (cost <= remaining) {
      pieces.push(segment.text);
      used += cost;
      continue;
    }

    if (remaining >= MIN_PARTIAL_SEGMENT) {
      const cut = segment.text.slice(0, remaining - 120);
      pieces.push(`${cut}\n... [diff for ${segment.path} truncated at ${formatBytes(remaining)}]`);
      truncated = true;
      truncatedFiles.push(segment.path);
      used = options.budget;
      // Later files cannot fit either, but they still need to be reported.
      truncatedFiles.push(...segments.slice(index + 1).map((rest) => rest.path));
      break;
    }

    truncated = true;
    truncatedFiles.push(segment.path);
    truncatedFiles.push(...segments.slice(index + 1).map((rest) => rest.path));
    break;
  }

  if (truncated) {
    pieces.push(
      "\n[NOTE] The diff above was shortened to fit the token budget. " +
        "Only mention files you have evidence for; never invent changes.",
    );
  }

  return { text: pieces.join("\n"), rawChars, truncated, truncatedFiles };
}

export interface CollectDiffOptions {
  root: string;
  stagedOnly: boolean;
  budget: number;
  exclude?: string[];
  files?: FileChange[];
}

/** Gathers everything the model needs to see about the pending changes. */
export async function collectDiff(options: CollectDiffOptions): Promise<DiffBundle> {
  const patterns = options.exclude ?? [];
  const files = (options.files ?? collectChanges(options.root, options.stagedOnly)).map((file) => ({
    ...file,
    excluded: isExcluded(file.path, patterns),
  }));

  const raw = diffText(options.root, options.stagedOnly);
  const segments = splitDiffSegments(raw).filter((segment) => {
    const file = files.find((candidate) => candidate.path === segment.path);
    return !file?.excluded;
  });

  const untracked = files.filter((file) => file.status === "untracked" && !file.excluded);
  for (const file of untracked) {
    const segment = await synthesizeUntrackedSegment(options.root, file);
    if (segment) segments.push(segment);
  }

  const excludedFiles = files.filter((file) => file.excluded).map((file) => file.path);
  const result = truncateSegments(segments, { budget: options.budget });

  return {
    files,
    text: result.text,
    rawChars: result.rawChars,
    truncated: result.truncated,
    truncatedFiles: result.truncatedFiles,
    excludedFiles,
  };
}
