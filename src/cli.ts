#!/usr/bin/env node
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeEndpoint } from "./ai.ts";
import { runAutoCommit } from "./commit.ts";
import { resolveSettings, redactSettings, REPO_CONFIG_FILES, userConfigPath } from "./config.ts";
import { GacError, UsageError } from "./errors.ts";
import { repoRoot, setAlias, unsetAlias } from "./git.ts";
import {
  agentsFrom,
  hookLogPath,
  hookStatus,
  installHooks,
  parseAgent,
  runHook,
  uninstallHooks,
} from "./hook.ts";
import type { CliFlags, Provider } from "./types.ts";
import { color, log } from "./ui.ts";
import { VERSION } from "./version.ts";

const VALUE_FLAGS: Record<string, keyof CliFlags> = {
  "--model": "model",
  "-m": "model",
  "--provider": "provider",
  "--base-url": "baseUrl",
  "--api-key": "apiKey",
  "--lang": "language",
  "--language": "language",
  "--max-diff-chars": "maxDiffChars",
  "--temperature": "temperature",
  "--max-tokens": "maxTokens",
  "--timeout": "timeoutMs",
  "--timeout-ms": "timeoutMs",
  "--instructions": "instructions",
  "--exclude": "exclude",
  "--type": "forceType",
  "--scope": "forceScope",
  "--agent": "agent",
  "--config": "configPath",
};

const BOOLEAN_FLAGS: Record<string, { key: keyof CliFlags; value: boolean }> = {
  "--yes": { key: "yes", value: true },
  "-y": { key: "yes", value: true },
  "--force": { key: "force", value: true },
  "--dry-run": { key: "dryRun", value: true },
  "-n": { key: "dryRun", value: true },
  "--split": { key: "split", value: true },
  "--no-split": { key: "split", value: false },
  "--batches": { key: "split", value: true },
  "--no-batches": { key: "split", value: false },
  "--select": { key: "select", value: true },
  "--no-select": { key: "select", value: false },
  "--strict": { key: "strict", value: true },
  "--emoji": { key: "emoji", value: true },
  "--no-emoji": { key: "emoji", value: false },
  "--no-verify": { key: "noVerify", value: true },
  "--verify": { key: "noVerify", value: false },
  "--fallback": { key: "fallback", value: true },
  "--no-fallback": { key: "fallback", value: false },
  "--staged": { key: "stagedOnly", value: true },
  "--staged-only": { key: "stagedOnly", value: true },
  "-s": { key: "stagedOnly", value: true },
  "--all": { key: "stagedOnly", value: false },
  "-a": { key: "stagedOnly", value: false },
  "--push": { key: "push", value: true },
  "--json": { key: "json", value: true },
  "--debug": { key: "debug", value: true },
  "-d": { key: "debug", value: true },
  "--help": { key: "help", value: true },
  "-h": { key: "help", value: true },
  "--version": { key: "version", value: true },
  "-v": { key: "version", value: true },
};

const TYPE_STYLE_FLAGS = new Set(["--plain", "--conventional"]);

export interface ParsedArgs {
  flags: CliFlags;
  command: string;
  positionals: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: CliFlags = {};
  const positionals: string[] = [];
  let command = "";
  const excludes: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;

    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (!arg.startsWith("-")) {
      if (!command) command = arg;
      else positionals.push(arg);
      continue;
    }

    const [name, inline] = arg.includes("=") ? splitInline(arg) : [arg, undefined];

    if (name === "--user" || name === "--project") {
      flags.hookScope = name === "--user" ? "user" : "project";
      continue;
    }

    if (TYPE_STYLE_FLAGS.has(name)) {
      flags.typeStyle = name === "--plain" ? "plain" : "conventional";
      continue;
    }

    const booleanFlag = BOOLEAN_FLAGS[name];
    if (booleanFlag) {
      (flags as Record<string, unknown>)[booleanFlag.key] = booleanFlag.value;
      continue;
    }

