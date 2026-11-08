import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { git, repoRoot } from "./git.ts";
import { resolveSettings } from "./config.ts";
import { runAutoCommit } from "./commit.ts";
import { GacError, UsageError } from "./errors.ts";
import type { CliFlags, Settings } from "./types.ts";

export type HookAgent = "claude" | "codex" | "opencode";

export const HOOK_AGENTS: HookAgent[] = ["claude", "codex", "opencode"];

/** Placeholder marker used to recognise our own hook entries in config files. */
const AGENT_MARKER = /hook\s+run\s+--agent\s+([a-z]+)/;

const HOOK_TIMEOUT_SECONDS = 120;
const LOCK_TTL_MS = 10 * 60 * 1000;
const LOG_MAX_BYTES = 256 * 1024;
const PLUGIN_FILE = "gac-auto-commit.ts";

export interface HookPayload {
  cwd?: string;
  session_id?: string;
  turn_id?: string;
  hook_event_name?: string;
  stop_hook_active?: boolean;
  [key: string]: unknown;
}

export interface HookRunOptions {
  agent: HookAgent;
  flags: CliFlags;
  env?: NodeJS.ProcessEnv;
  /** Hook payload as delivered on stdin; tests can pass it directly. */
  stdin?: string;
  /** Return a non-zero exit code when the commit fails (default: always 0). */
  strict?: boolean;
}

export interface HookRunResult {
  code: number;
  log: string;
  committed: number;
}

export function parseAgent(value: string | undefined): HookAgent | "all" {
  const normalized = (value ?? "all").trim().toLowerCase();
  if (normalized === "all") return "all";
  if ((HOOK_AGENTS as string[]).includes(normalized)) return normalized as HookAgent;
  throw new UsageError(`Unknown hook agent "${value}".`, `Use one of: ${HOOK_AGENTS.join(", ")}, all.`);
}

export function agentsFrom(value: string | undefined): HookAgent[] {
  const agent = parseAgent(value);
  return agent === "all" ? [...HOOK_AGENTS] : [agent];
}

/** Reads the JSON payload hook runners write to stdin. */
export function parseHookPayload(raw: string): HookPayload | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as HookPayload;
  } catch {
    return undefined;
  }
}

async function readStdinPayload(timeoutMs = 1500): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  const timer = setTimeout(() => {
    process.stdin.destroy();
  }, timeoutMs);
  try {
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  } catch {
    // A closed or idle stdin is fine; the payload is optional.
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function absoluteGitDir(cwd: string): string | undefined {
  const result = git(["rev-parse", "--absolute-git-dir"], { cwd, allowFailure: true });
  if (result.code !== 0) return undefined;
  const value = result.stdout.trim();
  if (!value) return undefined;
  return isAbsolute(value) ? value : resolve(cwd, value);
}

/** Git operations during which an automatic commit would be wrong. */
function busyReason(gitDir: string): string | undefined {
  const markers: [string, string][] = [
    ["MERGE_HEAD", "merge in progress"],
    ["CHERRY_PICK_HEAD", "cherry-pick in progress"],
    ["REVERT_HEAD", "revert in progress"],
    ["BISECT_LOG", "bisect in progress"],
    ["rebase-merge", "rebase in progress"],
    ["rebase-apply", "rebase in progress"],
  ];
  for (const [marker, reason] of markers) {
    if (existsSync(join(gitDir, marker))) return reason;
  }
  return undefined;
}

function acquireLock(gitDir: string): string | undefined {
  const lockDir = join(gitDir, "gac-hook.lock");
  const attempt = (): string | undefined => {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, "pid"), `${process.pid}\n`, "utf8");
      return lockDir;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const age = Date.now() - statSync(lockDir).mtimeMs;
        if (age > LOCK_TTL_MS) {
          rmSync(lockDir, { recursive: true, force: true });
          return attempt();
        }
      } catch {
        // Another process may have removed it already.
      }
      return undefined;
    }
  };
  return attempt();
}

function releaseLock(lockDir: string): void {
  rmSync(lockDir, { recursive: true, force: true });
}

