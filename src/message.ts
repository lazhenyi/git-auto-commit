import { PlanError } from "./errors.ts";
import type { CommitPlanItem, FileChange, Message } from "./types.ts";

export const COMMIT_TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
] as const;

export type CommitType = (typeof COMMIT_TYPES)[number];

const TYPE_ALIASES: Record<string, CommitType> = {
  feature: "feat",
  feat: "feat",
  add: "feat",
  bug: "fix",
  bugfix: "fix",
  hotfix: "fix",
  fix: "fix",
  fixes: "fix",
  doc: "docs",
  docs: "docs",
  documentation: "docs",
  style: "style",
  format: "style",
  formatting: "style",
  refactor: "refactor",
  cleanup: "refactor",
  perf: "perf",
  performance: "perf",
  optimize: "perf",
  test: "test",
  tests: "test",
  testing: "test",
  build: "build",
  deps: "build",
  dependency: "build",
  ci: "ci",
  chore: "chore",
  misc: "chore",
  maintenance: "chore",
  revert: "revert",
};

const EMOJI: Record<string, string> = {
  feat: "✨",
  fix: "🐛",
  docs: "📝",
  style: "💄",
  refactor: "♻️",
  perf: "⚡️",
  test: "✅",
  build: "📦",
  ci: "👷",
  chore: "🔧",
  revert: "⏪",
};

const HEADER_PATTERN =
  /^(?<type>[A-Za-z]+)(?:\((?<scope>[^)]*)\))?(?<bang>!)?\s*:\s*(?<subject>.+)$/;

export interface RawCommit {
  type?: string;
  scope?: string;
  subject?: string;
  message?: string;
  body?: string;
  breaking?: boolean;
  files?: string[];
}

/** Pulls JSON out of a model answer that may contain prose or code fences. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new PlanError("The model returned an empty response.");

  const candidates: string[] = [trimmed];

  const fenced = /```(?:json|jsonc)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const firstBrace = trimmed.indexOf("{");
  const firstBracket = trimmed.indexOf("[");
  const start = [firstBrace, firstBracket].filter((value) => value >= 0).sort((a, b) => a - b)[0];
  if (start !== undefined) {
    const lastBrace = trimmed.lastIndexOf("}");
    const lastBracket = trimmed.lastIndexOf("]");
    const end = Math.max(lastBrace, lastBracket);
    if (end > start) candidates.push(trimmed.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next candidate
    }
  }

  throw new PlanError(
    `The model did not return valid JSON:\n${truncateForDisplay(trimmed)}`,
    "Retry, or use --model with a model that follows JSON instructions well.",
  );
}

function truncateForDisplay(text: string, limit = 500): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}

function bodyAfterFirstLine(text: string): string | undefined {
  const parts = text.split("\n");
  parts.shift();
  const body = parts.join("\n").trim();
  return body ? body : undefined;
}

function toRawCommit(value: unknown): RawCommit | undefined {
  if (typeof value === "string") {
    return { message: value };
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const files = Array.isArray(record.files)
    ? record.files.filter((file): file is string => typeof file === "string")
    : undefined;
  return {
    type: typeof record.type === "string" ? record.type : undefined,
    scope: typeof record.scope === "string" ? record.scope : undefined,
    subject: typeof record.subject === "string" ? record.subject : undefined,
    message:
      typeof record.message === "string"
        ? record.message
        : typeof record.commit === "string"
          ? record.commit
          : undefined,
    body: typeof record.body === "string" ? record.body : undefined,
    breaking: record.breaking === true || record.breaking === "true",
    files,
  };
}

/** Accepts the handful of shapes models like to produce. */
export function coerceRawCommits(raw: unknown): RawCommit[] {
  if (typeof raw === "string") return [{ message: raw }];
  if (Array.isArray(raw)) {
    return raw.map(toRawCommit).filter((item): item is RawCommit => item !== undefined);
  }
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    if (Array.isArray(record.commits)) return coerceRawCommits(record.commits);
    if (Array.isArray(record.messages)) return coerceRawCommits(record.messages);
    if (typeof record.message === "string" || typeof record.subject === "string") {
      const single = toRawCommit(record);
      return single ? [single] : [];
    }
    if (record.commit) return coerceRawCommits(record.commit);
  }
  return [];
}

export function normalizeType(type: string | undefined): CommitType {
  if (!type) return "chore";
  const key = type.trim().toLowerCase().replace(/[^a-z]/g, "");
  return TYPE_ALIASES[key] ?? "chore";
}

