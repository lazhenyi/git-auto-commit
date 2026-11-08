import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BASE_URLS, DEFAULT_MODELS } from "./ai.ts";
import { DEFAULT_EXCLUDE } from "./diff.ts";
import { readTemplateFile, validateTemplate } from "./template.ts";
import { UsageError } from "./errors.ts";
import type { CliFlags, ConfigFile, Language, Provider, Settings } from "./types.ts";

export const REPO_CONFIG_FILES = [".gac.json", ".git-auto-commit.json"] as const;
export const USER_CONFIG_DIR = "git-auto-commit";

export const DEFAULTS = {
  provider: "openai" as Provider,
  model: DEFAULT_MODELS.openai,
  temperature: 0.2,
  maxTokens: 2048,
  timeoutMs: 60_000,
  language: "en" as Language,
  maxDiffChars: 48_000,
  split: false,
  select: false,
  emoji: false,
  noVerify: false,
  typeStyle: "conventional" as const,
  instructions: "",
  fallback: false,
  stagedOnly: false,
};

export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME?.trim()
    ? env.XDG_CONFIG_HOME.trim()
    : join(homedir(), ".config");
  return join(base, USER_CONFIG_DIR, "config.json");
}

export function repoConfigPath(root: string): string | undefined {
  for (const name of REPO_CONFIG_FILES) {
    const path = join(root, name);
    try {
      readFileSync(path, "utf8");
      return path;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

function readConfigFile(path: string, required = false): ConfigFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (required) {
      throw new UsageError(`Could not read config file ${path}`, "Check the path and permissions.");
    }
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new UsageError(
      `Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`,
      "Fix the file, or delete it to fall back to defaults.",
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError(`Config file ${path} must contain a JSON object.`);
  }
  return parsed as ConfigFile;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function parseNumber(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new UsageError(`${name} must be a number, got "${value}".`);
  return parsed;
}

function envConfig(env: NodeJS.ProcessEnv): ConfigFile {
  const provider = env.GAC_PROVIDER?.trim().toLowerCase();
  return {
    ...(provider ? { provider: provider as Provider } : {}),
    ...(env.GAC_BASE_URL ? { baseUrl: env.GAC_BASE_URL } : {}),
    ...(env.GAC_MODEL ? { model: env.GAC_MODEL } : {}),
    ...(env.GAC_API_KEY ? { apiKey: env.GAC_API_KEY } : {}),
    ...(env.GAC_TEMPERATURE ? { temperature: parseNumber(env.GAC_TEMPERATURE, "GAC_TEMPERATURE") } : {}),
    ...(env.GAC_MAX_TOKENS ? { maxTokens: parseNumber(env.GAC_MAX_TOKENS, "GAC_MAX_TOKENS") } : {}),
    ...(env.GAC_TIMEOUT_MS ? { timeoutMs: parseNumber(env.GAC_TIMEOUT_MS, "GAC_TIMEOUT_MS") } : {}),
    ...(env.GAC_LANGUAGE ?? env.GAC_LANG
      ? { language: (env.GAC_LANGUAGE ?? env.GAC_LANG) as Language }
      : {}),
    ...(env.GAC_MAX_DIFF_CHARS
      ? { maxDiffChars: parseNumber(env.GAC_MAX_DIFF_CHARS, "GAC_MAX_DIFF_CHARS") }
      : {}),
    ...(parseBoolean(env.GAC_SPLIT) !== undefined ? { split: parseBoolean(env.GAC_SPLIT) } : {}),
    ...(parseBoolean(env.GAC_SELECT) !== undefined ? { select: parseBoolean(env.GAC_SELECT) } : {}),
    ...(parseBoolean(env.GAC_EMOJI) !== undefined ? { emoji: parseBoolean(env.GAC_EMOJI) } : {}),
    ...(parseBoolean(env.GAC_NO_VERIFY) !== undefined
      ? { noVerify: parseBoolean(env.GAC_NO_VERIFY) }
      : {}),
    ...(parseBoolean(env.GAC_FALLBACK) !== undefined
      ? { fallback: parseBoolean(env.GAC_FALLBACK) }
      : {}),
    ...(parseBoolean(env.GAC_STAGED_ONLY) !== undefined
      ? { stagedOnly: parseBoolean(env.GAC_STAGED_ONLY) }
      : {}),
    ...(parseBoolean(env.GAC_PUSH) !== undefined ? { push: parseBoolean(env.GAC_PUSH) } : {}),
    ...(env.GAC_INSTRUCTIONS ? { instructions: env.GAC_INSTRUCTIONS } : {}),
    ...(env.GAC_EXCLUDE
      ? { exclude: env.GAC_EXCLUDE.split(",").map((item) => item.trim()).filter(Boolean) }
      : {}),
    ...(env.GAC_TEMPLATE ? { template: env.GAC_TEMPLATE } : {}),
    ...(env.GAC_TEMPLATE_FILE ? { templateFile: env.GAC_TEMPLATE_FILE } : {}),
  };
}

const KNOWN_KEYS: ReadonlySet<string> = new Set([
  "provider",
  "baseUrl",
  "model",
  "apiKey",
  "temperature",
  "maxTokens",
  "timeoutMs",
  "language",
  "maxDiffChars",
  "split",
  "select",
  "emoji",
  "noVerify",
  "typeStyle",
  "instructions",
  "template",
  "templateFile",
  "exclude",
  "fallback",
  "stagedOnly",
  "push",
]);

function sanitizeFileConfig(file: ConfigFile, path: string): ConfigFile {
  const out: ConfigFile = {};
  for (const [key, value] of Object.entries(file)) {
    if (value === undefined || value === null) continue;
    if (!KNOWN_KEYS.has(key)) {
      process.stderr.write(`! ignored unknown config key "${key}" in ${path}\n`);
      continue;
    }
    if (key === "exclude") {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new UsageError(`"exclude" in ${path} must be an array of glob strings.`);
      }
      out.exclude = value as string[];
      continue;
    }
    if (key === "language" && typeof value === "string") {
      out.language = value;
      continue;
    }
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

function inferProvider(file: ConfigFile, env: NodeJS.ProcessEnv): Provider {
  if (file.provider) {
    if (file.provider !== "openai" && file.provider !== "anthropic") {
      throw new UsageError(`Unknown provider "${file.provider}".`, "Use \"openai\" or \"anthropic\".");
    }
    return file.provider;
  }
  const model = file.model?.toLowerCase() ?? "";
  const baseUrl = file.baseUrl?.toLowerCase() ?? "";
  if (model.startsWith("claude") || baseUrl.includes("anthropic")) return "anthropic";
  if (!file.apiKey && !file.model && !file.baseUrl && env.ANTHROPIC_API_KEY && !env.OPENAI_API_KEY) {
    return "anthropic";
  }
  return DEFAULTS.provider;
}

function resolveApiKey(file: ConfigFile, provider: Provider, env: NodeJS.ProcessEnv): string {
  const fromConfig = file.apiKey?.trim();
  if (fromConfig?.startsWith("env:")) {
    return env[fromConfig.slice(4).trim()]?.trim() ?? "";
  }
  if (fromConfig) return fromConfig;
  if (env.GAC_API_KEY?.trim()) return env.GAC_API_KEY.trim();
  if (provider === "anthropic") return env.ANTHROPIC_API_KEY?.trim() ?? "";
  return env.OPENAI_API_KEY?.trim() ?? "";
}

export interface ResolveSettingsInput {
  flags?: CliFlags;
  env?: NodeJS.ProcessEnv;
  root: string;
  /** Informational label for the config that ended up being used. */
  warn?: (message: string) => void;
}

export interface ResolvedSettings {
  settings: Settings;
  sources: { userConfig?: string; repoConfig?: string; explicitConfig?: string };
}

export function resolveSettings(input: ResolveSettingsInput): ResolvedSettings {
  const env = input.env ?? process.env;
  const flags = input.flags ?? {};

  const explicitPath = flags.configPath;
  const explicit = explicitPath ? sanitizeFileConfig(readConfigFile(explicitPath, true), explicitPath) : {};

  const userPath = userConfigPath(env);
  const user = explicitPath ? {} : sanitizeFileConfig(readConfigFile(userPath), userPath);

  const repoPath = explicitPath ? undefined : repoConfigPath(input.root);
  const repo = repoPath ? sanitizeFileConfig(readConfigFile(repoPath), repoPath) : {};
  if (repo.apiKey && !explicitPath) {
    input.warn?.(
      `${repoPath} contains an API key; prefer the GAC_API_KEY environment variable so it cannot be committed.`,
    );
  }

  const fromEnv = envConfig(env);
  const fromFlags: ConfigFile = {
    ...(flags.provider ? { provider: flags.provider } : {}),
    ...(flags.baseUrl ? { baseUrl: flags.baseUrl } : {}),
    ...(flags.model ? { model: flags.model } : {}),
    ...(flags.apiKey ? { apiKey: flags.apiKey } : {}),
    ...(flags.temperature !== undefined ? { temperature: flags.temperature } : {}),
    ...(flags.maxTokens !== undefined ? { maxTokens: flags.maxTokens } : {}),
    ...(flags.timeoutMs !== undefined ? { timeoutMs: flags.timeoutMs } : {}),
    ...(flags.language ? { language: flags.language } : {}),
    ...(flags.maxDiffChars !== undefined ? { maxDiffChars: flags.maxDiffChars } : {}),
    ...(flags.split !== undefined ? { split: flags.split } : {}),
    ...(flags.select !== undefined ? { select: flags.select } : {}),
    ...(flags.emoji !== undefined ? { emoji: flags.emoji } : {}),
    ...(flags.noVerify !== undefined ? { noVerify: flags.noVerify } : {}),
    ...(flags.typeStyle ? { typeStyle: flags.typeStyle } : {}),
    ...(flags.instructions ? { instructions: flags.instructions } : {}),
    ...(flags.template ? { template: flags.template } : {}),
    ...(flags.templateFile ? { templateFile: flags.templateFile } : {}),
    ...(flags.exclude ? { exclude: flags.exclude } : {}),
    ...(flags.fallback !== undefined ? { fallback: flags.fallback } : {}),
    ...(flags.stagedOnly !== undefined ? { stagedOnly: flags.stagedOnly } : {}),
    ...(flags.push !== undefined ? { push: flags.push } : {}),
  };

  // Explicit config is the base of last resort, so flags still win over it.
  const layered: ConfigFile = { ...explicit, ...user, ...repo, ...fromEnv, ...fromFlags };

  // `template` and `templateFile` describe the same thing, so the highest layer
  // that sets either one wins as a pair.
  let templateChoice: ConfigFile = {};
  for (const layer of [fromFlags, fromEnv, repo, user, explicit]) {
    const inline = typeof layer.template === "string" ? layer.template.trim() : "";
    const file = typeof layer.templateFile === "string" ? layer.templateFile.trim() : "";
    if (inline || file) {
      templateChoice = inline ? { template: layer.template } : { templateFile: layer.templateFile };
      break;
    }
  }

  let template: string | undefined;
  let templateFile: string | undefined;
  if (templateChoice.template) {
    template = templateChoice.template;
    validateTemplate(template);
  } else if (templateChoice.templateFile) {
    const loaded = readTemplateFile(templateChoice.templateFile, input.root, env);
    template = loaded.text;
    templateFile = loaded.file;
    validateTemplate(template);
  }

  const provider = inferProvider(layered, env);
  const apiKey = resolveApiKey(layered, provider, env);
  const baseUrl = (layered.baseUrl?.trim() || DEFAULT_BASE_URLS[provider]).replace(/\/+$/, "");
  const model = layered.model?.trim() || DEFAULT_MODELS[provider];

  const maxDiffChars = Math.floor(layered.maxDiffChars ?? DEFAULTS.maxDiffChars);
  if (!Number.isFinite(maxDiffChars) || maxDiffChars < 1000) {
    throw new UsageError("maxDiffChars must be at least 1000.", "Example: --max-diff-chars 30000");
  }

  const temperature = layered.temperature ?? DEFAULTS.temperature;
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new UsageError("temperature must be between 0 and 2.");
  }

  const timeoutMs = Math.floor(layered.timeoutMs ?? DEFAULTS.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
    throw new UsageError("timeoutMs must be at least 1000 ms.");
  }

  const maxTokens = Math.floor(layered.maxTokens ?? DEFAULTS.maxTokens);
  if (!Number.isFinite(maxTokens) || maxTokens < 64) {
    throw new UsageError("maxTokens must be at least 64.");
  }

  const userExclude = layered.exclude ?? [];
  const exclude = [...new Set([...DEFAULT_EXCLUDE, ...userExclude])];

  const settings: Settings = {
    ai: {
      provider,
      baseUrl,
      model,
      apiKey,
      temperature,
      maxTokens,
      timeoutMs,
    },
    language: layered.language ?? DEFAULTS.language,
    maxDiffChars,
    split: layered.split ?? DEFAULTS.split,
    select: layered.select ?? DEFAULTS.select,
    emoji: layered.emoji ?? DEFAULTS.emoji,
    noVerify: layered.noVerify ?? DEFAULTS.noVerify,
    typeStyle: layered.typeStyle ?? DEFAULTS.typeStyle,
    instructions: layered.instructions ?? DEFAULTS.instructions,
    ...(template ? { template } : {}),
    ...(templateFile ? { templateFile } : {}),
    exclude,
    fallback: layered.fallback ?? DEFAULTS.fallback,
    stagedOnly: layered.stagedOnly ?? DEFAULTS.stagedOnly,
    yes: flags.yes ?? false,
    dryRun: flags.dryRun ?? false,
    push: layered.push ?? false,
    json: flags.json ?? false,
    debug: flags.debug ?? parseBoolean(env.GAC_DEBUG) ?? false,
    ...(flags.forceType ? { forceType: flags.forceType } : {}),
    ...(flags.forceScope ? { forceScope: flags.forceScope } : {}),
    ...(flags.configPath ? { configPath: flags.configPath } : {}),
  };

  const sources = {
    ...(explicitPath ? { explicitConfig: explicitPath } : {}),
    ...(repoPath ? { repoConfig: repoPath } : {}),
    ...(readable(userPath) && !explicitPath ? { userConfig: userPath } : {}),
  };

  return { settings, sources };
}

function readable(path: string): boolean {
  try {
    readFileSync(path, "utf8");
    return true;
  } catch {
    return false;
  }
}

export function maskSecret(secret: string): string {
  if (!secret) return "(not set)";
  if (secret.length <= 8) return `${secret.slice(0, 2)}…`;
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}

/** Drops the secret and normalizes the shape for `gac config` / `--json`. */
export function redactSettings(settings: Settings): Record<string, unknown> {
  return {
    provider: settings.ai.provider,
    baseUrl: settings.ai.baseUrl,
    model: settings.ai.model,
    apiKey: maskSecret(settings.ai.apiKey),
    temperature: settings.ai.temperature,
    maxTokens: settings.ai.maxTokens,
    timeoutMs: settings.ai.timeoutMs,
    language: settings.language,
    maxDiffChars: settings.maxDiffChars,
    split: settings.split,
    emoji: settings.emoji,
    noVerify: settings.noVerify,
    typeStyle: settings.typeStyle,
    instructions: settings.instructions,
    ...(settings.template ? { template: settings.template.replace(/\n/g, "\\n") } : {}),
    ...(settings.templateFile ? { templateFile: settings.templateFile } : {}),
    exclude: settings.exclude,
    fallback: settings.fallback,
    stagedOnly: settings.stagedOnly,
    push: settings.push,
  };
}
