import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitFlagArgs, opencodePluginSource, parseHookPayload, shellQuote } from "../src/hook.ts";
import { makeRepo, planReply, runCli, startFakeServer } from "./helpers.ts";

const MODEL_FLAGS = ["--model", "fake-1", "--api-key", "test-key", "--lang", "en"];

test("hook payloads are parsed leniently", () => {
  assert.deepEqual(parseHookPayload('{"cwd":"/repo","stop_hook_active":false}'), {
    cwd: "/repo",
    stop_hook_active: false,
  });
  assert.equal(parseHookPayload("  ") || undefined, undefined);
  assert.equal(parseHookPayload("not json"), undefined);
  assert.deepEqual(parseHookPayload('prefix {"cwd":"/x"} suffix'), { cwd: "/x" });
});

test("commit flags are serialized for the generated hook command", () => {
  assert.deepEqual(
    commitFlagArgs({ split: true, select: true, language: "zh", maxDiffChars: 9000 }),
    ["--split", "--select", "--lang", "zh", "--max-diff-chars", "9000"],
  );
  assert.deepEqual(commitFlagArgs({}), []);
  assert.equal(shellQuote("/home/me/bin/gac"), "/home/me/bin/gac");
  assert.equal(shellQuote("/home/me/my bin/gac"), '"/home/me/my bin/gac"');
});

test("the OpenCode plugin embeds the binary and listens for session.idle", () => {
  const source = opencodePluginSource("/opt/gac", ["hook", "run", "--agent", "opencode", "--split"]);
  assert.match(source, /const GAC_BIN = "\/opt\/gac"/);
  assert.match(source, /"session\.idle"/);
  assert.match(source, /"--split"/);
  assert.match(source, /export default plugin/);
});

