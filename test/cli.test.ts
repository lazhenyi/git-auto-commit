import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRepo, planReply, runCli, startFakeServer } from "./helpers.ts";

const MODEL_FLAGS = ["--model", "fake-1", "--api-key", "test-key", "--lang", "en"];

test("commits everything with an AI-written conventional message", async () => {
  const server = await startFakeServer(() =>
    planReply({
      commits: [{ type: "feat", subject: "add greeting", body: "Explain why.", breaking: false }],
    }),
  );
  const repo = makeRepo();
  try {
    repo.write("hello.txt", "hello world\n");
    repo.write("README.md", "# demo\n");
    repo.git("add", "README.md");

    const result = await runCli(["--yes", "--base-url", server.baseUrl, ...MODEL_FLAGS], { cwd: repo.path });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(repo.subjects().at(-1), "feat: add greeting");
    assert.equal(repo.git("log", "-1", "--pretty=%b"), "Explain why.");
    assert.equal(repo.status(), "");
    assert.equal(repo.commitCount(), 2);

    const prompt = String((server.requests[0]?.body.messages as { content: string }[])[1]?.content);
    assert.match(prompt, /hello world/);
    assert.match(prompt, /README\.md/);
    assert.match(prompt, /Unified diff/);
    assert.deepEqual(server.requests[0]?.body.response_format, { type: "json_object" });
  } finally {
    await server.close();
  }
});

