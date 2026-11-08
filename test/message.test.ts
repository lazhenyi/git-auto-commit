import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFallbackPlan,
  coerceRawCommits,
  extractJson,
  formatMessage,
  inferLanguage,
  inferTypeFromPath,
  normalizePlan,
  validateMessage,
} from "../src/message.ts";
import type { FileChange } from "../src/types.ts";

const files = ["src/a.ts", "src/b.ts", "README.md"];

function change(path: string, status: FileChange["status"] = "modified"): FileChange {
  return {
    path,
    status,
    insertions: 1,
    deletions: 0,
    binary: false,
    excluded: false,
  };
}

test("extractJson accepts bare, fenced and prose-wrapped JSON", () => {
  assert.deepEqual(extractJson('{"commits":[]}'), { commits: [] });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! Here you go:\n{"a":1}\nHope that helps.'), { a: 1 });
  assert.deepEqual(extractJson('[{"a":1}]'), [{ a: 1 }]);
  assert.throws(() => extractJson("no json here"), /valid JSON/);
});

test("coerceRawCommits understands the shapes models emit", () => {
  assert.equal(coerceRawCommits([{ subject: "x" }]).length, 1);
  assert.equal(coerceRawCommits({ commits: [{ subject: "x" }] }).length, 1);
  assert.equal(coerceRawCommits({ message: "feat: x" }).length, 1);
  assert.equal(coerceRawCommits("feat: x").length, 1);
  assert.equal(coerceRawCommits({ nope: true }).length, 0);
});

test("single-commit mode covers every file and ignores model grouping", () => {
  const plan = normalizePlan(
    { commits: [{ type: "feat", scope: "Api", subject: "add retries.", files: ["src/a.ts"] }] },
    { files, split: false },
  );
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0]?.files, files);
  assert.equal(plan[0]?.type, "feat");
  assert.equal(plan[0]?.scope, "api");
  assert.equal(plan[0]?.subject, "add retries");
});

test("split mode dedupes files and appends leftovers to the last commit", () => {
  const plan = normalizePlan(
    {
      commits: [
        { type: "feat", subject: "add a", files: ["src/a.ts", "src/a.ts"] },
        { type: "docs", subject: "document", files: ["README.md", "src/nope.ts"] },
      ],
    },
    { files, split: true },
  );
  assert.equal(plan.length, 2);
  assert.deepEqual(plan[0]?.files, ["src/a.ts"]);
  assert.deepEqual(plan[1]?.files, ["README.md", "src/b.ts"]);
});

test("split mode drops empty groups and creates a commit when nothing is covered", () => {
  const plan = normalizePlan(
    { commits: [{ type: "chore", subject: "unknown", files: ["nope"] }] },
    { files, split: true },
  );
  assert.equal(plan.length, 1);
  assert.equal(plan[0]?.subject, "update 3 files");
  assert.equal(plan[0]?.type, "chore");
  assert.deepEqual(plan[0]?.files, files);
});

test("message headers are parsed from a full message field", () => {
  const plan = normalizePlan(
    {
      commits: [
        {
          message: "feat(api)!: drop legacy endpoint\n\nBREAKING CHANGE: clients must migrate",
        },
      ],
    },
    { files, split: false },
  );
  assert.equal(plan[0]?.type, "feat");
  assert.equal(plan[0]?.scope, "api");
  assert.equal(plan[0]?.subject, "drop legacy endpoint");
  assert.equal(plan[0]?.breaking, true);
  assert.match(plan[0]?.body ?? "", /BREAKING CHANGE/);
});

test("unknown types fall back to chore and aliases are normalized", () => {
  const plan = normalizePlan(
    { commits: [{ type: "feature", subject: "x" }, { type: "bugfix", subject: "y" }, { subject: "z" }] },
    { files, split: false },
  );
  assert.equal(plan[0]?.type, "feat");

  const alias = normalizePlan({ message: "feature: add thing" }, { files, split: false });
  assert.equal(alias[0]?.type, "feat");
  assert.equal(alias[0]?.subject, "add thing");

  const unknown = normalizePlan({ message: "wibble: do a thing" }, { files, split: false });
  assert.equal(unknown[0]?.type, "chore");
  assert.equal(unknown[0]?.subject, "do a thing");
});

test("forced type, scope and plain style are respected", () => {
  const plan = normalizePlan(
    { message: "fix(ui): repair" },
    { files, split: false, forceType: "perf", forceScope: "render", typeStyle: "plain" },
  );
  assert.equal(plan[0]?.type, "perf");
  assert.equal(plan[0]?.scope, "render");

  const message = formatMessage(plan[0]!, { typeStyle: "plain" });
  assert.equal(message.subject, "repair");
});

test("formatMessage builds a conventional header with optional emoji", () => {
  const message = formatMessage(
    { type: "feat", scope: "api", subject: "add login", breaking: false, files: [] },
    { emoji: true },
  );
  assert.equal(message.subject, "✨ feat(api): add login");

  const breaking = formatMessage(
    { type: "feat", subject: "drop v1", breaking: true, files: [] },
  );
  assert.equal(breaking.subject, "feat!: drop v1");
});

