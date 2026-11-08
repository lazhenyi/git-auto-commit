import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localDate, readTemplateFile, renderTemplate, resolveTemplatePath, validateTemplate } from "../src/template.ts";
import { formatMessage, validateMessage } from "../src/message.ts";
import type { CommitPlanItem } from "../src/types.ts";

const base = {
  type: "feat",
  scope: "api",
  scopeParens: "(api)",
  subject: "add login",
  header: "feat(api): add login",
  body: "Explain why.",
  breaking: "",
  emoji: "",
  author: "Ada Lovelace",
  email: "ada@example.com",
  branch: "main",
  date: "2026-01-02",
};

test("renderTemplate places every placeholder and splits subject from body", () => {
  const message = renderTemplate(
    "{header}\n\n{body}\n\nSigned-off-by: {author} <{email}>\nRefs: {branch} @ {date}",
    base,
  );
  assert.equal(message.subject, "feat(api): add login");
  assert.equal(
    message.body,
    "Explain why.\n\nSigned-off-by: Ada Lovelace <ada@example.com>\nRefs: main @ 2026-01-02",
  );
});

test("empty scopes leave no empty brackets behind", () => {
  const message = renderTemplate("{type}({scope}): {subject}", { ...base, scope: "", scopeParens: "" });
  assert.equal(message.subject, "feat: add login");

  const brackets = renderTemplate("{type}[{scope}] {subject}", { ...base, scope: "" });
  assert.equal(brackets.subject, "feat add login");
});

test("the scopeParens helper renders once and stays empty without a scope", () => {
  assert.equal(renderTemplate("{type}{scopeParens}: {subject}", base).subject, "feat(api): add login");
  assert.equal(
    renderTemplate("{type}{scopeParens}: {subject}", { ...base, scope: "", scopeParens: "" }).subject,
    "feat: add login",
  );
});

test("unknown placeholders and literal braces are preserved", () => {
  const message = renderTemplate("{header} [{ticket}] {bodyEnd}", base);
  assert.equal(message.subject, "feat(api): add login [{ticket}] {bodyEnd}");
});

test("extra blank lines from optional sections are collapsed", () => {
  const message = renderTemplate("{header}\n\n{body}\n\n\n\nSigned-off-by: {author}", {
    ...base,
    body: "",
  });
  assert.equal(message.subject, "feat(api): add login");
  assert.equal(message.body, "Signed-off-by: Ada Lovelace");
});

test("breaking and emoji placeholders render only when relevant", () => {
  assert.equal(renderTemplate("{type}{scopeParens}{breaking}: {subject}", base).subject, "feat(api): add login");
  assert.equal(
    renderTemplate("{type}{scopeParens}{breaking}: {subject}", { ...base, breaking: "!" }).subject,
    "feat(api)!: add login",
  );
  assert.equal(renderTemplate("{emoji}{subject}", { ...base, emoji: "✨ " }).subject, "✨ add login");
  assert.equal(renderTemplate("{emoji}{subject}", base).subject, "add login");
});

test("validateTemplate requires a subject or header placeholder", () => {
  assert.doesNotThrow(() => validateTemplate("{type}: {subject}"));
  assert.doesNotThrow(() => validateTemplate("prefix {header}"));
  assert.throws(() => validateTemplate("   "), /empty/);
  assert.throws(() => validateTemplate("{type}: {body}"), /must contain \{subject\} or \{header\}/);
});

test("formatMessage applies a template and the runtime values", () => {
  const item: CommitPlanItem = {
    type: "feat",
    scope: "api",
    subject: "add login",
    body: "Because.",
    breaking: false,
    files: ["a.ts"],
  };
  const message = formatMessage(item, {
    emoji: true,
    template: "{emoji}{type}{scopeParens}: {subject}\n\n{body}\n\nCo-authored-by: {author} <{email}>",
    templateData: { author: "Ada", email: "ada@example.com", branch: "main", date: "2026-01-02" },
  });
  assert.equal(message.subject, "✨ feat(api): add login");
  assert.equal(message.body, "Because.\n\nCo-authored-by: Ada <ada@example.com>");
});

test("formatMessage still builds the default message without a template", () => {
  const item: CommitPlanItem = { type: "fix", subject: "repair", breaking: true, files: [] };
  assert.deepEqual(formatMessage(item), { subject: "fix!: repair" });
  assert.deepEqual(formatMessage(item, { typeStyle: "plain" }), { subject: "repair" });
});

test("custom templates skip conventional-commit lint checks", () => {
  const message = { subject: "Very long custom subject.".repeat(5), body: "x".repeat(200) };
  assert.ok(validateMessage(message).length > 0);
  assert.deepEqual(validateMessage(message, { customTemplate: true }), []);
  assert.match(validateMessage({ subject: "" }, { customTemplate: true }).join(), /empty/);
});

test("template files are read relative to the repository root", () => {
  const root = mkdtempSync(join(tmpdir(), "gac-tpl-"));
  writeFileSync(join(root, "commit-template.txt"), "{type}: {subject}\r\n", "utf8");
  const loaded = readTemplateFile("commit-template.txt", root);
  assert.equal(loaded.text, "{type}: {subject}");
  assert.equal(loaded.file, join(root, "commit-template.txt"));
  assert.equal(resolveTemplatePath("~/x.txt", root, { HOME: "/home/ada" }), "/home/ada/x.txt");
  assert.throws(() => readTemplateFile("missing.txt", root), /Could not read commit template/);
});

test("localDate returns a YYYY-MM-DD string", () => {
  assert.equal(localDate(new Date(2026, 0, 2)), "2026-01-02");
  assert.match(localDate(), /^\d{4}-\d{2}-\d{2}$/);
});
