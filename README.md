# gac — git auto commit

[![CI](https://github.com/lazhenyi/git-auto-commit/actions/workflows/ci.yml/badge.svg)](https://github.com/lazhenyi/git-auto-commit/actions/workflows/ci.yml)
[![Release](https://github.com/lazhenyi/git-auto-commit/actions/workflows/release.yml/badge.svg)](https://github.com/lazhenyi/git-auto-commit/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

`gac` reads your diff, asks a model for a [Conventional Commit](https://www.conventionalcommits.org/),
and commits for you. It can also split one change into several commits, let the model pick which
files are ready, and run as a turn-end hook for Claude Code, Codex and OpenCode.

```
› Reading changes in /path/to/repo
› Collecting diff for 3 files
› Asking openai/gpt-4o-mini for a commit message

  ✨ feat(api): add retry with backoff to login

  Retry 429/5xx responses twice before surfacing an error. The old code
  failed the whole form submit on a single transient network error.

› Staging changes
› Committing: ✨ feat(api): add retry with backoff to login
✔ 4f2a9c1 ✨ feat(api): add retry with backoff to login
```

## Install

One line (Linux and macOS):

```bash
curl -fsSL https://raw.githubusercontent.com/lazhenyi/git-auto-commit/main/install.sh | sh
```

The script downloads the latest release for your platform, verifies its SHA-256 checksum when
available, installs it to `~/.local/bin/gac`, and prints the next steps. The binary embeds the Bun
runtime, so it needs **neither Node.js nor Bun** at runtime — only `git`.

Customise the install:

```bash
# install a specific version into a custom directory
curl -fsSL https://raw.githubusercontent.com/lazhenyi/git-auto-commit/main/install.sh \
  | sh -s -- --version v0.1.0 --dir /usr/local/bin

# or download the script first
curl -fsSLO https://raw.githubusercontent.com/lazhenyi/git-auto-commit/main/install.sh
sh install.sh --dir "$HOME/bin"
```

| Environment variable | Meaning |
| --- | --- |
| `GAC_INSTALL_DIR` | Install directory (default: `~/.local/bin`; same as `--dir`) |
| `GAC_VERSION` | Release to install, e.g. `v0.1.0` (default: latest) |
| `GAC_REPO` | `owner/repo` override, useful for forks |

### Prebuilt binaries

Every release ships standalone executables:

| Platform | Asset |
| --- | --- |
| Linux x64 | `gac-linux-x64` |
| Linux arm64 | `gac-linux-arm64` |
| macOS Intel | `gac-darwin-x64` |
| macOS Apple Silicon | `gac-darwin-arm64` |
| Windows x64 | `gac-windows-x64.exe` |

Download them from the [releases page](https://github.com/lazhenyi/git-auto-commit/releases).
On Windows, rename the file to `gac.exe`, put it somewhere on `PATH`, and use it from PowerShell.

macOS may quarantine a downloaded binary. If Gatekeeper complains:

```bash
codesign --force --sign - ~/.local/bin/gac
```

### From source

Requires Node.js ≥ 20.11. Building a standalone binary additionally requires
[Bun](https://bun.sh).

```bash
git clone https://github.com/lazhenyi/git-auto-commit.git
cd git-auto-commit
npm ci
npm run build          # dist/ + type declarations
npm run build:bin      # bin/gac, a self-contained executable
npm run build:bin:all  # cross-compile for every supported platform
```

## Quick start

```bash
export GAC_API_KEY=sk-...   # or OPENAI_API_KEY / ANTHROPIC_API_KEY
gac --dry-run               # see what would be committed
gac                         # review, confirm, commit
gac -y                      # skip the confirmation
```

Prefer a `git` subcommand? Install an alias:

```bash
gac alias install           # git config --global alias.auto-commit '!gac'
git auto-commit -y
```

`gac -y` never prompts. In a non-interactive environment (stdin is not a TTY), `gac` aborts unless
`--yes` is given.

## Providers

`gac` talks to any OpenAI-compatible `/chat/completions` endpoint, plus Anthropic's Messages API.
Point `GAC_BASE_URL` at your provider and set `GAC_MODEL`:

| Provider | Configuration |
| --- | --- |
| OpenAI | `GAC_API_KEY=sk-...` (default base URL and model) |
| DeepSeek | `GAC_BASE_URL=https://api.deepseek.com/v1` `GAC_MODEL=deepseek-chat` |
| Moonshot | `GAC_BASE_URL=https://api.moonshot.cn/v1` `GAC_MODEL=moonshot-v1-8k` |
| OpenRouter | `GAC_BASE_URL=https://openrouter.ai/api/v1` `GAC_MODEL=...` |
| Ollama (local) | `GAC_BASE_URL=http://127.0.0.1:11434/v1` `GAC_MODEL=qwen2.5-coder` `GAC_API_KEY=ollama` |
| Anthropic | `--provider anthropic` `ANTHROPIC_API_KEY=sk-ant-...` |
| Self-hosted gateway | `GAC_BASE_URL=http://127.0.0.1:<port>/v1` `GAC_MODEL=<model exposed by the gateway>` |

The provider is detected automatically when the model starts with `claude` or the base URL contains
`anthropic`; otherwise it defaults to `openai`.

## Usage

```text
gac [options]                   Read the diff, ask the model, commit
gac commit [options]            Same as above
gac init [--force]              Write a starter .gac.json in this repository
gac config                      Show the resolved configuration (API key masked)
gac alias install [name]        Alias `git <name>` (default: auto-commit) to gac
gac hook install [options]      Auto-commit after each agent turn
gac hook uninstall [options]    Remove those hooks
gac hook status                 Show which agents have the hook installed
```

| Option | Effect |
| --- | --- |
| `-y, --yes` | Commit without asking |
| `-n, --dry-run` | Print the message, stage and commit nothing |
| `-s, --staged` | Commit only what is already staged (default: the whole work tree) |
| `--split`, `--batches` | Let the model split the change into several commits |
| `--select` | Let the model choose which files to commit now; the rest stays uncommitted |
| `--push` | Push after committing (`-u origin HEAD` when no upstream is set) |
| `--emoji` | Prefix the subject with an emoji, e.g. `✨ feat: ...` |
| `--plain` | Drop the `type(scope):` prefix |
| `--type <type>` / `--scope <scope>` | Force the commit type or scope |
| `--lang <en\|zh\|ja\|ko\|auto>` | Message language, default `en`; `auto` follows recent commits |
| `--max-diff-chars <n>` | Diff budget in characters (default: 48000) |
| `--exclude <glob,...>` | Extra paths whose diff body is omitted |
| `--instructions <text>` | Extra instructions for the model |
| `--fallback` | Build a heuristic message locally if the model call fails |
| `--no-verify` | Skip git hooks |
| `--json` | Machine-readable output on stdout (human logs go to stderr) |
| `--debug` | Show HTTP and retry details |

Run `gac --help` for the full list. During confirmation you can answer `e` to edit the message in
`$EDITOR`.

## Configuration

Precedence: **flags > environment > repository config > user config > defaults**

```bash
gac init                 # write .gac.json in this repository
gac config               # show the resolved configuration (key masked)
gac config --json        # machine-readable
```

Repository config (`.gac.json` or `.git-auto-commit.json`):

```json
{
  "provider": "openai",
  "model": "gpt-4o-mini",
  "language": "en",
  "maxDiffChars": 48000,
  "split": false,
  "select": false,
  "emoji": false,
  "exclude": ["fixtures/**"],
  "instructions": "use module names as scope, never mention ticket numbers"
}
```

User-level defaults live in `~/.config/git-auto-commit/config.json` and accept the same keys.
Keep API keys in environment variables; if a repository config contains `apiKey`, `gac` warns
because the file may be committed.

Environment variables: `GAC_API_KEY`, `GAC_BASE_URL`, `GAC_MODEL`, `GAC_PROVIDER`,
`GAC_LANGUAGE`, `GAC_MAX_DIFF_CHARS`, `GAC_INSTRUCTIONS`, `GAC_EXCLUDE`, `GAC_TEMPERATURE`,
`GAC_MAX_TOKENS`, `GAC_TIMEOUT_MS`, `GAC_SPLIT`, `GAC_SELECT`, `GAC_EMOJI`, `GAC_NO_VERIFY`,
`GAC_FALLBACK`, `GAC_PUSH`, `GAC_DEBUG`, and `GAC_HOOK_DISABLED=1` to pause agent hooks.

## Selective and batched commits

By default one run commits every change. When you want the model to make choices:

```bash
gac --select          # AI picks a coherent set of files, the rest stays uncommitted
gac --select --split  # pick files, then group them into several commits
gac --split           # commit everything, but in several commits
```

`--select` semantics:

- Only the files the model lists are staged and committed; everything else (including untracked
  files) is left untouched.
- Files that were already staged are not swept in; every commit is restricted to its own paths.
- After committing, `gac` prints `Left uncommitted N file(s): ...`; `--json` exposes `uncommitted`.
- If the model selects no file, `gac` fails instead of falling back to "commit everything".

Selection is file-level: `gac` does not split hunks inside a single file.

## Agent hooks

`gac` can run at the end of every agent turn: it reads the diff, commits if there is anything to
commit, and exits silently otherwise.

```bash
gac hook install                    # all three agents, user scope (default)
gac hook install --agent claude     # just one
gac hook install --agent all --select --split   # bake behaviour flags into the hook
gac hook install --agent codex --project        # only this repository
gac hook status
gac hook uninstall --agent all
```

| Agent | User scope | Project scope | Event |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/settings.json` | `.claude/settings.json` | `Stop` |
| Codex | `~/.codex/hooks.json` | `.codex/hooks.json` | `Stop` |
| OpenCode | `~/.config/opencode/plugins/gac-auto-commit.ts` | `.opencode/plugins/gac-auto-commit.ts` | `session.idle` |

Installation merges instead of overwriting: existing hooks stay in place, reinstalling replaces only
`gac`'s entry, and the original file is copied to `.gac.bak`. The generated command uses the absolute
path of the `gac` executable.

Safety rules:

- No changes → no model call, no cost.
- Skipped during merge, rebase, cherry-pick, revert and bisect, and on a detached HEAD.
- `.git/gac-hook.lock` prevents concurrent runs (stale after ten minutes).
- Claude's `stop_hook_active` is respected to avoid recursive hooks.
- Hook runs write nothing to stdout and always exit 0, so a failed commit cannot break the turn.
  Results go to `.git/gac-hook.log`.
- Disable temporarily with `GAC_HOOK_DISABLED=1`.
- Codex needs `[features] hooks = true`; the installer warns when it is missing.

## How it works

1. **Collect** — `git status --porcelain -z` lists the files, `git diff HEAD` collects the patch,
   untracked files and symlinks are turned into `new file` patches. Repositories without a commit
   are diffed against the empty tree.
2. **Budget** — lockfiles, `dist/`, `node_modules/` and similar paths are listed by name without
   their diff body. Beyond `--max-diff-chars`, files are cut and the model is told what was omitted.
3. **Prompt** — the branch, the last ten commit subjects (for style), file stats and the diff are
   sent with a strict JSON-only instruction. With `--split`, every file must belong to exactly one
   commit.
4. **Validate** — JSON is extracted from prose or code fences; type aliases are normalised, subjects
   are trimmed and length-limited, scopes lower-cased, paths must exist in the real change set, and
   files the model forgot are appended to the last commit.
5. **Commit** — the default mode stages everything and commits. `--split` uses per-file pathspecs;
   `--select` stages and commits only the chosen files. Deletions, renames and staged deletions are
   handled explicitly.

## Scripting and CI

```bash
# preview the message without touching the repository
gac --dry-run --json | jq -r '.messages[0].subject'

# commit and push unattended
gac -y --push
```

`--json` output:

```json
{
  "root": "/repo",
  "skippedReason": null,
  "plan": [{ "type": "feat", "subject": "add retry", "files": ["src/a.ts"] }],
  "messages": [{ "subject": "feat: add retry", "body": "..." }],
  "committed": [{ "sha": "4f2a9c1", "subject": "feat: add retry", "files": ["src/a.ts"] }],
  "uncommitted": [],
  "pushed": false,
  "usage": { "inputTokens": 1820, "outputTokens": 76 }
}
```

Exit codes: `0` success, `1` runtime failure, `2` usage error. With `--json`, stdout contains only
JSON.

## Limitations

- Text diffs only; binary files appear by name.
- `--split` runs the pre-commit hook once per commit, so tools like lint-staged must accept partial
  staging.
- No `--amend` or rebase support; `gac` only creates new commits.
- `--select` is file-level and cannot pick individual hunks.
- Commit quality depends on the model; tune `--max-diff-chars` to control cost and context.

## Development

```bash
npm ci
npm test             # node --test, uses a fake model server; no network or API key
npm run typecheck
npm run build        # dist/ and .d.ts
node src/cli.ts --help
```

The test suite covers diff collection, prompt building, model retries, plan validation, selective and
split commits, agent hooks, and the standalone binary (skipped when Bun is not installed).

### Library usage

```ts
import { repoRoot, resolveSettings, runAutoCommit } from "git-auto-commit";

const root = repoRoot();
const { settings } = resolveSettings({ root });
const result = await runAutoCommit({ cwd: root, settings });
console.log(result.committed);
```

## License

MIT © [ZhenYi](https://github.com/lazhenyi)
