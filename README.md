# git-auto-commit (`gac`)

读 diff → 让 AI 写 commit message → 直接提交。一条命令搞定：

```bash
gac
```

它会把工作区的改动（含未跟踪文件）整理成 unified diff，交给任意 OpenAI 兼容接口
（OpenAI、DeepSeek、Moonshot、OpenRouter、Ollama、vLLM、自建网关……）或 Anthropic，
生成 [Conventional Commits](https://www.conventionalcommits.org/) 格式的提交信息，确认后提交。
需要时还能让模型把一次改动拆成多个独立 commit。

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

## 安装

```bash
npm install -g git-auto-commit
# 或从源码
npm install && npm run build && npm link
```

要求 Node.js ≥ 20.11；直接从源码运行测试需要 ≥ 22.6（Node 原生执行 TypeScript）。

也可以编译成不依赖 Node 的单文件可执行程序，见下一节。

## 编译为可执行文件

用 [Bun](https://bun.sh) 的 `--compile` 把 CLI 和运行时打包成一个文件，产物运行时**不需要 Node 也不需要 Bun**：

```bash
npm run build:bin         # 当前平台 → bin/gac（Windows 为 bin/gac.exe）
npm run build:bin:all     # 交叉编译全部平台
./bin/gac --version
```

自定义目标 / 输出目录 / 压缩：

```bash
node scripts/build-binary.ts --target bun-linux-arm64 --target bun-darwin-arm64
node scripts/build-binary.ts --outdir release --minify
```

| 目标 | 说明 |
| --- | --- |
| `bun-linux-x64` / `bun-linux-arm64` | Linux |
| `bun-darwin-x64` / `bun-darwin-arm64` | macOS |
| `bun-windows-x64` | Windows（`gac.exe`） |

注意事项：

- 每个产物约 **100 MB**，因为内嵌了 Bun 运行时；版本号在编译时通过 `--define __GAC_VERSION__` 注入。
- 运行时仍然需要系统里有 `git`（这是它唯一的外部依赖）。
- macOS 首次运行如被 Gatekeeper 拦截：`codesign --force --sign - bin/gac`。
- 交叉编译不需要目标平台的机器，但 Bun 会为每个目标下载对应运行时（首次较慢）。
- `bin/` 已加入 `.gitignore`，需要分发时上传到 Release 而不是提交进仓库。

## 快速开始

```bash
export GAC_API_KEY=sk-...        # 或 OPENAI_API_KEY / ANTHROPIC_API_KEY
gac --dry-run                    # 先看看会提交什么
gac                              # 确认后提交
gac -y                           # 不再询问
```

想用 `git auto-commit` 这种子命令写法：

```bash
gac alias install                # git config --global alias.auto-commit '!gac'
git auto-commit -y
```

## 接入模型

默认走 OpenAI 兼容的 `/chat/completions`，因此只要改 `--base-url` 就能换供应商。

| 场景 | 配置 |
| --- | --- |
| OpenAI | `GAC_API_KEY=sk-...`（默认 base URL） |
| DeepSeek | `GAC_BASE_URL=https://api.deepseek.com/v1`　`GAC_MODEL=deepseek-chat` |
| Moonshot | `GAC_BASE_URL=https://api.moonshot.cn/v1`　`GAC_MODEL=moonshot-v1-8k` |
| OpenRouter | `GAC_BASE_URL=https://openrouter.ai/api/v1`　`GAC_MODEL=...` |
| Ollama（本地） | `GAC_BASE_URL=http://127.0.0.1:11434/v1`　`GAC_MODEL=qwen2.5-coder`　`GAC_API_KEY=ollama` |
| Anthropic | `--provider anthropic`　`ANTHROPIC_API_KEY=sk-ant-...` |
| 自建网关（如 magpie） | `GAC_BASE_URL=http://127.0.0.1:<port>/v1`　`GAC_MODEL=<网关里的模型名>` |

Provider 也可以省略：模型名以 `claude` 开头或 base URL 含 `anthropic` 时会自动用 Anthropic 协议。

## 常用选项

| 选项 | 作用 |
| --- | --- |
| `-y, --yes` | 不询问直接提交（适合脚本 / CI） |
| `-n, --dry-run` | 只打印提交信息，不暂存、不提交 |
| `-s, --staged` | 只提交已经 `git add` 的内容（默认提交整个工作区） |
| `--split`, `--batches` | 让模型按逻辑关联把改动拆成多个 commit |
| `--select` | 让模型自己挑选要提交的文件，其余保持未提交 |
| `--push` | 提交后推送（无 upstream 时自动 `-u origin HEAD`） |
| `--emoji` | 类型前加 emoji，如 `✨ feat: ...` |
| `--plain` | 去掉 `type(scope):` 前缀 |
| `--type <t>` / `--scope <s>` | 强制提交类型 / scope |
| `--lang <en\|zh\|ja\|ko\|auto>` | 提交信息语言，默认 `en`；`auto` 跟随最近提交 |
| `--max-diff-chars <n>` | diff 预算，默认 48000 字符 |
| `--exclude <glob,...>` | 追加不进 prompt 的路径（锁文件等默认已排除） |
| `--instructions <text>` | 附加给模型的额外要求 |
| `--fallback` | 模型调用失败时用启发式信息兜底 |
| `--no-verify` | 跳过 git hooks |
| `--json` | stdout 只输出 JSON，方便脚本消费 |
| `--debug` | 打印 HTTP / 重试细节 |

完整列表：`gac --help`。

确认阶段可以选 `e` 用 `$EDITOR` 修改提交信息。非交互环境（stdin 不是 TTY）不会自动确认，必须显式加 `--yes`。

## 配置

优先级：**命令行参数 > 环境变量 > 仓库配置 > 用户配置 > 默认值**

```bash
gac init                 # 在仓库写入 .gac.json
gac config               # 查看解析后的配置（key 已脱敏）
gac config --json        # 机器可读
```

仓库级 `.gac.json`（或 `.git-auto-commit.json`）：

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
  "instructions": "scope 用模块名，不要写 ticket 号"
}
```

用户级 `~/.config/git-auto-commit/config.json` 支持同样的字段。API key 建议只放在环境变量里；
若仓库配置里出现 `apiKey`，`gac` 会警告，因为它可能被提交。

环境变量：`GAC_API_KEY`、`GAC_BASE_URL`、`GAC_MODEL`、`GAC_PROVIDER`、`GAC_LANGUAGE`、
`GAC_MAX_DIFF_CHARS`、`GAC_INSTRUCTIONS`、`GAC_EXCLUDE`、`GAC_TEMPERATURE`、
`GAC_MAX_TOKENS`、`GAC_TIMEOUT_MS`、`GAC_SPLIT`、`GAC_SELECT`、`GAC_EMOJI`、
`GAC_NO_VERIFY`、`GAC_FALLBACK`、`GAC_PUSH`、`GAC_DEBUG`。

## 选择性提交与分批提交

默认一次提交全部改动。需要 AI 自己取舍时：

```bash
gac --select              # AI 挑一组相关文件提交，其余原样留在工作区
gac --select --split      # 先挑文件，再拆成多个 commit（分批次）
gac --split               # 全部改动，但拆成多个 commit
```

`--select` 的语义：

- 模型只把“该一起提交”的文件放进 commit；没选中的文件（包括未跟踪文件）不会被暂存或提交。
- 即使你的暂存区里还有别的文件，也不会被顺带提交（每个 commit 都按文件路径限定）。
- 提交结束后会打印 `Left uncommitted N file(s): ...`；`--json` 输出里对应 `uncommitted` 字段。
- 模型一个文件都没选时直接报错，不会退化成“提交全部”。

选择粒度是**文件级**：不做同一个文件内部的 hunk 级拆分，也不支持交互式逐块选择。

## 它具体做了什么

1. **收集改动**：`git status --porcelain -z` 拿文件清单，`git diff HEAD` 拿补丁，
   未跟踪文件会合成 `new file` 补丁（二进制/超大文件只报大小）。没有 commit 的仓库用空树对比。
2. **控制预算**：锁文件、`dist/`、`node_modules/` 等默认只列文件名不带 diff；
   超出 `maxDiffChars` 时按文件截断，并在 prompt 里明确告诉模型哪些内容被省略。
3. **写 prompt**：带上当前分支、最近 10 条提交（对齐风格）、文件改动统计和 diff；
   要求只输出 JSON，`--split` 时还要求每个文件恰好属于一个 commit。
4. **校验模型输出**：兼容裸 JSON、代码块、夹在说明文字里的 JSON；
   类型别名归一（`feature` → `feat`），subject 去句号、压空格、限长，
   scope 小写化，路径必须来自真实改动列表；模型漏掉的文件会补进最后一个 commit。
5. **安全提交**：默认先 `git add` 再提交；`--split` 的后续 commit 用 pathspec 只包含各自文件；
   `--staged` 模式下如果某文件还有未暂存的修改，会放弃拆分改为单个 commit，
   避免把未暂存的内容带进去。提交失败（hook 拒绝、无内容等）会保留现场并给出提示。

## 在脚本 / CI 里用

```bash
# 只检查模型会写什么，不落盘
gac --dry-run --json | jq -r '.messages[0].subject'

# 自动提交 + 推送
gac --yes --push
```

`--json` 输出结构：

```json
{
  "root": "/repo",
  "skippedReason": null,
  "plan": [{ "type": "feat", "subject": "add retry", "files": ["src/a.ts"] }],
  "messages": [{ "subject": "feat: add retry", "body": "..." }],
  "committed": [{ "sha": "4f2a9c1", "subject": "feat: add retry", "files": ["src/a.ts"] }],
  "uncommitted": ["src/wip.ts"],
  "pushed": false,
  "usage": { "inputTokens": 1820, "outputTokens": 76 }
}
```

## 已知边界

- 只处理文本 diff；二进制文件只作为文件名出现。
- `--split` 会让每个 commit 单独触发一次 pre-commit hook，lint-staged 之类的工具需要能接受部分暂存。
- 没有 `--amend` / rebase 能力，它只负责新提交。
- `--select` 是文件级选择，不会拆分同一个文件里的不同改动。
- diff 是 prompt 的一部分，模型输出质量取决于模型本身；用 `--max-diff-chars` 控制成本。

## 开发

```bash
npm install
npm test          # node --test，内置假模型服务器，无需联网/API key
npm run test:binary  # 编译单文件后再跑一遍 e2e（没装 bun 会自动跳过）
npm run typecheck
npm run build     # 产出 dist/ 与 .d.ts
node src/cli.ts --help
```

也可以作为库使用：

```ts
import { repoRoot, resolveSettings, runAutoCommit } from "git-auto-commit";

const root = repoRoot();
const { settings } = resolveSettings({ root });
const result = await runAutoCommit({ cwd: root, settings });
console.log(result.committed);
```

## License

MIT
