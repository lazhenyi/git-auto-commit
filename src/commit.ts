import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chat } from "./ai.ts";
import { collectDiff } from "./diff.ts";
import {
  currentBranch,
  collectChanges,
  commit,
  gitConfigValue,
  hasStagedChanges,
  push as pushBranch,
  pathsWithUnstagedChanges,
  recentSubjects,
  repoRoot,
  shortHead,
  stageAll,
  stagePaths,
} from "./git.ts";
import { GacError } from "./errors.ts";
import {
  buildFallbackPlan,
  extractJson,
  formatMessage,
  inferLanguage,
  normalizePlan,
  validateMessage,
} from "./message.ts";
import { buildMessages } from "./prompt.ts";
import { localDate } from "./template.ts";
import type { CommitPlanItem, Message, Settings } from "./types.ts";
import { color, confirm, log, printMessage, setJsonMode } from "./ui.ts";

export interface RunOptions {
  cwd: string;
  settings: Settings;
  env?: NodeJS.ProcessEnv;
}

export interface CommittedEntry {
  sha: string;
  subject: string;
  files: string[];
}

export interface RunResult {
  root: string;
  plan: CommitPlanItem[];
  messages: Message[];
  committed: CommittedEntry[];
  pushed: boolean;
  skippedReason?: "no-changes" | "dry-run" | "declined";
  /** Changed files the model chose not to commit (`--select`). */
  uncommitted?: string[];
  usage?: { inputTokens?: number; outputTokens?: number };
}

