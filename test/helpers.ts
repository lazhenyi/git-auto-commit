import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
  rawBody: string;
}

export interface FakeReply {
  status?: number;
  /** JSON body; either this or `raw` is used. */
  json?: unknown;
  raw?: string;
  delayMs?: number;
  headers?: Record<string, string>;
}

export type FakeHandler = (
  request: RecordedRequest,
  index: number,
) => FakeReply | Promise<FakeReply>;

export interface FakeServer {
  baseUrl: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
  server: Server;
}

export async function startFakeServer(handler: FakeHandler): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let rawBody = "";
    request.on("data", (chunk) => {
      rawBody += chunk;
    });
    request.on("end", async () => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
      } catch {
        parsed = {};
      }
      const recorded: RecordedRequest = {
        url: request.url ?? "",
        method: request.method ?? "GET",
        headers: request.headers,
        body: parsed,
        rawBody,
      };
      requests.push(recorded);

      try {
        const reply = await handler(recorded, requests.length - 1);
        if (reply.delayMs) await new Promise((done) => setTimeout(done, reply.delayMs));
        response.writeHead(reply.status ?? 200, {
          "content-type": "application/json",
          ...reply.headers,
        });
        response.end(reply.raw ?? JSON.stringify(reply.json ?? {}));
      } catch (error) {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end(String(error));
      }
    });
  });

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    server,
    close: () =>
      new Promise<void>((done, fail) => {
        server.close((error) => (error ? fail(error) : done()));
      }),
  };
}

/** Wraps the text in the OpenAI chat-completions response shape. */
export function openAiReply(content: string, usage?: { prompt: number; completion: number }): FakeReply {
  return {
    json: {
      choices: [{ index: 0, message: { role: "assistant", content } }],
      ...(usage
        ? { usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion } }
        : {}),
    },
  };
}

/** OpenAI-shaped reply whose content is a JSON commit plan. */
export function planReply(plan: unknown): FakeReply {
  return openAiReply(JSON.stringify(plan));
}

export function anthropicReply(text: string): FakeReply {
  return { json: { content: [{ type: "text", text }], usage: { input_tokens: 5, output_tokens: 7 } } };
}

export interface TempRepo {
  path: string;
  git: (...args: string[]) => string;
  write: (path: string, content: string) => void;
  commitCount: () => number;
  subjects: () => string[];
  status: () => string;
  filesIn: (rev: string) => string[];
}

export function makeRepo(options: { initialCommit?: boolean } = {}): TempRepo {
  const path = mkdtempSync(join(tmpdir(), "gac-repo-"));
  const git = (...args: string[]): string => {
    const result = spawnSync("git", args, { cwd: path, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    }
    return result.stdout.trim();
  };

  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test User");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  if (options.initialCommit !== false) {
    git("commit", "-q", "--allow-empty", "-m", "chore: initial commit");
  }

  const write = (file: string, content: string): void => {
    const absolute = join(path, file);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  };

  return {
    path,
    git,
    write,
    commitCount: () => Number(git("rev-list", "--count", "HEAD")),
    subjects: () => git("log", "--reverse", "--pretty=format:%s").split("\n").filter(Boolean),
    status: () => git("status", "--porcelain"),
    filesIn: (rev: string) =>
      git("show", "--name-only", "--pretty=format:", rev).split("\n").filter(Boolean),
  };
}

const CLI = resolve(import.meta.dirname, "../src/cli.ts");

/** Removes every provider/credential variable that could leak into a test. */
export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(GAC_|OPENAI_|ANTHROPIC_|XDG_CONFIG_HOME$)/.test(key)) continue;
    env[key] = value;
  }
  env.NO_COLOR = "1";
  env.EDITOR = "true";
  // Keep the user's real config out of the tests.
  env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "gac-xdg-"));
  return { ...env, ...extra };
}

export interface CliResult {
  stdout: string;
  stderr: string;
  status: number;
}

/**
 * Spawns the CLI asynchronously: the fake model server lives in this process,
 * so a blocking `spawnSync` would deadlock the test.
 */
export interface RunCliOptions {
  cwd: string;
  env?: Record<string, string>;
  timeout?: number;
  /** Run a compiled executable instead of the TypeScript entry point. */
  entry?: string;
  /** Write this to stdin (hook payloads). */
  input?: string;
}

export function runCli(args: string[], options: RunCliOptions = { cwd: process.cwd() }): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const stdio: ["pipe" | "ignore", "pipe", "pipe"] = options.input
      ? ["pipe", "pipe", "pipe"]
      : ["ignore", "pipe", "pipe"];
    const child = options.entry
      ? spawn(options.entry, args, {
          cwd: options.cwd,
          env: cleanEnv(options.env),
          stdio,
        })
      : spawn(process.execPath, [CLI, ...args], {
          cwd: options.cwd,
          env: cleanEnv(options.env),
          stdio,
        });

    if (options.input) child.stdin?.end(options.input);

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`gac ${args.join(" ")} timed out\n${stderr}`));
    }, options.timeout ?? 60_000);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, status: status ?? 1 });
    });
  });
}