test("hook run commits silently and writes a log", async () => {
  const server = await startFakeServer(() =>
    planReply({ commits: [{ type: "feat", subject: "add hooked change" }] }),
  );
  const repo = makeRepo();
  try {
    repo.write("hooked.txt", "hook\n");
    const payload = JSON.stringify({
      cwd: repo.path,
      hook_event_name: "Stop",
      stop_hook_active: false,
    });
    const result = await runCli(
      ["hook", "run", "--agent", "claude", "--base-url", server.baseUrl, ...MODEL_FLAGS],
      { cwd: repo.path, input: payload },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(repo.subjects().at(-1), "feat: add hooked change");

    const log = readFileSync(join(repo.path, ".git", "gac-hook.log"), "utf8");
    assert.match(log, /\[claude\] committed 1: .* feat: add hooked change/);
  } finally {
    await server.close();
  }
});

test("hook run skips when stop_hook_active is set", async () => {
  const server = await startFakeServer(() => planReply({ commits: [{ type: "feat", subject: "never" }] }));
  const repo = makeRepo();
  try {
    repo.write("x.txt", "x\n");
    const result = await runCli(
      ["hook", "run", "--agent", "claude", "--base-url", server.baseUrl, ...MODEL_FLAGS],
      {
        cwd: repo.path,
        input: JSON.stringify({ cwd: repo.path, stop_hook_active: true }),
      },
    );
    assert.equal(result.status, 0);
    assert.equal(repo.commitCount(), 1);
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test("hook run does not call the model when nothing changed", async () => {
  const server = await startFakeServer(() => planReply({ commits: [{ type: "feat", subject: "nope" }] }));
  const repo = makeRepo();
  try {
    const result = await runCli(
      ["hook", "run", "--agent", "codex", "--base-url", server.baseUrl, ...MODEL_FLAGS],
      { cwd: repo.path, input: JSON.stringify({ cwd: repo.path }) },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(server.requests.length, 0);
    assert.match(readFileSync(join(repo.path, ".git", "gac-hook.log"), "utf8"), /skipped: no-changes/);
  } finally {
    await server.close();
  }
});

test("hook run skips merges, rebases and concurrent runs", async () => {
  const server = await startFakeServer(() => planReply({ commits: [{ type: "feat", subject: "never" }] }));
  const repo = makeRepo();
  try {
    repo.write("x.txt", "x\n");
    writeFileSync(join(repo.path, ".git", "MERGE_HEAD"), "deadbeef\n");

    const merging = await runCli(
      ["hook", "run", "--agent", "claude", "--base-url", server.baseUrl, ...MODEL_FLAGS],
      { cwd: repo.path },
    );
    assert.equal(merging.status, 0);
    assert.match(readFileSync(join(repo.path, ".git", "gac-hook.log"), "utf8"), /merge in progress/);

    // Rebase marker instead.
    const rebase = runCli(
      ["hook", "run", "--agent", "claude", "--base-url", server.baseUrl, ...MODEL_FLAGS],
      { cwd: repo.path },
    );
    mkdirSync(join(repo.path, ".git", "rebase-apply"), { recursive: true });
    assert.equal((await rebase).status, 0);

    // Lock held by someone else.
    mkdirSync(join(repo.path, ".git", "gac-hook.lock"), { recursive: true });
    const locked = await runCli(
      ["hook", "run", "--agent", "claude", "--base-url", server.baseUrl, ...MODEL_FLAGS],
      { cwd: repo.path },
    );
    assert.equal(locked.status, 0);
    assert.equal(server.requests.length, 0);
    assert.equal(repo.commitCount(), 1);
  } finally {
    await server.close();
  }
});

test("a failing hook exits 0 so it never breaks the agent turn", async () => {
  const server = await startFakeServer(() => ({ status: 500, raw: "boom" }));
  const repo = makeRepo();
  try {
    repo.write("x.txt", "x\n");
    const result = await runCli(
      ["hook", "run", "--agent", "codex", "--base-url", server.baseUrl, ...MODEL_FLAGS],
      { cwd: repo.path, env: { GAC_RETRY_DELAY_MS: "1" } },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(readFileSync(join(repo.path, ".git", "gac-hook.log"), "utf8"), /failed:/);
    assert.equal(repo.commitCount(), 1);
  } finally {
    await server.close();
  }
});

test("hook install merges into Claude and Codex hook files idempotently", async () => {
  const home = mkdtempSync(join(tmpdir(), "gac-hook-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ cleanupPeriodDays: 30, hooks: { Stop: [{ hooks: [{ type: "command", command: "echo other" }] }] } }),
    "utf8",
  );
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GAC_BIN: "/opt/gac test/bin/gac",
  };

  const repo = makeRepo();
  const install = await runCli(["hook", "install", "--agent", "claude", "--split"], {
    cwd: repo.path,
    env,
  });
  assert.equal(install.status, 0, install.stderr);

  const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as {
    cleanupPeriodDays: number;
    hooks: { Stop: { hooks: { command: string; timeout?: number }[] }[] };
  };
  assert.equal(settings.cleanupPeriodDays, 30);
  const stopCommands = settings.hooks.Stop.flatMap((group) => group.hooks.map((hook) => hook.command));
  assert.ok(stopCommands.includes("echo other"));
  const ours = stopCommands.filter((command) => command.includes("hook run --agent claude"));
  assert.equal(ours.length, 1);
  assert.match(ours[0] ?? "", /"\/opt\/gac test\/bin\/gac" hook run --agent claude --split/);
  assert.equal(settings.hooks.Stop.at(-1)?.hooks[0]?.timeout, 120);

  // Reinstall must replace, not duplicate.
  const again = await runCli(["hook", "install", "--agent", "claude", "--select"], { cwd: repo.path, env });
  assert.equal(again.status, 0, again.stderr);
  const second = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as {
    hooks: { Stop: { hooks: { command: string }[] }[] };
  };
  const secondCommands = second.hooks.Stop.flatMap((group) => group.hooks.map((hook) => hook.command));
  assert.equal(secondCommands.filter((command) => command.includes("hook run --agent claude")).length, 1);
  assert.match(secondCommands.join("\n"), /--select/);

  // Codex and OpenCode.
  const installRest = await runCli(["hook", "install", "--agent", "codex"], { cwd: repo.path, env });
  assert.equal(installRest.status, 0, installRest.stderr);
  const codex = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8")) as {
    hooks: { Stop: { hooks: { command: string }[] }[] };
  };
  assert.match(codex.hooks.Stop[0]?.hooks[0]?.command ?? "", /hook run --agent codex/);

  const installOc = await runCli(["hook", "install", "--agent", "opencode"], { cwd: repo.path, env });
  assert.equal(installOc.status, 0, installOc.stderr);
  const plugin = join(home, ".config", "opencode", "plugins", "gac-auto-commit.ts");
  assert.ok(existsSync(plugin));
  assert.match(readFileSync(plugin, "utf8"), /session\.idle/);

  const status = await runCli(["hook", "status"], { cwd: repo.path, env });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /claude\s+✔ installed/);
  assert.match(status.stdout, /opencode\s+✔ installed/);

  const uninstall = await runCli(["hook", "uninstall", "--agent", "all"], { cwd: repo.path, env });
  assert.equal(uninstall.status, 0, uninstall.stderr);
  const after = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as {
    hooks: { Stop: { hooks: { command: string }[] }[] };
  };
  const afterCommands = after.hooks.Stop.flatMap((group) => group.hooks.map((hook) => hook.command));
  assert.deepEqual(afterCommands, ["echo other"]);
  assert.ok(!existsSync(plugin));
});

test("hook install --project writes into the repository", async () => {
  const repo = makeRepo();
  const result = await runCli(["hook", "install", "--agent", "claude", "--project"], {
    cwd: repo.path,
    env: { GAC_BIN: "/opt/gac" },
  });
  assert.equal(result.status, 0, result.stderr);
  const file = join(repo.path, ".claude", "settings.json");
  assert.ok(existsSync(file));
  assert.match(readFileSync(file, "utf8"), /hook run --agent claude/);
});