export async function runAutoCommit(options: RunOptions): Promise<RunResult> {
  const env = options.env ?? process.env;
  const settings = options.settings;
  setJsonMode(settings.json);

  const root = repoRoot(options.cwd);

  log.step(`Reading changes in ${color.bold(root)}`);
  const files = collectChanges(root, settings.stagedOnly);
  if (files.length === 0) {
    const message = settings.stagedOnly
      ? hasStagedChanges(root)
        ? "Nothing to commit."
        : "Nothing is staged."
      : "Nothing to commit, the work tree is clean.";
    log.info(message);
    return {
      root,
      plan: [],
      messages: [],
      committed: [],
      pushed: false,
      skippedReason: "no-changes",
    };
  }

  log.step(`Collecting diff for ${files.length} file${files.length === 1 ? "" : "s"}`);
  const bundle = await collectDiff({
    root,
    stagedOnly: settings.stagedOnly,
    budget: settings.maxDiffChars,
    exclude: settings.exclude,
    files,
  });
  if (bundle.truncated) {
    log.warn(
      `Diff truncated to ${settings.maxDiffChars} chars (${bundle.truncatedFiles.length} file(s) shortened). ` +
        "Use --max-diff-chars to raise the budget.",
    );
  }

  const branch = currentBranch(root);
  const subjects = recentSubjects(root);
  const language = settings.language === "auto" ? inferLanguage(subjects) : settings.language;
  const messages = buildMessages({
    branch,
    recentSubjects: subjects,
    bundle,
    language,
    split: settings.split,
    select: settings.select,
    ...(settings.template ? { template: settings.template } : {}),
    typeStyle: settings.typeStyle,
    instructions: settings.instructions,
  });

  log.step(`Asking ${settings.ai.provider}/${settings.ai.model} for a commit message`);
  let plan: CommitPlanItem[];
  let usage: RunResult["usage"];

  try {
    const response = await chat(settings.ai, { system: messages.system, user: messages.user, json: true }, {
      debug: settings.debug ? log.debug : undefined,
      ...(env.GAC_RETRY_DELAY_MS ? { retryDelayMs: Number(env.GAC_RETRY_DELAY_MS) } : {}),
    });
    usage = response.usage;
    plan = normalizePlan(extractJson(response.text), {
      files: bundle.files.map((file) => file.path),
      split: settings.split,
      select: settings.select,
      typeStyle: settings.typeStyle,
      ...(settings.forceType ? { forceType: settings.forceType } : {}),
      ...(settings.forceScope ? { forceScope: settings.forceScope } : {}),
    });
  } catch (error) {
    if (!settings.fallback) throw error;
    log.warn(`Model call failed (${error instanceof Error ? error.message : String(error)}).`);
    log.warn("Falling back to a heuristic message because `fallback` is enabled.");
    plan = buildFallbackPlan(files);
    if (plan.length === 0) throw error;
  }

  const templateData = settings.template
    ? {
        author: gitConfigValue(root, "user.name") ?? env.GIT_AUTHOR_NAME ?? "",
        email: gitConfigValue(root, "user.email") ?? env.GIT_AUTHOR_EMAIL ?? "",
        branch,
        date: localDate(),
      }
    : undefined;

  let formatted = plan.map((item) =>
    formatMessage(item, {
      emoji: settings.emoji,
      typeStyle: settings.typeStyle,
      ...(settings.template ? { template: settings.template } : {}),
      ...(templateData ? { templateData } : {}),
    }),
  );

  // `git commit -- <path>` takes content from the work tree, so splitting a
  // partially staged file would silently commit the unstaged hunks too.
  if (settings.stagedOnly && plan.length > 1) {
    const dirty = pathsWithUnstagedChanges(root, bundle.files.map((file) => file.path));
    if (dirty.length > 0) {
      log.warn(
        `Cannot split: ${dirty.join(", ")} also have unstaged edits. Committing everything as one commit.`,
      );
      const collapsedFiles = settings.select
        ? [...new Set(plan.flatMap((item) => item.files))]
        : bundle.files.map((file) => file.path);
      plan = [{ ...(plan[0] as CommitPlanItem), files: collapsedFiles }];
      formatted = [formatted[0] as Message];
    }
  }

  // A quality gate that never blocks: printf-style warnings only.
  for (const message of formatted) {
    const problems = validateMessage(message, { customTemplate: Boolean(settings.template) });
    if (problems.length > 0) log.warn(`Commit message check: ${problems.join("; ")}.`);
  }

  printPlan(plan, formatted, settings.split, settings.select);

  const selectedFiles = new Set(plan.flatMap((item) => item.files));
  const unselected = settings.select
    ? bundle.files.map((file) => file.path).filter((path) => !selectedFiles.has(path))
    : [];

  if (settings.dryRun) {
    if (unselected.length > 0) logUncommitted(unselected, "Would leave uncommitted");
    log.info(color.gray("Dry run: nothing was staged or committed.\n"));
    return {
      root,
      plan,
      messages: formatted,
      committed: [],
      pushed: false,
      skippedReason: "dry-run",
      ...(settings.select ? { uncommitted: unselected } : {}),
      ...(usage ? { usage } : {}),
    };
  }

  let finalMessages: Message[] = formatted;
  if (!settings.yes) {
    const answer = await confirm(`Commit${plan.length > 1 ? ` ${plan.length} times` : ""}?`, {
      allowEdit: plan.length === 1,
    });
    if (answer === "no") {
      log.info("Aborted.");
      return { root, plan, messages: formatted, committed: [], pushed: false, skippedReason: "declined" };
    }
    if (answer === "edit") {
      const edited = editMessage(formatted[0] as Message, env);
      if (!edited) {
        log.info("Aborted.");
        return { root, plan, messages: formatted, committed: [], pushed: false, skippedReason: "declined" };
      }
      finalMessages = [edited];
      plan = [{ ...(plan[0] as CommitPlanItem), subject: stripHeader(edited.subject, plan[0]?.type) }];
      printMessage(edited.subject, edited.body);
    }
  }

  if (!settings.stagedOnly && !settings.select) {
    log.step("Staging changes");
    stageAll(root);
  }

  if (settings.stagedOnly && settings.select) {
    const dirty = pathsWithUnstagedChanges(root, [...selectedFiles]);
    if (dirty.length > 0) {
      log.warn(
        `Selected files have unstaged edits (${dirty.join(", ")}); the work tree version will be committed.`,
      );
    }
  }

  const committed: CommittedEntry[] = [];
  for (let index = 0; index < plan.length; index += 1) {
    const item = plan[index] as CommitPlanItem;
    const message = finalMessages[index] as Message;
    const isLast = index === plan.length - 1;
    // In select mode every commit is restricted to its own files, so staged
    // leftovers the model did not choose are never swept in.
    const paths = settings.select || !isLast ? item.files : undefined;

    log.step(
      plan.length > 1
        ? `Committing ${index + 1}/${plan.length}: ${color.bold(message.subject)}`
        : `Committing: ${color.bold(message.subject)}`,
    );

    try {
      if (settings.select && !settings.stagedOnly) {
        stagePaths(root, item.files);
      }
      const sha = commit({
        cwd: root,
        message: message.subject,
        ...(message.body ? { body: message.body } : {}),
        ...(paths ? { paths } : {}),
        ...(settings.noVerify ? { noVerify: true } : {}),
      });

      committed.push({ sha: sha || shortHead(root), subject: message.subject, files: item.files });
      log.success(`${sha || "committed"} ${message.subject}`);
    } catch (error) {
      if (committed.length > 0) {
        const done = committed.map((entry) => entry.sha).join(", ");
        throw new GacError(
          `${error instanceof Error ? error.message : String(error)}\n` +
            `Already committed ${committed.length} of ${plan.length}: ${done}`,
          { hint: "Inspect with `git log`, then rerun `gac` for the remaining changes." },
        );
      }
      throw error;
    }
  }

  let pushed = false;
  if (settings.push) {
    log.step("Pushing");
    pushBranch(root);
    pushed = true;
    log.success("Pushed to the remote.");
  }

  const committedPaths = new Set(committed.flatMap((entry) => entry.files));
  const uncommitted = settings.select
    ? bundle.files.map((file) => file.path).filter((path) => !committedPaths.has(path))
    : [];
  if (uncommitted.length > 0) logUncommitted(uncommitted, "Left uncommitted");

  return {
    root,
    plan,
    messages: finalMessages,
    committed,
    pushed,
    ...(settings.select ? { uncommitted } : {}),
    ...(usage ? { usage } : {}),
  };
}