function appendHookLog(gitDir: string, agent: HookAgent, message: string): void {
  const file = join(gitDir, "gac-hook.log");
  try {
    if (existsSync(file) && statSync(file).size > LOG_MAX_BYTES) {
      renameSync(file, `${file}.1`);
    }
    const stamp = new Date().toISOString();
    appendFileSync(file, `${stamp} [${agent}] ${message}\n`, "utf8");
  } catch {
    // Logging must never break the agent.
  }
}

interface Captured<T> {
  value?: T;
  error?: unknown;
  output: string;
}

/** Keeps hook output out of the agent's stdout/stderr; it goes to the log instead. */
async function capture<T>(fn: () => Promise<T>): Promise<Captured<T>> {
  const chunks: string[] = [];
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  const sink = (chunk: unknown): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
    return true;
  };
  (process.stdout as unknown as { write: typeof sink }).write = sink;
  (process.stderr as unknown as { write: typeof sink }).write = sink;
  try {
    const value = await fn();
    return { value, output: chunks.join("") };
  } catch (error) {
    return { error, output: chunks.join("") };
  } finally {
    (process.stdout as unknown as { write: typeof stdoutWrite }).write = stdoutWrite;
    (process.stderr as unknown as { write: typeof stderrWrite }).write = stderrWrite;
  }
}