    const valueKey = VALUE_FLAGS[name];
    if (valueKey) {
      const value = inline ?? argv[i + 1];
      if (value === undefined) throw new UsageError(`Missing value for ${name}.`);
      if (inline === undefined) i += 1;
      if (valueKey === "exclude") {
        excludes.push(...value.split(",").map((item) => item.trim()).filter(Boolean));
      } else if (["maxDiffChars", "temperature", "maxTokens", "timeoutMs"].includes(valueKey)) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) throw new UsageError(`${name} expects a number, got "${value}".`);
        (flags as Record<string, unknown>)[valueKey] = parsed;
      } else if (valueKey === "provider") {
        const provider = value.toLowerCase();
        if (provider !== "openai" && provider !== "anthropic") {
          throw new UsageError(`Unknown provider "${value}".`, "Use openai or anthropic.");
        }
        flags.provider = provider as Provider;
      } else {
        (flags as Record<string, unknown>)[valueKey] = value;
      }
      continue;
    }

    throw new UsageError(`Unknown option ${name}.`, "Run `gac --help` to see all options.");
  }

  if (excludes.length > 0) flags.exclude = excludes;
  if (!command) command = "commit";
  return { flags, command, positionals };
}

function splitInline(arg: string): [string, string] {
  const index = arg.indexOf("=");
  return [arg.slice(0, index), arg.slice(index + 1)];
}

function helpText(): string {
  return `
${color.bold("gac")} — AI-powered git commits

${color.bold("Usage")}
  gac [options]                 Read the diff, ask the model, commit
  gac commit [options]          Same as above
  gac init [--force]            Write a starter .gac.json in this repository
  gac config                    Show the resolved configuration (API key masked)
  gac alias install [name]      Alias \`git <name>\` (default: auto-commit) to gac
  gac alias uninstall [name]    Remove that alias
  gac hook install [options]    Auto-commit after each agent turn (Claude Code,
                                Codex, OpenCode) — see "Agent hooks" below
  gac hook uninstall [options]  Remove those hooks
  gac hook status               Show which agents have the hook installed
  gac hook run --agent <name>   Internal entry point used by the hooks

${color.bold("Scope")}
  -a, --all                     Commit the whole work tree (default)
  -s, --staged                  Commit only what is already staged
      --split, --batches        Let the model split the change into several commits
      --select                  Let the model pick which files to commit now
      --push                    Push after committing

${color.bold("Model")}
      --provider <p>            openai (default) or anthropic
      --model <name>            e.g. gpt-4o-mini, claude-sonnet-4-5
      --base-url <url>          OpenAI-compatible endpoint or Anthropic base URL
      --api-key <key>           Override GAC_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY
      --lang <code>             en (default), zh, ja, ko, or auto to follow recent commits
      --max-diff-chars <n>      Diff budget in characters (default: 48000)
      --temperature <n>         Sampling temperature (default: 0.2)
      --timeout <ms>            Request timeout (default: 60000)

${color.bold("Message")}
      --emoji                   Prefix the subject with an emoji
      --plain                   No \`type(scope):\` prefix
      --type <type>             Force feat/fix/docs/... for every commit
      --scope <scope>           Force a scope
      --instructions <text>     Extra instructions for the model
      --exclude <glob,...>      Extra paths whose diff body is omitted

${color.bold("Behaviour")}
  -y, --yes                     Do not ask for confirmation
      --no                      Never prompt, always abort (useful in CI gates)
  -n, --dry-run                 Print the message but do not commit
      --no-verify               Pass --no-verify to git commit
      --fallback                Build a heuristic message if the model fails
      --json                    Machine-readable output on stdout
  -d, --debug                   Show HTTP and retry details
      --config <path>           Use a specific config file
      --version, -v             Print the version
      --help, -h                Show this help

${color.bold("Agent hooks")}
      --agent <name>            claude, codex, opencode, or all (default: all)
      --user                    Install for the current user (default)
      --project                 Install into this repository only
    Commit behaviour flags (--split, --select, --emoji, --lang, ...) are baked
    into the generated hook. Runs after a turn ends, skips merges/rebases and
    concurrent runs, logs to .git/gac-hook.log.

${color.bold("Environment")}
  GAC_API_KEY, GAC_BASE_URL, GAC_MODEL, GAC_PROVIDER, GAC_LANGUAGE,
  GAC_MAX_DIFF_CHARS, GAC_INSTRUCTIONS, GAC_EXCLUDE, OPENAI_API_KEY, ANTHROPIC_API_KEY
  GAC_HOOK_DISABLED=1 disables auto-commit hooks without uninstalling them.

${color.bold("Config files")}
  ~/.config/git-auto-commit/config.json      user defaults
  .gac.json or .git-auto-commit.json         per repository
  Precedence: flags > environment > repo config > user config > defaults
`;
}

