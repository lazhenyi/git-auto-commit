import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeRepo, planReply, runCli, startFakeServer } from "./helpers.ts";

const ROOT = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };

const bun = spawnSync("bun", ["--version"], { encoding: "utf8" });
const hasBun = !bun.error && bun.status === 0;

test(
  "the compiled executable reports its build version and commits",
  { skip: hasBun ? false : "bun is not installed, skipping standalone binary test", timeout: 240_000 },
  async () => {
    const outdir = mkdtempSync(join(tmpdir(), "gac-bin-"));
    const binary = join(outdir, process.platform === "win32" ? "gac.exe" : "gac");

    const build = spawnSync(
      "bun",
      [
        "build",
        join(ROOT, "src", "cli.ts"),
        "--compile",
        "--outfile",
        binary,
        "--define",
        `__GAC_VERSION__=${JSON.stringify(pkg.version)}`,
      ],
      { cwd: ROOT, encoding: "utf8", timeout: 180_000 },
    );
    assert.equal(build.status, 0, build.stderr);

    const version = await runCli(["--version"], { cwd: outdir, entry: binary });
    assert.equal(version.stdout.trim(), pkg.version);
    assert.equal(version.status, 0);

    const help = await runCli(["--help"], { cwd: outdir, entry: binary });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /AI-powered git commits/);

    const server = await startFakeServer(() =>
      planReply({ commits: [{ type: "feat", subject: "ship the binary" }] }),
    );
    const repo = makeRepo();
    try {
      repo.write("bin.txt", "compiled\n");
      const result = await runCli(
        [
          "--yes",
          "--base-url",
          server.baseUrl,
          "--model",
          "fake-1",
          "--api-key",
          "k",
          "--lang",
          "en",
        ],
        { cwd: repo.path, entry: binary },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(repo.subjects().at(-1), "feat: ship the binary");
      assert.equal(repo.status(), "");
    } finally {
      await server.close();
    }
  },
);