test("validateMessage flags linter-hostile subjects", () => {
  assert.deepEqual(validateMessage({ subject: "feat: add thing" }), []);
  assert.match(validateMessage({ subject: "feat: add thing." }).join(), /period/);
  assert.match(validateMessage({ subject: "feat: " }).join(), /no description/);
  assert.match(
    validateMessage({ subject: `feat: ${"x".repeat(80)}` }).join(),
    /max 72/,
  );
  assert.match(
    validateMessage({ subject: "feat: x", body: "y".repeat(120) }).join(),
    /longer than 100/,
  );
});

test("long subjects are cut at a word boundary", () => {
  const plan = normalizePlan(
    { message: `feat: ${"word ".repeat(30)}` },
    { files, split: false },
  );
  const subject = plan[0]?.subject ?? "";
  assert.ok(subject.length <= 72);
  assert.ok(!subject.endsWith("wor"));
});

test("language detection follows the recent history", () => {
  assert.equal(inferLanguage(["feat: add login", "fix: crash"]), "en");
  assert.equal(inferLanguage(["feat: 新增登录", "fix: 修复崩溃", "docs: 更新文档"]), "zh");
  assert.equal(inferLanguage(["feat: ログイン追加", "fix: クラッシュ修正"]), "ja");
  assert.equal(inferLanguage(["feat: 로그인 추가", "fix: 충돌 수정"]), "ko");
  assert.equal(inferLanguage([]), "en");
});

test("fallback plan is heuristic but complete", () => {
  const plan = buildFallbackPlan([change("docs/guide.md"), change("src/a.ts")]);
  assert.equal(plan.length, 1);
  assert.equal(plan[0]?.type, "docs");
  assert.deepEqual(plan[0]?.files, ["docs/guide.md", "src/a.ts"]);
  assert.match(plan[0]?.body ?? "", /- src\/a\.ts/);
  assert.deepEqual(buildFallbackPlan([]), []);
});

test("inferTypeFromPath picks a sensible type", () => {
  assert.equal(inferTypeFromPath("README.md"), "docs");
  assert.equal(inferTypeFromPath("src/a.test.ts"), "test");
  assert.equal(inferTypeFromPath(".github/workflows/ci.yml"), "ci");
  assert.equal(inferTypeFromPath("package.json"), "build");
  assert.equal(inferTypeFromPath("src/theme.scss"), "style");
  assert.equal(inferTypeFromPath("src/index.ts"), "chore");
});

test("long body lines are reflowed so linters accept the message", () => {
  const long = "word ".repeat(30).trim();
  const plan = normalizePlan(
    {
      commits: [
        {
          type: "feat",
          subject: "explain the change",
          body: `Intro ${long}\n\n- ${long}\n\n    ${"code(); ".repeat(20)}`,
        },
      ],
    },
    { files, split: false },
  );

  const body = plan[0]?.body ?? "";
  for (const line of body.split("\n")) {
    if (line.startsWith("    ")) continue; // indented code is preserved verbatim
    assert.ok(line.length <= 100, `line too long: ${line.length} (${line})`);
  }
  assert.match(body, /\n- word/);
  assert.match(body, /\n {2}word/); // hanging indent for the list item
  assert.deepEqual(validateMessage(formatMessage(plan[0]!)), []);
});

test("body lines that are already short are left untouched", () => {
  const plan = normalizePlan(
    { commits: [{ type: "feat", subject: "x", body: "Short line.\n\nAnother one." }] },
    { files, split: false },
  );
  assert.equal(plan[0]?.body, "Short line.\n\nAnother one.");
});

test("--select keeps only the files the model picked", () => {
  const plan = normalizePlan(
    { commits: [{ type: "feat", subject: "add a", files: ["src/a.ts"] }] },
    { files, split: false, select: true },
  );
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0]?.files, ["src/a.ts"]);
});

test("--select without any picked file is an error instead of committing everything", () => {
  assert.throws(
    () => normalizePlan({ commits: [{ type: "feat", subject: "x" }] }, { files, split: false, select: true }),
    /did not select any file/,
  );
  assert.throws(
    () => normalizePlan({ commits: [{ type: "feat", subject: "x", files: ["nope"] }] }, { files, split: true, select: true }),
    /did not select any file/,
  );
});

test("--select --split leaves leftovers uncommitted and dedupes files", () => {
  const plan = normalizePlan(
    {
      commits: [
        { type: "feat", subject: "add a", files: ["src/a.ts", "src/a.ts"] },
        { type: "docs", subject: "doc b", files: ["README.md"] },
        { type: "chore", subject: "nope", files: ["src/unknown.ts"] },
      ],
    },
    { files, split: true, select: true },
  );
  assert.deepEqual(plan.map((item) => item.files), [["src/a.ts"], ["README.md"]]);
});
