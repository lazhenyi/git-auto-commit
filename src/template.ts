import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { UsageError } from "./errors.ts";
import type { Message } from "./types.ts";

/** Values available to a commit template. */
export interface TemplateValues {
  type: string;
  scope: string;
  /** `scope` wrapped in parentheses, or an empty string. */
  scopeParens: string;
  subject: string;
  /** The default `type(scope): subject` line, including emoji when enabled. */
  header: string;
  body: string;
  /** `!` for breaking changes, otherwise empty. */
  breaking: string;
  /** Emoji plus a trailing space, or empty. */
  emoji: string;
  author: string;
  email: string;
  branch: string;
  /** Local date as YYYY-MM-DD. */
  date: string;
}

export const TEMPLATE_PLACEHOLDERS = [
  "type",
  "scope",
  "scopeParens",
  "subject",
  "header",
  "body",
  "breaking",
  "emoji",
  "author",
  "email",
  "branch",
  "date",
] as const;

const PLACEHOLDER_PATTERN = new RegExp(`\\{(${TEMPLATE_PLACEHOLDERS.join("|")})\\}`, "g");

export function expandHome(path: string, env: NodeJS.ProcessEnv = process.env): string {
  if (path === "~") return env.HOME?.trim() || homedir();
  if (path.startsWith("~/")) return resolve(env.HOME?.trim() || homedir(), path.slice(2));
  return path;
}

/** Absolute path for a template file, relative to the repository root. */
export function resolveTemplatePath(
  path: string,
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const expanded = expandHome(path.trim(), env);
  return isAbsolute(expanded) ? expanded : resolve(root, expanded);
}

export function readTemplateFile(
  path: string,
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): { text: string; file: string } {
  const file = resolveTemplatePath(path, root, env);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    throw new UsageError(
      `Could not read commit template ${file}: ${error instanceof Error ? error.message : String(error)}`,
      "Check the path in `templateFile` / --template, or pass the template inline with --template-text.",
    );
  }
  return { text: raw.replace(/\r\n/g, "\n").trim(), file };
}

/** A template must be able to place the generated subject somewhere. */
export function validateTemplate(template: string): void {
  if (!template.trim()) {
    throw new UsageError("The commit template is empty.", "Remove the setting or provide some text.");
  }
  if (!/\{(?:header|subject)\}/.test(template)) {
    throw new UsageError(
      "The commit template must contain {subject} or {header}.",
      `Available placeholders: ${TEMPLATE_PLACEHOLDERS.map((name) => `{${name}}`).join(", ")}`,
    );
  }
}

export function localDate(now = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Renders a custom commit template.
 *
 * The rendered text is split at the first line: the first line becomes the
 * subject, everything after it the body, matching how git treats a message.
 */
export function renderTemplate(template: string, values: TemplateValues): Message {
  const data: TemplateValues = { ...values, body: values.body ?? "", date: values.date || localDate() };

  const rendered = template.replace(PLACEHOLDER_PATTERN, (_match, key: string) => {
    const value = data[key as keyof TemplateValues];
    return value === undefined ? "" : value;
  });

  const lines = rendered
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""));

  // `feat({scope})` should not become `feat()` when the scope is empty.
  if (!data.scope && lines[0]) {
    lines[0] = lines[0].replace(/\(\s*\)/g, "").replace(/\[\s*\]/g, "");
  }

  const [subject = "", ...rest] = lines;
  const bodyText = rest
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    subject: subject.trim(),
    ...(bodyText ? { body: bodyText } : {}),
  };
}