function tail(text: string, limit = 2000): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(-limit)}`;
}

/**
 * Entry point for `gac hook run`. Never prompts, never writes to the agent's
 * stdout, and (by default) always exits 0 so a failed commit cannot break a turn.
 */
export async function runHook(options: HookRunOptions): Promise<HookRunResult> {
  const env = options.env ?? process.env;
  const payloadText = options.stdin ?? (await readStdinPayload());
  const payload = parseHookPayload(payloadText) ?? {};

  const cwdCandidates = [
    typeof payload.cwd === "string" ? payload.cwd : undefined,
    env.GAC_HOOK_CWD,
    env.CLAUDE_PROJECT_DIR,
    process.cwd(),
  ].filter((value): value is string => Boolean(value && value.trim()));

  if (env.GAC_HOOK_DISABLED && !/^(0|false|no|off)$/i.test(env.GAC_HOOK_DISABLED.trim())) {
    return { code: 0, log: "disabled by GAC_HOOK_DISABLED", committed: 0 };
  }

  if (payload.stop_hook_active === true) {
    return { code: 0, log: "skipped: stop_hook_active", committed: 0 };
  }

  let root: string;
  try {
    root = repoRoot(cwdCandidates[0]);
  } catch {
    return { code: 0, log: "skipped: not a git repository", committed: 0 };
  }

  const gitDir = absoluteGitDir(root);
  if (!gitDir) return { code: 0, log: "skipped: no git directory", committed: 0 };

  const busy = busyReason(gitDir);
  if (busy) {
    appendHookLog(gitDir, options.agent, `skipped: ${busy}`);
    return { code: 0, log: `skipped: ${busy}`, committed: 0 };
  }

  const detached = git(["symbolic-ref", "--quiet", "HEAD"], { cwd: root, allowFailure: true });
  if (detached.code !== 0) {
    appendHookLog(gitDir, options.agent, "skipped: detached HEAD");
    return { code: 0, log: "skipped: detached HEAD", committed: 0 };
  }

  const lockDir = acquireLock(gitDir);
  if (!lockDir) {
    appendHookLog(gitDir, options.agent, "skipped: another gac hook run is in progress");
    return { code: 0, log: "skipped: lock held", committed: 0 };
  }

  const flags: CliFlags = { ...options.flags, yes: true, json: false };
  let settings: Settings;
  try {
    settings = resolveSettings({ flags, root }).settings;
  } catch (error) {
    releaseLock(lockDir);
    const message = error instanceof Error ? error.message : String(error);
    appendHookLog(gitDir, options.agent, `failed: ${message}`);
    return { code: options.strict ? 1 : 0, log: `failed: ${message}`, committed: 0 };
  }

  const captured = await capture(() => runAutoCommit({ cwd: root, env, settings }));
  releaseLock(lockDir);

  if (captured.error) {
    const message = captured.error instanceof GacError ? captured.error.message : String(captured.error);
    appendHookLog(gitDir, options.agent, `failed: ${message}\n${tail(captured.output)}`);
    return {
      code: options.strict ? 1 : 0,
      log: `failed: ${message}`,
      committed: 0,
    };
  }

  const result = captured.value;
  if (!result || result.committed.length === 0) {
    const reason = result?.skippedReason ?? "nothing to commit";
    appendHookLog(gitDir, options.agent, `skipped: ${reason}`);
    return { code: 0, log: `skipped: ${reason}`, committed: 0 };
  }

  const summary = result.committed.map((entry) => `${entry.sha} ${entry.subject}`).join("; ");
  const extra = result.uncommitted?.length ? ` (left uncommitted: ${result.uncommitted.length})` : "";
  appendHookLog(gitDir, options.agent, `committed ${result.committed.length}: ${summary}${extra}`);
  return { code: 0, log: `committed ${result.committed.length}: ${summary}`, committed: result.committed.length };
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

export interface HookInstallOptions {
  agents: HookAgent[];
  scope: "user" | "project";
  /** Repository root used for project-scope installs. */
  root: string;
  /** Commit behaviour flags to bake into the hook command. */
  flags: CliFlags;
  env?: NodeJS.ProcessEnv;
  /** Override the gac binary path (useful for tests). */
  bin?: string;
}

export interface HookInstallResult {
  agent: HookAgent;
  file: string;
  action: "installed" | "updated" | "removed" | "absent";
  note?: string;
}

const COMMIT_BOOLEAN_FLAGS: [keyof CliFlags, string][] = [
  ["split", "--split"],
  ["select", "--select"],
  ["emoji", "--emoji"],
  ["noVerify", "--no-verify"],
  ["fallback", "--fallback"],
  ["push", "--push"],
  ["dryRun", "--dry-run"],
];

const COMMIT_VALUE_FLAGS: [keyof CliFlags, string][] = [
  ["provider", "--provider"],
  ["baseUrl", "--base-url"],
  ["model", "--model"],
  ["language", "--lang"],
  ["maxDiffChars", "--max-diff-chars"],
  ["forceType", "--type"],
  ["forceScope", "--scope"],
  ["instructions", "--instructions"],
];

/** Turns the flags given to `hook install` into arguments for `hook run`. */
export function commitFlagArgs(flags: CliFlags): string[] {
  const args: string[] = [];
  for (const [key, flag] of COMMIT_BOOLEAN_FLAGS) {
    if (flags[key] === true) args.push(flag);
  }
  for (const [key, flag] of COMMIT_VALUE_FLAGS) {
    const value = flags[key];
    if (typeof value === "number") args.push(flag, String(value));
    else if (typeof value === "string" && value.trim()) args.push(flag, value);
  }
  if (flags.typeStyle === "plain") args.push("--plain");
  return args;
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(value)) return value;
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** Resolves the gac executable to embed in hook configs. */
export function resolveSelfCommand(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.GAC_BIN?.trim();
  if (override) return override;
  const exe = process.execPath;
  if (/gac(\.exe)?$/i.test(exe)) return exe;
  return "gac";
}

function userHome(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || homedir();
}

function claudeConfigPath(scope: "user" | "project", root: string, env: NodeJS.ProcessEnv): string {
  return scope === "user"
    ? join(userHome(env), ".claude", "settings.json")
    : join(root, ".claude", "settings.json");
}

function codexConfigPath(scope: "user" | "project", root: string, env: NodeJS.ProcessEnv): string {
  return scope === "user"
    ? join(userHome(env), ".codex", "hooks.json")
    : join(root, ".codex", "hooks.json");
}

function opencodePluginPath(scope: "user" | "project", root: string, env: NodeJS.ProcessEnv): string {
  if (scope === "user") {
    const configHome =
      env.XDG_CONFIG_HOME?.trim() || join(userHome(env), ".config");
    return join(configHome, "opencode", "plugins", PLUGIN_FILE);
  }
  return join(root, ".opencode", "plugins", PLUGIN_FILE);
}

function readJsonObject(file: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error("expected a JSON object");
  } catch (error) {
    throw new UsageError(
      `Could not parse ${file}: ${error instanceof Error ? error.message : String(error)}`,
      "Fix the file (or move it away) and run the install again.",
    );
  }
}

function writeJsonObject(file: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) {
    try {
      copyFileSync(file, `${file}.gac.bak`);
    } catch {
      // A missing backup is not worth failing the install.
    }
  }
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function groupCommands(group: unknown): string[] {
  if (!isRecord(group) || !Array.isArray(group.hooks)) return [];
  return group.hooks
    .map((hook) => (isRecord(hook) && typeof hook.command === "string" ? hook.command : ""))
    .filter(Boolean);
}

function isGacGroup(group: unknown, agent?: HookAgent): boolean {
  return groupCommands(group).some((command) => {
    const match = AGENT_MARKER.exec(command);
    if (!match) return false;
    return agent ? match[1] === agent : true;
  });
}

function mergeStopHook(file: string, agent: HookAgent, command: string): "installed" | "updated" {
  const data = readJsonObject(file);
  const hooks = isRecord(data.hooks) ? data.hooks : {};
  const existing = Array.isArray(hooks.Stop) ? (hooks.Stop as unknown[]) : [];
  const ours = existing.filter((group) => isGacGroup(group, agent));
  const others = existing.filter((group) => !isGacGroup(group, agent));
  const entry = {
    hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }],
  };
  data.hooks = { ...hooks, Stop: [...others, entry] };
  writeJsonObject(file, data);
  return ours.length > 0 ? "updated" : "installed";
}

function removeStopHook(file: string, agent: HookAgent): "removed" | "absent" {
  if (!existsSync(file)) return "absent";
  const data = readJsonObject(file);
  const hooks = isRecord(data.hooks) ? data.hooks : undefined;
  if (!hooks || !Array.isArray(hooks.Stop)) return "absent";
  const existing = hooks.Stop as unknown[];
  const filtered = existing.filter((group) => !isGacGroup(group, agent));
  if (filtered.length === existing.length) return "absent";
  data.hooks = { ...hooks, Stop: filtered };
  writeJsonObject(file, data);
  return "removed";
}

/** Generates the OpenCode plugin that reacts to `session.idle`. */
export function opencodePluginSource(bin: string, args: string[]): string {
  return `/**
 * Auto-commit OpenCode turns with gac.
 * Generated by \`gac hook install --agent opencode\` — delete this file to disable.
 */