/** Default conventional type for a path, used by the offline fallback. */
export function inferTypeFromPath(path: string): CommitType {
  const lower = path.toLowerCase();
  if (/(^|\/)readme|\.mdx?$|(^|\/)docs?\//.test(lower)) return "docs";
  if (/(^|\/)\.github\/|(^|\/)\.gitlab-ci|(^|\/)ci\//.test(lower)) return "ci";
  if (/\.(test|spec)\.[a-z]+$|(^|\/)tests?\//.test(lower)) return "test";
  if (/package\.json$|lock$|(^|\/)cargo\.toml$|go\.mod$|\.csproj$/.test(lower)) return "build";
  if (/\.(css|scss|sass|less)$/.test(lower)) return "style";
  return "chore";
}

export function inferLanguage(recentSubjects: string[]): "en" | "zh" | "ja" | "ko" {
  const sample = recentSubjects.join(" ");
  if (!sample) return "en";
  const cjk = (sample.match(/[\u4E00-\u9FFF]/g) ?? []).length;
  const kana = (sample.match(/[\u3040-\u30FF]/g) ?? []).length;
  const hangul = (sample.match(/[\uAC00-\uD7AF]/g) ?? []).length;
  if (kana > cjk && kana > 2) return "ja";
  if (hangul > cjk && hangul > 2) return "ko";
  if (cjk >= 3) return "zh";
  return "en";
}

function rawItemFiles(item: RawCommit | undefined): string[] {
  return item?.files ?? [];
}

function emptySelectionError(): PlanError {
  return new PlanError(
    "The model did not select any file to commit.",
    "Retry, or run without --select to commit every changed file.",
  );
}

export interface NormalizeOptions {
  files: string[];
  /** Force the type for every commit (from config/flag). */
  forceType?: string;
  /** Force the scope for every commit. */
  forceScope?: string;
  /** `plain` drops the `type(scope):` prefix from the subject line. */
  typeStyle?: "conventional" | "plain";
}

function cleanScope(scope: string | undefined): string | undefined {
  if (!scope) return undefined;
  const cleaned = scope
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9./-]/g, "");
  return cleaned || undefined;
}

function cleanSubject(subject: string, maxLength = 72): string {
  let text = subject.trim().replace(/\s+/g, " ");
  text = text.replace(/^["'`]|["'`]$/g, "");
  text = text.replace(/[.。;；,，]+$/, "");
  text = text.replace(/^(?:commit message|subject|title)\s*:\s*/i, "");
  if (text.length > maxLength) {
    const cut = text.slice(0, maxLength);
    const lastSpace = cut.lastIndexOf(" ");
    text = (lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
  }
  return text;
}

const BODY_WIDTH = 100;

/** Greedy word wrap that keeps indentation and list markers intact. */
export function wrapLine(line: string, width = BODY_WIDTH): string[] {
  if (line.length <= width) return [line];

  const indent = /^\s*/.exec(line)?.[0] ?? "";
  const rest = line.slice(indent.length);
  const marker = /^(?:[-*+]|\d+[.)])\s+/.exec(rest)?.[0] ?? "";
  const firstPrefix = indent + marker;
  const contPrefix = " ".repeat(firstPrefix.length);
  const words = rest.slice(marker.length).split(/\s+/).filter(Boolean);
  if (words.length <= 1) return [line];

  const lines: string[] = [];
  let current = firstPrefix;
  let started = false;

  for (const word of words) {
    if (!started) {
      current += word;
      started = true;
    } else if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = contPrefix + word;
    }
  }
  if (started) lines.push(current);
  return lines;
}

/**
 * Trims trailing spaces and reflows over-long prose lines so the message passes
 * commit linters. Code blocks, tables and long URLs are left alone.
 */
function normalizeBody(body: string | undefined): string | undefined {
  if (!body) return undefined;
  const lines = body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""));

  const wrapped: string[] = [];
  for (const line of lines) {
    const keepAsIs =
      line.length <= BODY_WIDTH ||
      /^\s{4,}/.test(line) || // indented code block
      /^\s*\|/.test(line) || // table row
      /https?:\/\/\S{40,}/.test(line); // long URL
    if (keepAsIs) wrapped.push(line);
    else wrapped.push(...wrapLine(line));
  }

  const cleaned = wrapped.join("\n").trim();
  return cleaned ? cleaned : undefined;
}

/**
 * Turns one raw model item into a `CommitPlanItem`.
 * A `message` field may still contain a full `feat(api): ...` header + body.
 */
export function normalizeCommit(raw: RawCommit, options: NormalizeOptions): CommitPlanItem {
  let type = raw.type;
  let scope = raw.scope;
  let subject = raw.subject ?? "";
  let body = raw.body;
  let breaking = raw.breaking === true;

  if (raw.message) {
    const header = firstLine(raw.message);
    const match = HEADER_PATTERN.exec(header);
    if (match?.groups) {
      type ??= match.groups.type;
      scope ??= match.groups.scope;
      subject = match.groups.subject ?? subject;
      breaking ||= match.groups.bang === "!";
    } else if (!subject) {
      subject = header;
    }
    body ??= bodyAfterFirstLine(raw.message);
  }

  if (breaking && body && !/BREAKING[ -]CHANGE/i.test(body)) {
    body = `BREAKING CHANGE: ${body}`;
  }

  const files = (raw.files ?? []).map((file) => file.trim()).filter((file) => options.files.includes(file));
  const uniqueFiles = [...new Set(files)];

  const resolvedType = normalizeType(options.forceType ?? type);
  const resolvedSubject = cleanSubject(
    subject || `${resolvedType === "chore" ? "update" : resolvedType} changes`,
  );
  const resolvedScope = cleanScope(options.forceScope ?? scope);
  const resolvedBody = normalizeBody(body);

  return {
    type: resolvedType,
    ...(resolvedScope ? { scope: resolvedScope } : {}),
    subject: resolvedSubject,
    ...(resolvedBody ? { body: resolvedBody } : {}),
    breaking,
    files: uniqueFiles,
  };
}