function initConfig(root: string, force: boolean): number {
  const existing = REPO_CONFIG_FILES.map((name) => join(root, name)).find((path) => existsSync(path));
  if (existing && !force) {
    log.warn(`${existing} already exists. Use --force to overwrite it.`);
    return 0;
  }

  const target = join(root, REPO_CONFIG_FILES[0]);
  const starter = {
    provider: "openai",
    model: "gpt-4o-mini",
    language: "en",
    maxDiffChars: 48000,
    split: false,
    emoji: false,
    exclude: [],
    instructions: "",
  };
  writeFileSync(target, `${JSON.stringify(starter, null, 2)}\n`, "utf8");
  log.success(`Wrote ${target}`);
  log.info(
    [
      "",
      "Next steps:",
      `  1. Export a key:   ${color.cyan("export GAC_API_KEY=sk-...")}`,
      `  2. Preview:        ${color.cyan("gac --dry-run")}`,
      `  3. Commit for real: ${color.cyan("gac")}`,
      `  4. Optional:       ${color.cyan("gac alias install")} → ${color.cyan("git auto-commit")}`,
      "",
      `User-level defaults live in ${userConfigPath()}`,
    ].join("\n"),
  );
  return 0;
}

async function hookCommand(positionals: string[], flags: CliFlags): Promise<number> {
  const sub = (positionals[0] ?? "status").toLowerCase();

  if (sub === "run") {
    const agent = parseAgent(flags.agent ?? process.env.GAC_HOOK_AGENT);
    if (agent === "all") {
      throw new UsageError("`gac hook run` needs a concrete agent.", "Use --agent claude, codex or opencode.");
    }
    const payload = positionals.slice(1).find((item) => item.trim().startsWith("{"));
    const result = await runHook({
      agent,
      flags,
      ...(payload ? { stdin: payload } : {}),
      strict: flags.strict === true,
    });
    if (flags.debug === true || process.env.GAC_HOOK_DEBUG) log.info(color.gray(result.log));
    return result.code;
  }

  const scope = flags.hookScope ?? "user";
  const agents = agentsFrom(flags.agent);
  const root = scope === "project" ? repoRoot(process.cwd()) : process.cwd();

  if (sub === "install") {
    const results = installHooks({ agents, scope, root, flags });
    for (const result of results) {
      log.success(`${result.agent}: ${result.action} → ${result.file}`);
      if (result.note) log.warn(result.note);
    }
    const logPath = hookLogPath(root);
    if (logPath) log.info(color.gray(`Hook output is appended to ${logPath}`));
    return 0;
  }

  if (sub === "uninstall" || sub === "remove") {
    const results = uninstallHooks({ agents, scope, root });
    for (const result of results) {
      log.success(`${result.agent}: ${result.action} → ${result.file}`);
    }
    return 0;
  }

  if (sub === "status") {
    for (const entry of hookStatus(root)) {
      const mark = entry.installed
        ? color.green(`✔ installed (${entry.scope})`)
        : color.gray("· not installed");
      log.info(`  ${entry.agent.padEnd(9)} ${mark.padEnd(30)} ${color.gray(entry.file)}`);
    }
    let logPath: string | undefined;
    try {
      logPath = hookLogPath(repoRoot(process.cwd()));
    } catch {
      logPath = undefined;
    }
    if (logPath) log.info(color.gray(`  log       ${logPath}`));
    return 0;
  }

  throw new UsageError(
    `Unknown hook subcommand "${sub}".`,
    "Use `gac hook install`, `gac hook uninstall`, `gac hook status` or `gac hook run`.",
  );
}