import { spawn } from "node:child_process"

const GAC_BIN = ${JSON.stringify(bin)}
const GAC_ARGS = ${JSON.stringify(args)}

function runGac(directory: string): void {
  try {
    const child = spawn(GAC_BIN, GAC_ARGS, {
      cwd: directory,
      env: { ...process.env, GAC_HOOK_CWD: directory, GAC_HOOK_AGENT: "opencode" },
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    })
    child.on("error", () => {})
    child.unref()
  } catch {
    // Never let an auto-commit failure break the session.
  }
}

const plugin = {
  id: "gac-auto-commit",
  async setup(ctx: any) {
    const directory =
      ctx?.location?.directory ?? ctx?.location?.project?.directory ?? process.cwd()
    const subscribe = ctx?.event?.subscribe
    if (typeof subscribe !== "function") return () => {}
    const controller = new AbortController()
    void (async () => {
      try {
        const options = { signal: controller.signal, types: ["session.idle"] }
        for await (const event of subscribe.call(ctx.event, options)) {
          if (event?.type === "session.idle") runGac(directory)
        }
      } catch {
        // The session ended or the subscription was aborted.
      }
    })()
    return () => controller.abort()
  },
  async server(ctx: any) {
    const directory = ctx?.worktree ?? ctx?.directory ?? process.cwd()
    return {
      event: async ({ event }: any) => {
        if (event?.type === "session.idle") runGac(directory)
      },
    }
  },
}

