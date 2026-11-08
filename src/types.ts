export type Provider = "openai" | "anthropic";

export type Language = "auto" | "en" | "zh" | "ja" | "ko" | (string & {});

/** Single-letter git status codes as reported by `git status --porcelain`. */
export type ChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechange"
  | "unmerged"
  | "untracked"
  | "ignored";

export interface FileChange {
  /** Repository-relative path (posix separators). */
  path: string;
  status: ChangeStatus;
  insertions: number;
  deletions: number;
  binary: boolean;
  /** True when the file matched an `exclude` pattern, so its diff body is omitted. */
  excluded: boolean;
  /** For renames/copies: the previous path. */
  from?: string;
}

export interface DiffSegment {
  path: string;
  text: string;
  /** True when this segment was synthesized from an untracked file. */
  untracked?: boolean;
}

export interface DiffBundle {
  /** Every change we are allowed to commit, in stable (path-sorted) order. */
  files: FileChange[];
  /** Unified diff text, already truncated to the configured budget. */
  text: string;
  /** Number of characters in the *untruncated* diff. */
  rawChars: number;
  truncated: boolean;
  /** Paths whose diff body was dropped or cut because of the budget. */
  truncatedFiles: string[];
  /** Paths excluded by config; listed for the model but without diff content. */
  excludedFiles: string[];
}

export interface CommitPlanItem {
  type: string;
  scope?: string;
  subject: string;
  body?: string;
  breaking: boolean;
  files: string[];
}

export interface Message {
  /** First line, e.g. `feat(api): add retry to login`. */
  subject: string;
  /** Everything after the blank line, if any. */
  body?: string;
}

export interface RepoInfo {
  root: string;
  branch: string;
  recentSubjects: string[];
}

export type ConfigSource = "default" | "user" | "repo" | "env" | "flag";

export interface AiSettings {
  provider: Provider;
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

export interface Settings {
  ai: AiSettings;
  language: Language;
  maxDiffChars: number;
  /** Ask the model for several commits instead of one. */
  split: boolean;
  /** Let the model leave some changed files uncommitted. */
  select: boolean;
  emoji: boolean;
  noVerify: boolean;
  /** Prepend a type prefix (`feat:`) or write plain sentences. */
  typeStyle: "conventional" | "plain";
  /** Free-form extra instructions appended to the system prompt. */
  instructions: string;
  /** Glob patterns whose diff bodies are omitted from the prompt. */
  exclude: string[];
  /** Build a heuristic message locally if the model call fails. */
  fallback: boolean;
  /** Only commit what is already in the index. */
  stagedOnly: boolean;
  yes: boolean;
  dryRun: boolean;
  push: boolean;
  json: boolean;
  debug: boolean;
  /** Force a conventional-commit type for every commit. */
  forceType?: string;
  /** Force a conventional-commit scope for every commit. */
  forceScope?: string;
  /** Print the resolved config with secrets masked. */
  showConfig?: boolean;
  configPath?: string;
}

export interface ConfigFile {
  provider?: Provider;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  language?: Language;
  maxDiffChars?: number;
  split?: boolean;
  select?: boolean;
  emoji?: boolean;
  noVerify?: boolean;
  typeStyle?: "conventional" | "plain";
  instructions?: string;
  exclude?: string[];
  fallback?: boolean;
  stagedOnly?: boolean;
  push?: boolean;
}

export interface CliFlags extends Partial<ConfigFile> {
  yes?: boolean;
  dryRun?: boolean;
  json?: boolean;
  debug?: boolean;
  forceType?: string;
  forceScope?: string;
  showConfig?: boolean;
  configPath?: string;
  help?: boolean;
  version?: boolean;
  force?: boolean;
  command?: string;
  subcommand?: string;
  positionals?: string[];
}