test("--dry-run prints the message and leaves the repository untouched", async () => {
  const server = await startFakeServer(() => planReply({ commits: [{ type: "fix", subject: "repair thing" }] }));
  const repo = makeRepo();
  try {
    repo.write("a.txt", "content\n");
    const before = repo.commitCount();
    const result = await runCli(["--dry-run", "--yes", "--base-url", server.baseUrl, ...MODEL_FLAGS], {
      cwd: repo.path,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /fix: repair thing/);
    assert.match(result.stdout, /Dry run/);
    assert.equal(repo.commitCount(), before);
    assert.equal(repo.status(), "?? a.txt");
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test("--split produces one commit per file group", async () => {
  const server = await startFakeServer(() =>
    planReply({
      commits: [
        { type: "feat", subject: "add api", files: ["src/api.ts"] },
        { type: "docs", subject: "document api", files: ["README.md"] },
      ],
    }),
  );
  const repo = makeRepo();
  try {
    repo.write("src/api.ts", "export const api = 1;\n");
    repo.write("README.md", "# api\n");

    const result = await runCli(["--split", "--yes", "--base-url", server.baseUrl, ...MODEL_FLAGS], {
      cwd: repo.path,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(repo.subjects(), ["chore: initial commit", "feat: add api", "docs: document api"]);
    assert.equal(repo.status(), "");

    const head = repo.git("rev-parse", "HEAD");
    const parent = repo.git("rev-parse", "HEAD~1");
    assert.deepEqual(repo.filesIn(head), ["README.md"]);
    assert.deepEqual(repo.filesIn(parent), ["src/api.ts"]);
  } finally {
    await server.close();
  }
});

test("--staged commits only the index and leaves the work tree alone", async () => {
  const server = await startFakeServer(() => planReply({ commits: [{ type: "feat", subject: "add a" }] }));
  const repo = makeRepo();
  try {
    repo.write("a.txt", "aaa\n");
    repo.write("b.txt", "bbb\n");
    repo.git("add", "a.txt");

    const result = await runCli(["--staged", "--yes", "--base-url", server.baseUrl, ...MODEL_FLAGS], {
      cwd: repo.path,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(repo.subjects().at(-1), "feat: add a");
    assert.equal(repo.status(), "?? b.txt");

    const prompt = String((server.requests[0]?.body.messages as { content: string }[])[1]?.content);
    assert.match(prompt, /a\.txt/);
    assert.doesNotMatch(prompt, /bbb/);
  } finally {
    await server.close();
  }
});

test("a clean work tree exits successfully without calling the model", async () => {
  const server = await startFakeServer(() => planReply({ commits: [{ type: "chore", subject: "never" }] }));
  const repo = makeRepo();
  try {
    const result = await runCli(["--yes", "--base-url", server.baseUrl, ...MODEL_FLAGS], { cwd: repo.path });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Nothing to commit/);
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test("a missing API key fails with an actionable hint", async () => {
  const repo = makeRepo();
  const result = await runCli(["--yes"], { cwd: repo.path });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No API key/);
  assert.match(result.stderr, /GAC_API_KEY/);
});

test("--json keeps stdout machine-readable", async () => {
  const server = await startFakeServer(() => planReply({ commits: [{ type: "feat", subject: "add x" }] }));
  const repo = makeRepo();
  try {
    repo.write("x.txt", "x\n");
    const result = await runCli(["--json", "--dry-run", "--yes", "--base-url", server.baseUrl, ...MODEL_FLAGS], {
      cwd: repo.path,
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      plan: { type: string; subject: string }[];
      messages: { subject: string }[];
      skippedReason: string;
    };
    assert.equal(payload.skippedReason, "dry-run");
    assert.equal(payload.messages[0]?.subject, "feat: add x");
    assert.equal(payload.plan[0]?.type, "feat");
    assert.match(result.stderr, /Reading changes/);
  } finally {
    await server.close();
  }
});

test("init writes a config file and config reports the resolved settings", async () => {
  const repo = makeRepo();

  const init = await runCli(["init"], { cwd: repo.path });
  assert.equal(init.status, 0, init.stderr);
  const configPath = join(repo.path, ".gac.json");
  assert.ok(existsSync(configPath));

  const again = await runCli(["init"], { cwd: repo.path });
  assert.match(again.stderr, /already exists/);

  const forced = await runCli(["init", "--force"], { cwd: repo.path });
  assert.equal(forced.status, 0, forced.stderr);

  const config = await runCli(["config", "--json", "--api-key", "abcdefghijkl"], { cwd: repo.path });
  assert.equal(config.status, 0, config.stderr);
  const resolved = JSON.parse(config.stdout) as Record<string, unknown>;
  assert.equal(resolved.apiKey, "abcd…ijkl");
  assert.equal(resolved.language, "en");
  assert.match(String(resolved.endpoint), /chat\/completions/);
  assert.ok(Array.isArray(resolved.exclude));
});

test("flags override repository config, which overrides defaults", async () => {
  const server = await startFakeServer(() => planReply({ commits: [{ type: "chore", subject: "noop" }] }));
  const repo = makeRepo();
  try {
    repo.write("x.txt", "x\n");
    writeFileSync(
      join(repo.path, ".gac.json"),
      JSON.stringify({ model: "from-repo", temperature: 0.9 }),
      "utf8",
    );

    const fromRepo = await runCli(["--dry-run", "--yes", "--base-url", server.baseUrl, "--api-key", "k"], {
      cwd: repo.path,
    });
    assert.equal(fromRepo.status, 0, fromRepo.stderr);
    assert.equal(server.requests[0]?.body.model, "from-repo");
    assert.equal(server.requests[0]?.body.temperature, 0.9);

    const fromFlag = await runCli(
      ["--dry-run", "--yes", "--base-url", server.baseUrl, "--api-key", "k", "--model", "from-flag"],
      { cwd: repo.path },
    );
    assert.equal(fromFlag.status, 0, fromFlag.stderr);
    assert.equal(server.requests[1]?.body.model, "from-flag");
  } finally {
    await server.close();
  }
});

test("unknown options and unknown commands fail with exit code 2", async () => {
  const repo = makeRepo();
  const badFlag = await runCli(["--nope"], { cwd: repo.path });
  assert.equal(badFlag.status, 2);
  assert.match(badFlag.stderr, /Unknown option/);

  const badCommand = await runCli(["deploy"], { cwd: repo.path });
  assert.equal(badCommand.status, 2);
  assert.match(badCommand.stderr, /Unknown command/);
});

test("the alias subcommand installs and removes git auto-commit", async () => {
  const repo = makeRepo();
  const home = mkdtempSync(join(tmpdir(), "gac-home-"));
  const env = { HOME: home, XDG_CONFIG_HOME: home };

  const install = await runCli(["alias", "install"], { cwd: repo.path, env });
  assert.equal(install.status, 0, install.stderr);

  const value = await runCli(["alias", "install"], { cwd: repo.path, env });
  assert.equal(value.status, 0);

  const configFile = join(home, ".gitconfig");
  assert.match(readFileSync(configFile, "utf8"), /auto-commit = !?gac/);

  const uninstall = await runCli(["alias", "uninstall"], { cwd: repo.path, env });
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.doesNotMatch(readFileSync(configFile, "utf8"), /auto-commit/);
});

test("a repository without commits can still be committed to", async () => {
  const server = await startFakeServer(() =>
    planReply({ commits: [{ type: "feat", subject: "first commit" }] }),
  );
  const repo = makeRepo({ initialCommit: false });
  try {
    repo.write("first.txt", "hello\n");
    const result = await runCli(["--yes", "--base-url", server.baseUrl, ...MODEL_FLAGS], {
      cwd: repo.path,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(repo.subjects().at(-1), "feat: first commit");
    const firstPrompt = (server.requests[0]?.body.messages as { content: string }[])[1]?.content ?? "";
    assert.match(firstPrompt, /first\.txt/);
  } finally {
    await server.close();
  }
});

test("--fallback commits a heuristic message when the model keeps failing", async () => {
  const server = await startFakeServer(() => ({ status: 500, raw: "boom" }));
  const repo = makeRepo();
  try {
    repo.write("notes.txt", "some notes\n");
    const result = await runCli(
      ["--fallback", "--yes", "--base-url", server.baseUrl, ...MODEL_FLAGS],
      { cwd: repo.path, env: { GAC_RETRY_DELAY_MS: "1" } },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(repo.subjects().at(-1), "chore: update a.txt".replace("a.txt", "notes.txt"));
    assert.equal(repo.status(), "");
  } finally {
    await server.close();
  }
});

test("a failing pre-commit hook is reported, and --no-verify bypasses it", async () => {
  const server = await startFakeServer(() => planReply({ commits: [{ type: "feat", subject: "hook test" }] }));
  const repo = makeRepo();
  try {
    repo.write("h.txt", "hook\n");
    const hook = join(repo.path, ".git/hooks/pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho 'lint failed' >&2\nexit 1\n", "utf8");
    chmodSync(hook, 0o755);

    const blocked = await runCli(["--yes", "--base-url", server.baseUrl, ...MODEL_FLAGS], {
      cwd: repo.path,
    });
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /git commit failed/);
    assert.match(blocked.stderr, /--no-verify/);
    assert.equal(repo.subjects().at(-1), "chore: initial commit");

    const bypassed = await runCli(
      ["--yes", "--no-verify", "--base-url", server.baseUrl, ...MODEL_FLAGS],
      { cwd: repo.path },
    );
    assert.equal(bypassed.status, 0, bypassed.stderr);
    assert.equal(repo.subjects().at(-1), "feat: hook test");
  } finally {
    await server.close();
  }
});

test("--push publishes the new commit to the upstream", async () => {
  const server = await startFakeServer(() => planReply({ commits: [{ type: "feat", subject: "push me" }] }));
  const repo = makeRepo();
  const remote = mkdtempSync(join(tmpdir(), "gac-remote-"));
  try {
    repo.git("init", "--bare", "-q", remote);
    repo.git("remote", "add", "origin", remote);
    repo.write("p.txt", "push\n");

    const result = await runCli(
      ["--yes", "--push", "--base-url", server.baseUrl, ...MODEL_FLAGS],
      { cwd: repo.path },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Pushed/);
    assert.equal(repo.git("--git-dir", remote, "log", "-1", "--all", "--pretty=%s"), "feat: push me");
  } finally {
    await server.close();
  }
});

test("lock files are listed but their diff bodies are excluded", async () => {
  const server = await startFakeServer(() => planReply({ commits: [{ type: "build", subject: "update lock" }] }));
  const repo = makeRepo();
  try {
    repo.write("pnpm-lock.yaml", "LOCKFILE_SECRET_CONTENT\n");
    repo.write("src/app.ts", "export const app = 1;\n");
    const result = await runCli(["--dry-run", "--yes", "--base-url", server.baseUrl, ...MODEL_FLAGS], {
      cwd: repo.path,
    });
    assert.equal(result.status, 0, result.stderr);
    const prompt = String((server.requests[0]?.body.messages as { content: string }[])[1]?.content);
    assert.match(prompt, /pnpm-lock\.yaml/);
    assert.doesNotMatch(prompt, /LOCKFILE_SECRET_CONTENT/);
    assert.match(prompt, /export const app/);
  } finally {
    await server.close();
  }
});

test("language auto-detect follows the repository history", async () => {
  const server = await startFakeServer(() => planReply({ commits: [{ type: "feat", subject: "新增功能" }] }));
  const repo = makeRepo();
  try {
    repo.git("commit", "-q", "--allow-empty", "-m", "feat: 新增登录页");
    repo.git("commit", "-q", "--allow-empty", "-m", "fix: 修复崩溃问题");
    repo.write("zh.txt", "中文内容\n");
    const result = await runCli(
      ["--dry-run", "--yes", "--lang", "auto", "--base-url", server.baseUrl, "--model", "fake-1", "--api-key", "k"],
      { cwd: repo.path },
    );
    assert.equal(result.status, 0, result.stderr);
    const system = String((server.requests[0]?.body.messages as { content: string }[])[0]?.content);
    assert.match(system, /简体中文/);
    assert.match(result.stdout, /feat: 新增功能/);
  } finally {
    await server.close();
  }
});

test("--split refuses to split files that have unstaged edits on top of staged ones", async () => {
  const server = await startFakeServer(() =>
    planReply({
      commits: [
        { type: "feat", subject: "add a", files: ["a.txt"] },
        { type: "feat", subject: "add b", files: ["b.txt"] },
      ],
    }),
  );
  const repo = makeRepo();
  try {
    repo.write("a.txt", "staged a\n");
    repo.write("b.txt", "staged b\n");
    repo.git("add", "a.txt", "b.txt");
    repo.write("a.txt", "later edit\n");

    const result = await runCli(
      ["--staged", "--split", "--yes", "--base-url", server.baseUrl, ...MODEL_FLAGS],
      { cwd: repo.path },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Cannot split/);
    assert.equal(repo.commitCount(), 2);
    assert.equal(repo.git("show", "HEAD:a.txt"), "staged a");
    assert.equal(readFileSync(join(repo.path, "a.txt"), "utf8"), "later edit\n");
    assert.equal(repo.status(), "M a.txt");
  } finally {
    await server.close();
  }
});

test("non-ASCII and space-containing paths survive the whole pipeline", async () => {
  const server = await startFakeServer(() =>
    planReply({ commits: [{ type: "docs", subject: "更新中文文档" }] }),
  );
  const repo = makeRepo();
  try {
    repo.write("文档.md", "旧内容\n");
    repo.write("my notes.txt", "old\n");
    repo.git("add", ".");
    repo.git("commit", "-q", "-m", "chore: track files");
    repo.write("文档.md", "新内容\n");
    repo.write("my notes.txt", "new\n");

    const dry = await runCli(
      ["--dry-run", "--yes", "--base-url", server.baseUrl, "--model", "fake-1", "--api-key", "k", "--lang", "zh"],
      { cwd: repo.path },
    );
    assert.equal(dry.status, 0, dry.stderr);
    const prompt = (server.requests[0]?.body.messages as { content: string }[])[1]?.content ?? "";
    assert.match(prompt, /文档\.md/);
    assert.match(prompt, /my notes\.txt/);
    assert.doesNotMatch(prompt, /\\346\\226\\207/);

    const real = await runCli(
      ["--yes", "--base-url", server.baseUrl, "--model", "fake-1", "--api-key", "k", "--lang", "zh"],
      { cwd: repo.path },
    );
    assert.equal(real.status, 0, real.stderr);
    assert.equal(repo.subjects().at(-1), "docs: 更新中文文档");
    assert.equal(repo.status(), "");
  } finally {
    await server.close();
  }
});

test("a non-interactive run without --yes refuses to commit", async () => {
  const server = await startFakeServer(() => planReply({ commits: [{ type: "feat", subject: "never" }] }));
  const repo = makeRepo();
  try {
    repo.write("x.txt", "x\n");
    const result = await runCli(["--base-url", server.baseUrl, ...MODEL_FLAGS], { cwd: repo.path });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Aborted/);
    assert.equal(repo.commitCount(), 1);
    assert.equal(repo.status(), "?? x.txt");
  } finally {
    await server.close();
  }
});

test("the default language is English, even when history is Chinese", async () => {
  const server = await startFakeServer(() => planReply({ commits: [{ type: "feat", subject: "add English subject" }] }));
  const repo = makeRepo();
  try {
    repo.git("commit", "-q", "--allow-empty", "-m", "feat: 新增登录页");
    repo.git("commit", "-q", "--allow-empty", "-m", "fix: 修复崩溃问题");
    repo.write("a.txt", "hello\n");
    const result = await runCli(["--dry-run", "--yes", "--base-url", server.baseUrl, "--model", "fake-1", "--api-key", "k"], {
      cwd: repo.path,
    });
    assert.equal(result.status, 0, result.stderr);
    const system = String((server.requests[0]?.body.messages as { content: string }[])[0]?.content);
    assert.match(system, /in English/);
    assert.doesNotMatch(system, /简体中文/);
  } finally {
    await server.close();
  }
});

test("already-staged deletions do not break staging or split commits", async () => {
  const server = await startFakeServer(() =>
    planReply({
      commits: [
        { type: "refactor", subject: "drop the placeholder binary", files: ["src/main.rs"] },
        { type: "feat", subject: "add util", files: ["util.txt"] },
      ],
    }),
  );
  const repo = makeRepo();
  try {
    repo.write("src/main.rs", "fn main() {}\n");
    repo.git("add", ".");
    repo.git("commit", "-q", "-m", "chore: add placeholder");
    repo.git("rm", "-q", "src/main.rs");
    repo.write("util.txt", "util\n");

    const result = await runCli(
      ["--split", "--yes", "--base-url", server.baseUrl, ...MODEL_FLAGS],
      { cwd: repo.path },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(repo.subjects().slice(-2), [
      "refactor: drop the placeholder binary",
      "feat: add util",
    ]);
    assert.equal(repo.status(), "");
    assert.deepEqual(repo.filesIn(repo.git("rev-parse", "HEAD~1")), ["src/main.rs"]);
  } finally {
    await server.close();
  }
});

test("plain deletion staging works without --split too", async () => {
  const server = await startFakeServer(() =>
    planReply({ commits: [{ type: "chore", subject: "remove old file" }] }),
  );
  const repo = makeRepo();
  try {
    repo.write("old.txt", "gone\n");
    repo.git("add", "old.txt");
    repo.git("commit", "-q", "-m", "chore: add old file");
    repo.git("rm", "-q", "old.txt");

    const result = await runCli(["--yes", "--base-url", server.baseUrl, ...MODEL_FLAGS], {
      cwd: repo.path,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(repo.subjects().at(-1), "chore: remove old file");
    assert.equal(repo.status(), "");
  } finally {
    await server.close();
  }
});

test("--select --split commits only the chosen batches and leaves the rest untouched", async () => {
  const server = await startFakeServer(() =>
    planReply({
      commits: [
        { type: "feat", subject: "add a", files: ["src/a.ts"] },
        { type: "docs", subject: "write readme", files: ["README.md"] },
      ],
    }),
  );
  const repo = makeRepo();
  try {
    repo.write("src/a.ts", "export const a = 1;\n");
    repo.write("README.md", "# demo\n");
    repo.write("scratch.md", "wip\n");

    const result = await runCli(
      ["--select", "--split", "--yes", "--base-url", server.baseUrl, ...MODEL_FLAGS],
      { cwd: repo.path },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(repo.subjects().slice(-2), ["feat: add a", "docs: write readme"]);
    assert.equal(repo.status(), "?? scratch.md");
    assert.match(result.stdout, /Left uncommitted 1 file\(s\): scratch\.md/);

    const prompt = String((server.requests[0]?.body.messages as { content: string }[])[0]?.content);
    assert.match(prompt, /Omit files/);
  } finally {
    await server.close();
  }
});

test("--select alone picks one file and reports the rest as uncommitted (JSON)", async () => {
  const server = await startFakeServer(() =>
    planReply({ commits: [{ type: "feat", subject: "add a", files: ["a.txt"] }] }),
  );
  const repo = makeRepo();
  try {
    repo.write("a.txt", "a\n");
    repo.write("b.txt", "b\n");

    const result = await runCli(
      ["--select", "--dry-run", "--json", "--yes", "--base-url", server.baseUrl, ...MODEL_FLAGS],
      { cwd: repo.path },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      plan: { files: string[] }[];
      uncommitted: string[];
      skippedReason: string;
    };
    assert.deepEqual(payload.plan[0]?.files, ["a.txt"]);
    assert.deepEqual(payload.uncommitted, ["b.txt"]);
    assert.equal(payload.skippedReason, "dry-run");
    assert.equal(repo.commitCount(), 1);
  } finally {
    await server.close();
  }
});

test("--select never sweeps up files that were already staged", async () => {
  const server = await startFakeServer(() =>
    planReply({ commits: [{ type: "feat", subject: "add other", files: ["other.txt"] }] }),
  );
  const repo = makeRepo();
  try {
    repo.write("keep.txt", "v1\n");
    repo.git("add", "keep.txt");
    repo.git("commit", "-q", "-m", "chore: keep");
    repo.write("keep.txt", "v2\n");
    repo.git("add", "keep.txt");
    repo.write("other.txt", "other\n");

    const result = await runCli(
      ["--select", "--yes", "--base-url", server.baseUrl, ...MODEL_FLAGS],
      { cwd: repo.path },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(repo.subjects().at(-1), "feat: add other");
    assert.deepEqual(repo.filesIn("HEAD"), ["other.txt"]);
    assert.equal(repo.status(), "M  keep.txt");
    assert.equal(repo.git("show", ":keep.txt"), "v2");
  } finally {
    await server.close();
  }
});
