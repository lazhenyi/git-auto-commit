/**
 * Programmatic entry point.
 *
 * ```ts
 * import { runAutoCommit, resolveSettings, repoRoot } from "git-auto-commit";
 *
 * const root = repoRoot();
 * const { settings } = resolveSettings({ root });
 * const result = await runAutoCommit({ cwd: root, settings });
 * ```
 */
export { runAutoCommit, editMessage } from "./commit.ts";
export type { RunOptions, RunResult, CommittedEntry } from "./commit.ts";
export { resolveSettings, redactSettings, maskSecret, userConfigPath, repoConfigPath, DEFAULTS } from "./config.ts";
export type { ResolvedSettings } from "./config.ts";
export { chat, describeEndpoint, DEFAULT_BASE_URLS, DEFAULT_MODELS } from "./ai.ts";
export { collectDiff, isExcluded, splitDiffSegments, truncateSegments, globToRegExp, DEFAULT_EXCLUDE } from "./diff.ts";
export {
  buildFallbackPlan,
  coerceRawCommits,
  extractJson,
  formatMessage,
  inferLanguage,
  normalizePlan,
  validateMessage,
  COMMIT_TYPES,
} from "./message.ts";
export { buildMessages, systemPrompt, userPrompt } from "./prompt.ts";
export { repoRoot, statusEntries, parseStatusZ, collectChanges } from "./git.ts";
export { GacError, UsageError, PlanError } from "./errors.ts";
export type {
  AiSettings,
  CliFlags,
  CommitPlanItem,
  ConfigFile,
  DiffBundle,
  FileChange,
  Message,
  Provider,
  Settings,
} from "./types.ts";