function stripHeader(subject: string, type: string | undefined): string {
  const pattern = new RegExp(`^(?:\\p{Emoji_Presentation}\\s*)?${type ?? "[a-z]+"}(?:\\([^)]*\\))?!?:\\s*`, "u");
  return subject.replace(pattern, "").trim();
}

function logUncommitted(paths: string[], label: string): void {
  const shown = paths.slice(0, 12).join(", ");
  const more = paths.length > 12 ? `, … (+${paths.length - 12})` : "";
  log.info(color.gray(`${label} ${paths.length} file(s): ${shown}${more}`));
}

function printPlan(
  plan: CommitPlanItem[],
  messages: Message[],
  split: boolean,
  select = false,
): void {
  if (select || (split && plan.length > 1)) {
    const title = plan.length === 1 ? "Plan: 1 commit" : `Plan: ${plan.length} commits`;
    log.info(`\n${color.bold(title)}`);
    plan.forEach((item, index) => {
      log.info(`\n${color.cyan(`${index + 1}.`)} ${color.bold((messages[index] as Message).subject)}`);
      const body = (messages[index] as Message).body;
      if (body) for (const line of body.split("\n")) log.info(`   ${color.gray(line)}`);
      for (const file of item.files) log.info(`   ${color.gray(`- ${file}`)}`);
    });
    log.info("");
    return;
  }

  const first = messages[0] as Message;
  printMessage(first.subject, first.body);
}

/** Opens $EDITOR on the draft message. Returns undefined when nothing is left. */
export function editMessage(message: Message, env: NodeJS.ProcessEnv = process.env): Message | undefined {
  const editor = env.VISUAL?.trim() || env.EDITOR?.trim() || "vi";
  const dir = mkdtempSync(join(tmpdir(), "gac-"));
  const file = join(dir, "COMMIT_EDITMSG");
  const draft = `${message.subject}\n${message.body ? `\n${message.body}\n` : ""}`;
  writeFileSync(file, draft, "utf8");

  try {
    const result = spawnSync(`${editor} "${file}"`, { shell: true, stdio: "inherit" });
    if (result.error) throw new GacError(`Could not start the editor (${editor}): ${result.error.message}`);
    if (result.status !== 0) throw new GacError(`The editor exited with code ${result.status}.`);

    const edited = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => !line.startsWith("#"))
      .join("\n")
      .trim();
    if (!edited) return undefined;

    const [header, ...rest] = edited.split("\n");
    const body = rest.join("\n").trim();
    return {
      subject: (header ?? "").trim(),
      ...(body ? { body } : {}),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