/**
 * Builds a plan that covers every changed file exactly once.
 * Leftovers (files the model forgot or hallucinated away) are appended to the
 * last commit, or become a `chore: update remaining files` commit of their own.
 */
export function normalizePlan(
  raw: unknown,
  options: NormalizeOptions & { split: boolean; select?: boolean },
): CommitPlanItem[] {
  const raws = coerceRawCommits(raw);
  if (raws.length === 0) {
    throw new PlanError("The model response did not contain any commit message.");
  }

  const used = new Set<string>();
  const plan: CommitPlanItem[] = [];
  const select = options.select === true;

  if (!options.split) {
    // Without --select every commit covers the whole change, whatever the model said.
    const requested = rawItemFiles(raws[0]);
    const item = normalizeCommit({ ...raws[0], files: select ? requested : options.files }, options);
    if (select) {
      if (item.files.length === 0) throw emptySelectionError();
      return [item];
    }
    return [{ ...item, files: [...options.files] }];
  }

  for (const rawItem of raws) {
    const item = normalizeCommit(rawItem, options);
    const files = item.files.filter((file) => !used.has(file));
    if (files.length === 0) continue;
    for (const file of files) used.add(file);
    plan.push({ ...item, files });
  }

  if (select) {
    // Omitted files stay uncommitted by design.
    if (plan.length === 0) throw emptySelectionError();
    return plan;
  }

  const leftover = options.files.filter((file) => !used.has(file));
  if (leftover.length > 0) {
    const last = plan.at(-1);
    if (last) {
      last.files = [...last.files, ...leftover];
      for (const file of leftover) used.add(file);
    } else {
      plan.push({
        type: "chore",
        subject: `update ${leftover.length} file${leftover.length === 1 ? "" : "s"}`,
        breaking: false,
        files: leftover,
      });
    }
  }

  return plan;
}

export interface FormatOptions {
  emoji?: boolean;
  typeStyle?: "conventional" | "plain";
}

/** Renders a plan item into the final commit message. */
export function formatMessage(item: CommitPlanItem, options: FormatOptions = {}): Message {
  let subject: string;
  if (options.typeStyle === "plain") {
    subject = item.subject;
  } else {
    const scope = item.scope ? `(${item.scope})` : "";
    const bang = item.breaking ? "!" : "";
    const emoji = options.emoji && EMOJI[item.type] ? `${EMOJI[item.type]} ` : "";
    subject = `${emoji}${item.type}${scope}${bang}: ${item.subject}`;
  }
  return {
    subject,
    ...(item.body ? { body: item.body } : {}),
  };
}

/** Reasons a message would be rejected by common commit linters. */
export function validateMessage(message: Message): string[] {
  const problems: string[] = [];
  const subject = message.subject.trim();
  if (!subject) problems.push("the subject is empty");
  if (subject.length > 72) problems.push(`the subject is ${subject.length} chars (max 72)`);

  const header = /^[a-z]+(?:\([^)]*\))?!?:\s*(.*)$/.exec(subject);
  const description = header?.[1]?.trim();
  if (description !== undefined) {
    if (!description) problems.push("the subject has no description after the colon");
    if (description.endsWith(".")) problems.push("the subject ends with a period");
  }

  if (message.body) {
    // Indented code and long URLs are legitimate exceptions, matching normalizeBody.
    const longLine = message.body
      .split("\n")
      .find(
        (line) =>
          line.length > BODY_WIDTH &&
          !/^\s{4,}/.test(line) &&
          !/https?:\/\/\S{40,}/.test(line),
      );
    if (longLine) problems.push("the body has a line longer than 100 chars");
  }
  return problems;
}

/** Heuristic message when the model is unavailable and `fallback` is enabled. */
export function buildFallbackPlan(files: FileChange[]): CommitPlanItem[] {
  const paths = files.map((file) => file.path);
  if (paths.length === 0) return [];

  const type = inferTypeFromPath(paths[0] ?? "");
  const summary = paths.length <= 3 ? paths.join(", ") : `${paths.length} files`;
  const bodyLines = paths.slice(0, 40).map((path) => `- ${path}`);
  if (paths.length > 40) bodyLines.push(`- ... and ${paths.length - 40} more`);

  return [
    {
      type,
      subject: `update ${summary}`.slice(0, 72),
      body: bodyLines.join("\n"),
      breaking: false,
      files: paths,
    },
  ];
}
