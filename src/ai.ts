import { GacError } from "./errors.ts";
import type { AiSettings, Provider } from "./types.ts";

export interface ChatRequest {
  system: string;
  user: string;
  /** Ask the provider for a JSON-only answer when it supports that. */
  json?: boolean;
}

export interface ChatResponse {
  text: string;
  provider: Provider;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface ChatOptions {
  maxAttempts?: number;
  /** Base delay for retries in ms (doubled per attempt, with jitter). */
  retryDelayMs?: number;
  debug?: (message: string) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_BASE_URLS: Record<Provider, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
};

export const DEFAULT_MODELS: Record<Provider, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-4-5",
};

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 522, 524]);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function chatCompletionsUrl(baseUrl: string): string {
  const base = trimSlash(baseUrl);
  if (/\/chat\/completions$/.test(base)) return base;
  return `${base}/chat/completions`;
}

export function anthropicMessagesUrl(baseUrl: string): string {
  const base = trimSlash(baseUrl);
  if (/\/messages$/.test(base)) return base;
  if (/\/v1$/.test(base)) return `${base}/messages`;
  return `${base}/v1/messages`;
}

interface HttpErrorDetails {
  status: number;
  body: string;
}

class HttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(details: HttpErrorDetails) {
    super(`HTTP ${details.status}`);
    this.name = "HttpError";
    this.status = details.status;
    this.body = details.body;
  }
}

