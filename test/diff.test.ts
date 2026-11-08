import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  globToRegExp,
  isExcluded,
  splitDiffSegments,
  synthesizeUntrackedSegment,
  truncateSegments,
} from "../src/diff.ts";
import { parseNumstat, parseStatusZ } from "../src/git.ts";

test("globToRegExp handles *, **, ? and braces", () => {
  assert.ok(globToRegExp("*.lock").test("pnpm.lock"));
  assert.ok(!globToRegExp("*.lock").test("dir/pnpm.lock"));
  assert.ok(globToRegExp("dist/**").test("dist/a/b.js"));
  assert.ok(globToRegExp("src/?.ts").test("src/a.ts"));
  assert.ok(globToRegExp("*.{js,ts}").test("a.ts"));
  assert.ok(!globToRegExp("*.{js,ts}").test("a.css"));
});

test("isExcluded matches basenames for bare patterns and paths otherwise", () => {
  assert.ok(isExcluded("package-lock.json", ["package-lock.json"]));
  assert.ok(isExcluded("web/package-lock.json", ["package-lock.json"]));
  assert.ok(isExcluded("dist/app.js", ["dist/**"]));
  assert.ok(!isExcluded("src/app.js", ["dist/**"]));
  assert.ok(!isExcluded("src/app.ts", ["*.lock"]));
});

const rawDiff = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-const a = 1;",
  "+const a = 2;",
  "diff --git a/README.md b/README.md",
  "index 333..444 100644",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

test("splitDiffSegments returns one segment per file", () => {
  const segments = splitDiffSegments(rawDiff);
  assert.equal(segments.length, 2);
  assert.equal(segments[0]?.path, "src/a.ts");
  assert.equal(segments[1]?.path, "README.md");
  assert.ok(segments[0]?.text.startsWith("diff --git a/src/a.ts"));
  assert.ok(!segments[0]?.text.endsWith("\n"));
});

test("truncateSegments keeps everything when it fits", () => {
  const segments = splitDiffSegments(rawDiff);
  const result = truncateSegments(segments, { budget: 10_000 });
  assert.equal(result.truncated, false);
  assert.deepEqual(result.truncatedFiles, []);
  assert.match(result.text, /const a = 2/);
  assert.match(result.text, /\+new/);
});

test("truncateSegments cuts a large segment in half", () => {
  const segments = [
    { path: "a", text: "a".repeat(500) },
    { path: "b", text: "b".repeat(1500) },
    { path: "c", text: "c".repeat(500) },
  ];
  const result = truncateSegments(segments, { budget: 1102 });
  assert.equal(result.truncated, true);
  assert.deepEqual(result.truncatedFiles, ["b", "c"]);
  assert.match(result.text, /diff for b truncated/);
  assert.match(result.text, /shortened/);
});

test("truncateSegments drops remainders that are too small to be useful", () => {
  const segments = [
    { path: "a", text: "a".repeat(500) },
    { path: "c", text: "c".repeat(500) },
  ];
  const result = truncateSegments(segments, { budget: 700 });
  assert.equal(result.truncated, true);
  assert.deepEqual(result.truncatedFiles, ["c"]);
  assert.ok(!result.text.includes("ccc"));
  assert.match(result.text, /token budget/);
});

test("parseStatusZ understands modifications, untracked files and renames", () => {
  const entries = parseStatusZ(" M src/a.ts\0?? new file.ts\0R  src/new.ts\0src/old.ts\0");
  assert.deepEqual(entries, [
    { index: " ", worktree: "M", path: "src/a.ts" },
    { index: "?", worktree: "?", path: "new file.ts" },
    { index: "R", worktree: " ", path: "src/new.ts", from: "src/old.ts" },
  ]);
});

test("parseNumstat reads counts and marks binary files", () => {
  const entries = parseNumstat("10\t2\tsrc/a.ts\n-\t-\tlogo.png\n");
  assert.deepEqual(entries[0], {
    path: "src/a.ts",
    insertions: 10,
    deletions: 2,
    binary: false,
  });
  assert.equal(entries[1]?.binary, true);
});

test("untracked files become readable patches", async () => {
  const root = mkdtempSync(join(tmpdir(), "gac-diff-"));
  writeFileSync(join(root, "hello.txt"), "one\ntwo\n", "utf8");
  const segment = await synthesizeUntrackedSegment(root, {
    path: "hello.txt",
    status: "untracked",
    insertions: 0,
    deletions: 0,
    binary: false,
    excluded: false,
  });
  assert.ok(segment);
  assert.equal(segment?.untracked, true);
  assert.match(segment?.text ?? "", /^\+\+\+ b\/hello\.txt/m);
  assert.match(segment?.text ?? "", /^\+one$/m);

  writeFileSync(join(root, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  const binary = await synthesizeUntrackedSegment(root, {
    path: "image.png",
    status: "untracked",
    insertions: 0,
    deletions: 0,
    binary: false,
    excluded: false,
  });
  assert.match(binary?.text ?? "", /binary/);
});

test("untracked files larger than the per-file cap are truncated", async () => {
  const root = mkdtempSync(join(tmpdir(), "gac-diff-"));
  const lines = Array.from({ length: 4000 }, (_, index) => `line ${index}`).join("\n");
  writeFileSync(join(root, "big.txt"), lines, "utf8");
  const segment = await synthesizeUntrackedSegment(root, {
    path: "big.txt",
    status: "untracked",
    insertions: 0,
    deletions: 0,
    binary: false,
    excluded: false,
  });
  assert.ok((segment?.text.length ?? 0) < 13_500);
  assert.match(segment?.text ?? "", /truncated/);
});

test("untracked symlinks are shown as links, not as their target contents", async () => {
  const root = mkdtempSync(join(tmpdir(), "gac-diff-"));
  writeFileSync(join(root, "target.txt"), "secret contents\n", "utf8");
  symlinkSync("target.txt", join(root, "link.txt"));

  const segment = await synthesizeUntrackedSegment(root, {
    path: "link.txt",
    status: "untracked",
    insertions: 0,
    deletions: 0,
    binary: false,
    excluded: false,
  });
  assert.match(segment?.text ?? "", /new file mode 120000/);
  assert.match(segment?.text ?? "", /^\+target\.txt$/m);
  assert.doesNotMatch(segment?.text ?? "", /secret contents/);
});