export default plugin
`;
}

function ensureCodexHooksEnabled(env: NodeJS.ProcessEnv): string | undefined {
  const file = join(userHome(env), ".codex", "config.toml");
  try {
    const raw = readFileSync(file, "utf8");
    if (/^\s*hooks\s*=\s*true\s*$/m.test(raw)) return undefined;
    return `Codex needs \`hooks = true\` under [features] in ${file} (legacy Codex versions).`;
  } catch {
    return undefined;
  }
}

export function installHooks(options: HookInstallOptions): HookInstallResult[] {
  const env = options.env ?? process.env;
  const bin = options.bin ?? resolveSelfCommand(env);
  const commitArgs = commitFlagArgs(options.flags);
  const results: HookInstallResult[] = [];

  for (const agent of options.agents) {
    if (agent === "opencode") {
      const file = opencodePluginPath(options.scope, options.root, env);
      const source = opencodePluginSource(bin, ["hook", "run", "--agent", "opencode", ...commitArgs]);
      const existed = existsSync(file);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, source, "utf8");
      results.push({ agent, file, action: existed ? "updated" : "installed" });
      continue;
    }

    const file =
      agent === "claude"
        ? claudeConfigPath(options.scope, options.root, env)
        : codexConfigPath(options.scope, options.root, env);
    const command = [shellQuote(bin), "hook", "run", "--agent", agent, ...commitArgs]
      .map((part) => part)
      .join(" ");
    const action = mergeStopHook(file, agent, command);
    results.push({
      agent,
      file,
      action,
      ...(agent === "codex" ? { note: ensureCodexHooksEnabled(env) } : {}),
    });
  }

  return results;
}

export function uninstallHooks(options: Omit<HookInstallOptions, "flags" | "bin">): HookInstallResult[] {
  const env = options.env ?? process.env;
  const results: HookInstallResult[] = [];

  for (const agent of options.agents) {
    if (agent === "opencode") {
      const file = opencodePluginPath(options.scope, options.root, env);
      if (!existsSync(file)) {
        results.push({ agent, file, action: "absent" });
        continue;
      }
      rmSync(file, { force: true });
      results.push({ agent, file, action: "removed" });
      continue;
    }

    const file =
      agent === "claude"
        ? claudeConfigPath(options.scope, options.root, env)
        : codexConfigPath(options.scope, options.root, env);
    results.push({ agent, file, action: removeStopHook(file, agent) });
  }

  return results;
}

export interface HookStatusEntry {
  agent: HookAgent;
  installed: boolean;
  file: string;
  scope: "user" | "project";
}

function isJsonHookInstalled(file: string, agent: HookAgent): boolean {
  try {
    const data = readJsonObject(file);
    const hooks = isRecord(data.hooks) ? data.hooks : {};
    const stop = Array.isArray(hooks.Stop) ? (hooks.Stop as unknown[]) : [];
    return stop.some((group) => isGacGroup(group, agent));
  } catch {
    return false;
  }
}

export function hookStatus(root: string, env: NodeJS.ProcessEnv = process.env): HookStatusEntry[] {
  const entries: HookStatusEntry[] = [];
  for (const agent of HOOK_AGENTS) {
    const userFile =
      agent === "opencode"
        ? opencodePluginPath("user", root, env)
        : agent === "claude"
          ? claudeConfigPath("user", root, env)
          : codexConfigPath("user", root, env);
    const projectFile =
      agent === "opencode"
        ? opencodePluginPath("project", root, env)
        : agent === "claude"
          ? claudeConfigPath("project", root, env)
          : codexConfigPath("project", root, env);

    const installedAt = (file: string): boolean =>
      agent === "opencode" ? existsSync(file) : isJsonHookInstalled(file, agent);

    if (installedAt(userFile)) {
      entries.push({ agent, installed: true, file: userFile, scope: "user" });
    } else if (installedAt(projectFile)) {
      entries.push({ agent, installed: true, file: projectFile, scope: "project" });
    } else {
      entries.push({ agent, installed: false, file: userFile, scope: "user" });
    }
  }
  return entries;
}

export function hookLogPath(root: string): string | undefined {
  const gitDir = absoluteGitDir(root);
  return gitDir ? join(gitDir, "gac-hook.log") : undefined;
}

export { PLUGIN_FILE, HOOK_TIMEOUT_SECONDS };