function snippet(text: string, limit = 800): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit)}…` : compact;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

export function extractOpenAiText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const message = (choices[0] as { message?: unknown }).message;
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

export function extractAnthropicText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const content = (payload as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (block && typeof block === "object") {
        const { type, text } = block as { type?: string; text?: string };
        if (type === "text" && typeof text === "string") return text;
      }
      return "";
    })
    .join("");
}

function buildHeaders(settings: AiSettings): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (settings.provider === "anthropic") {
    headers["x-api-key"] = settings.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.authorization = `Bearer ${settings.apiKey}`;
    // OpenRouter and some gateways use these to attribute traffic; harmless elsewhere.
    if (/openrouter\.ai/.test(settings.baseUrl)) {
      headers["http-referer"] = "https://github.com/git-auto-commit";
      headers["x-title"] = "git-auto-commit";
    }
  }
  return headers;
}

interface RequestBody {
  url: string;
  body: Record<string, unknown>;
}

function buildRequest(
  settings: AiSettings,
  request: ChatRequest,
  jsonMode: boolean,
  includeTemperature: boolean,
): RequestBody {
  if (settings.provider === "anthropic") {
    return {
      url: anthropicMessagesUrl(settings.baseUrl),
      body: {
        model: settings.model,
        max_tokens: settings.maxTokens,
        ...(includeTemperature ? { temperature: settings.temperature } : {}),
        system: request.system,
        messages: [{ role: "user", content: request.user }],
      },
    };
  }

  const body: Record<string, unknown> = {
    model: settings.model,
    ...(includeTemperature ? { temperature: settings.temperature } : {}),
    max_tokens: settings.maxTokens,
    stream: false,
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.user },
    ],
  };
  if (jsonMode) body.response_format = { type: "json_object" };
  return { url: chatCompletionsUrl(settings.baseUrl), body };
}

async function postJson(
  settings: AiSettings,
  request: ChatRequest,
  jsonMode: boolean,
  options: ChatOptions,
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { url, body } = buildRequest(settings, request, jsonMode, settings.temperature >= 0);
  const timeout = AbortSignal.timeout(settings.timeoutMs);

  options.debug?.(`POST ${url} (model=${settings.model}, json=${jsonMode})`);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: buildHeaders(settings),
      body: JSON.stringify(body),
      signal: timeout,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new GacError(`The request to ${hostOf(url)} timed out after ${settings.timeoutMs} ms.`, {
        hint: "Lower the diff size with --max-diff-chars, or raise --timeout.",
      });
    }
    throw new GacError(`Could not reach ${hostOf(url)}: ${error instanceof Error ? error.message : String(error)}`, {
      hint: "Check your network, base URL and proxy settings.",
    });
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new HttpError({ status: response.status, body: text });
  }

  return response.json() as Promise<unknown>;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Calls the configured provider and returns the raw text answer. */
export async function chat(settings: AiSettings, request: ChatRequest, options: ChatOptions = {}): Promise<ChatResponse> {
  if (!settings.apiKey) {
    throw new GacError("No API key configured.", {
      hint:
        settings.provider === "anthropic"
          ? "Set ANTHROPIC_API_KEY, or pass --api-key."
          : "Set GAC_API_KEY or OPENAI_API_KEY, or pass --api-key.",
    });
  }

  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const baseDelay = options.retryDelayMs ?? 800;
  const sleepImpl = options.sleep ?? sleep;
  let jsonMode = request.json !== false;
  let droppedTemperature = false;

  for (let attempt = 1; ; attempt += 1) {
    try {
      const payload = await postJson(settings, request, jsonMode, options);
      const text =
        settings.provider === "anthropic" ? extractAnthropicText(payload) : extractOpenAiText(payload);

      if (!text.trim()) {
        throw new GacError("The model returned an empty message.", {
          hint: "Try a different --model, or check the provider dashboard for quota issues.",
        });
      }

      const usage = readUsage(payload);
      return {
        text,
        provider: settings.provider,
        model: settings.model,
        ...(usage ? { usage } : {}),
      };
    } catch (error) {
      if (error instanceof GacError && !(error instanceof HttpError)) throw error;

      if (error instanceof HttpError) {
        const detail = snippet(error.body);

        // Reasoning models often reject a custom temperature.
        if (!droppedTemperature && /temperature/i.test(error.body)) {
          droppedTemperature = true;
          settings = { ...settings, temperature: -1 };
          options.debug?.("Provider rejected temperature; retrying without it.");
          continue;
        }

        // Some providers reject response_format; retry once without it.
        if (jsonMode && (error.status === 400 || error.status === 404 || error.status === 422)) {
          jsonMode = false;
          options.debug?.("Provider rejected JSON mode; retrying without response_format.");
          continue;
        }

        if (error.status === 401 || error.status === 403) {
          throw new GacError(`The provider rejected the API key (HTTP ${error.status}).`, {
            hint: `Check ${settings.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "GAC_API_KEY"} and the key's permissions.`,
          });
        }
        if (error.status === 404) {
          throw new GacError(`Provider endpoint or model not found (HTTP 404): ${snippet(error.body, 300)}`, {
            hint: `Verify --base-url (${settings.baseUrl}) and --model (${settings.model}).`,
          });
        }
        if (error.status === 429) {
          if (attempt >= maxAttempts) {
            throw new GacError("The provider is rate limiting or out of quota (HTTP 429).", {
              hint: "Wait a moment, check your balance, or switch --model / --provider.",
            });
          }
          const delay = retryAfterMsFromBody(error.body) ?? baseDelay * 2 ** (attempt - 1);
          options.debug?.(`HTTP 429, retrying in ${delay} ms.`);
          await sleepImpl(delay);
          continue;
        }
        if (!RETRYABLE_STATUS.has(error.status) || attempt >= maxAttempts) {
          throw new GacError(`The provider returned HTTP ${error.status}${detail ? `: ${detail}` : ""}.`, {
            hint:
              error.status >= 500
                ? "This is usually temporary; retry in a moment."
                : "Check the request settings (model, base URL, JSON mode support).",
          });
        }
      } else if (attempt >= maxAttempts) {
        throw new GacError(
          `The model call failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const jitter = Math.floor(Math.random() * 250);
      const delay = baseDelay * 2 ** (attempt - 1) + jitter;
      options.debug?.(`Attempt ${attempt} failed, retrying in ${delay} ms.`);
      await sleepImpl(delay);
    }
  }
}

function readUsage(payload: unknown): ChatResponse["usage"] {
  if (!payload || typeof payload !== "object") return undefined;
  const usage = (payload as { usage?: Record<string, unknown> }).usage;
  if (!usage) return undefined;
  const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? NaN);
  const output = Number(usage.output_tokens ?? usage.completion_tokens ?? NaN);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return undefined;
  return {
    ...(Number.isFinite(input) ? { inputTokens: input } : {}),
    ...(Number.isFinite(output) ? { outputTokens: output } : {}),
  };
}

function retryAfterMsFromBody(body: string): number | undefined {
  const match = /retry after (\d+)/i.exec(body);
  if (!match) return undefined;
  return Number(match[1]) * 1000;
}

/** Cheap probe used by `gac doctor`: verifies URL shape without spending tokens. */
export function describeEndpoint(settings: AiSettings): string {
  return settings.provider === "anthropic"
    ? `${settings.baseUrl} (anthropic messages)`
    : `${chatCompletionsUrl(settings.baseUrl)} (openai-compatible)`;
}
