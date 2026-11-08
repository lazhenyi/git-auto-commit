import { test } from "node:test";
import assert from "node:assert/strict";
import { chat, describeEndpoint, extractAnthropicText, extractOpenAiText } from "../src/ai.ts";
import { GacError } from "../src/errors.ts";
import type { AiSettings } from "../src/types.ts";
import { anthropicReply, openAiReply, startFakeServer } from "./helpers.ts";

function settings(overrides: Partial<AiSettings> = {}): AiSettings {
  return {
    provider: "openai",
    baseUrl: "http://127.0.0.1:1/v1",
    model: "test-model",
    apiKey: "test-key",
    temperature: 0.2,
    maxTokens: 512,
    timeoutMs: 5_000,
    ...overrides,
  };
}

test("chat posts an OpenAI-compatible request and returns the text", async () => {
  const server = await startFakeServer(() => openAiReply('{"commits":[]}', { prompt: 11, completion: 3 }));
  try {
    const response = await chat(
      settings({ baseUrl: server.baseUrl }),
      { system: "sys", user: "usr" },
    );
    assert.equal(response.text, '{"commits":[]}');
    assert.deepEqual(response.usage, { inputTokens: 11, outputTokens: 3 });

    const request = server.requests[0];
    assert.equal(request?.url, "/v1/chat/completions");
    assert.equal(request?.headers.authorization, "Bearer test-key");
    assert.equal(request?.body.model, "test-model");
    assert.deepEqual(request?.body.response_format, { type: "json_object" });
    assert.equal((request?.body.messages as unknown[]).length, 2);
  } finally {
    await server.close();
  }
});

test("chat retries on 5xx and succeeds", async () => {
  let calls = 0;
  const server = await startFakeServer(() => {
    calls += 1;
    return calls === 1 ? { status: 503, raw: "upstream unavailable" } : openAiReply("ok");
  });
  try {
    const response = await chat(
      settings({ baseUrl: server.baseUrl }),
      { system: "s", user: "u" },
      { retryDelayMs: 1, maxAttempts: 3 },
    );
    assert.equal(response.text, "ok");
    assert.equal(calls, 2);
  } finally {
    await server.close();
  }
});

test("chat retries without response_format when the provider rejects JSON mode", async () => {
  const requests: Record<string, unknown>[] = [];
  const server = await startFakeServer((request) => {
    requests.push(request.body);
    if (request.body.response_format) {
      return { status: 400, raw: '{"error":"response_format is not supported"}' };
    }
    return openAiReply("plain-json");
  });
  try {
    const response = await chat(settings({ baseUrl: server.baseUrl }), { system: "s", user: "u" });
    assert.equal(response.text, "plain-json");
    assert.equal(requests.length, 2);
    assert.equal(requests[1]?.response_format, undefined);
  } finally {
    await server.close();
  }
});

test("chat retries without temperature when the provider rejects it", async () => {
  const requests: Record<string, unknown>[] = [];
  const server = await startFakeServer((request) => {
    requests.push(request.body);
    return request.body.temperature === undefined
      ? openAiReply("done")
      : { status: 400, raw: '{"error":"temperature is not supported for this model"}' };
  });
  try {
    const response = await chat(settings({ baseUrl: server.baseUrl }), { system: "s", user: "u" });
    assert.equal(response.text, "done");
    assert.equal(requests[1]?.temperature, undefined);
  } finally {
    await server.close();
  }
});

test("chat does not retry a bad API key and explains the fix", async () => {
  let calls = 0;
  const server = await startFakeServer(() => {
    calls += 1;
    return { status: 401, raw: '{"error":"invalid api key"}' };
  });
  try {
    await assert.rejects(
      chat(settings({ baseUrl: server.baseUrl }), { system: "s", user: "u" }, { retryDelayMs: 1 }),
      (error: unknown) => {
        assert.ok(error instanceof GacError);
        assert.match(error.message, /rejected the API key/);
        assert.match(error.hint ?? "", /GAC_API_KEY/);
        return true;
      },
    );
    assert.equal(calls, 1);
  } finally {
    await server.close();
  }
});

test("chat reports timeouts with a useful hint", async () => {
  const server = await startFakeServer(() => ({ ...openAiReply("late"), delayMs: 120 }));
  try {
    await assert.rejects(
      chat(
        settings({ baseUrl: server.baseUrl, timeoutMs: 20 }),
        { system: "s", user: "u" },
        { retryDelayMs: 1, maxAttempts: 1 },
      ),
      /timed out/,
    );
  } finally {
    await server.close();
  }
});

test("chat requires an API key", async () => {
  await assert.rejects(chat(settings({ apiKey: "" }), { system: "s", user: "u" }), /No API key/);
});

test("empty model answers are surfaced", async () => {
  const server = await startFakeServer(() => openAiReply("   "));
  try {
    await assert.rejects(
      chat(settings({ baseUrl: server.baseUrl }), { system: "s", user: "u" }, { maxAttempts: 1 }),
      /empty message/,
    );
  } finally {
    await server.close();
  }
});

test("anthropic requests use the messages endpoint and x-api-key", async () => {
  const server = await startFakeServer(() => anthropicReply("claude says hi"));
  try {
    const response = await chat(
      settings({
        provider: "anthropic",
        baseUrl: server.baseUrl.replace(/\/v1$/, ""),
        model: "claude-test",
      }),
      { system: "sys", user: "usr" },
    );
    assert.equal(response.text, "claude says hi");
    assert.equal(response.provider, "anthropic");
    assert.deepEqual(response.usage, { inputTokens: 5, outputTokens: 7 });

    const request = server.requests[0];
    assert.equal(request?.url, "/v1/messages");
    assert.equal(request?.headers["x-api-key"], "test-key");
    assert.equal(request?.headers["anthropic-version"], "2023-06-01");
    assert.equal(request?.body.system, "sys");
    assert.deepEqual(request?.body.response_format, undefined);
  } finally {
    await server.close();
  }
});

test("extractors cope with array-shaped content", () => {
  assert.equal(
    extractOpenAiText({ choices: [{ message: { content: [{ type: "text", text: "a" }, { text: "b" }] } }] }),
    "ab",
  );
  assert.equal(extractOpenAiText({ choices: [] }), "");
  assert.equal(
    extractAnthropicText({ content: [{ type: "thinking", text: "no" }, { type: "text", text: "yes" }] }),
    "yes",
  );
});

test("describeEndpoint explains what will be called", () => {
  assert.match(describeEndpoint(settings()), /openai-compatible/);
  assert.match(describeEndpoint(settings({ provider: "anthropic" })), /anthropic messages/);
});