function aliasCommand(subcommand: string | undefined, name = "auto-commit"): number {
  if (subcommand === "uninstall" || subcommand === "remove") {
    unsetAlias(name);
    log.success(`Removed alias "git ${name}".`);
    return 0;
  }
  if (subcommand && subcommand !== "install") {
    throw new UsageError(`Unknown alias subcommand "${subcommand}".`, "Use `gac alias install` or `gac alias uninstall`.");
  }
  setAlias(name, "!gac");
  log.success(`Installed alias: \`git ${name}\` → \`gac\`.`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const { flags, command, positionals } = parseArgs(argv);

  if (flags.help) {
    log.info(helpText());
    return 0;
  }
  if (flags.version) {
    log.info(VERSION);
    return 0;
  }

  if (command === "help") {
    log.info(helpText());
    return 0;
  }
  if (command === "version") {
    log.info(VERSION);
    return 0;
  }

  if (command === "alias") {
    return aliasCommand(positionals[0], positionals[1]);
  }

  if (command === "hook") {
    return hookCommand(positionals, flags);
  }

  if (command === "config") {
    // Configuration is useful outside a repository too; repo config is then skipped.
    let root = process.cwd();
    try {
      root = repoRoot(process.cwd());
    } catch {
      root = process.cwd();
    }
    const { settings, sources } = resolveSettings({ flags, root, warn: log.warn });
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ ...redactSettings(settings), endpoint: describeEndpoint(settings.ai), sources }, null, 2)}\n`);
      return 0;
    }
    log.info(color.bold("Resolved configuration"));
    for (const [key, value] of Object.entries(redactSettings(settings))) {
      const display = Array.isArray(value) ? value.join(", ") : String(value);
      log.info(`  ${key.padEnd(14)} ${display}`);
    }
    log.info(`  ${"endpoint".padEnd(14)} ${describeEndpoint(settings.ai)}`);
    const origin = Object.entries(sources);
    if (origin.length > 0) {
      log.info("");
      log.info(color.gray("Sources"));
      for (const [key, value] of origin) log.info(color.gray(`  ${key}: ${value}`));
    }
    return 0;
  }

  const root = repoRoot(process.cwd());

  if (command === "init") {
    return initConfig(root, flags.force === true);
  }

  if (command !== "commit") {
    throw new UsageError(`Unknown command "${command}".`, "Run `gac --help`.");
  }
  if (positionals.length > 0) {
    throw new UsageError(
      `Unexpected argument "${positionals[0]}".`,
      "`gac` commits the whole work tree; stage what you want and use --staged instead.",
    );
  }

  const { settings } = resolveSettings({ flags, root, warn: log.warn });
  if (!settings.ai.apiKey) {
    throw new GacError("No API key found.", {
      hint:
        "Set GAC_API_KEY (or OPENAI_API_KEY / ANTHROPIC_API_KEY), or pass --api-key.\n" +
        "Run `gac config` to see what is currently resolved.",
    });
  }

  const result = await runAutoCommit({ cwd: root, settings });

  if (settings.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          root: result.root,
          skippedReason: result.skippedReason,
          plan: result.plan,
          messages: result.messages,
          committed: result.committed,
          uncommitted: result.uncommitted,
          pushed: result.pushed,
          usage: result.usage,
        },
        null,
        2,
      )}\n`,
    );
  }

  return 0;
}

const isMain = (() => {
  // Bun's compiled binary reports the entry point through `import.meta.main`.
  if ((import.meta as ImportMeta & { main?: boolean }).main === true) return true;

  const entry = process.argv[1];
  if (!entry) return false;
  const canonical = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return canonical(entry) === canonical(fileURLToPath(import.meta.url));
})();

if (isMain) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      if (error instanceof GacError) {
        log.error(error.message);
        if (error.hint) log.hint(error.hint);
        process.exitCode = error.exitCode;
        return;
      }
      log.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exitCode = 1;
    });
}

export { main, helpText, VERSION };
