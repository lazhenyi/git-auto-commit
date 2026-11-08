#!/usr/bin/env node
/**
 * Builds standalone executables with Bun's `--compile` (the Bun runtime is
 * embedded in the output, so the binary needs neither Node nor Bun at runtime).
 *
 * Usage:
 *   node scripts/build-binary.ts                 # host platform → bin/gac
 *   node scripts/build-binary.ts --all           # every supported platform
 *   node scripts/build-binary.ts --target bun-linux-arm64
 *   node scripts/build-binary.ts --outdir dist/bin --minify
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const ENTRY = join(ROOT, "src", "cli.ts");

const TARGETS = [
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-darwin-x64",
  "bun-darwin-arm64",
  "bun-windows-x64",
] as const;

type Target = (typeof TARGETS)[number];

const HOST_TARGETS: Record<string, Target | undefined> = {
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
  "darwin-x64": "bun-darwin-x64",
  "darwin-arm64": "bun-darwin-arm64",
  "win32-x64": "bun-windows-x64",
};

interface Options {
  all: boolean;
  targets: Target[];
  outdir: string;
  minify: boolean;
}

function usage(): string {
  return [
    "Usage: node scripts/build-binary.ts [options]",
    "",
    "  --all                 Build every supported platform",
    "  --target <name>       Build one target (repeatable):",
    ...TARGETS.map((target) => `                          ${target}`),
    "  --outdir <dir>        Output directory (default: bin)",
    "  --minify              Minify the bundle",
    "  --help                Show this help",
  ].join("\n");
}

function parseArgs(argv: string[]): Options {
  const options: Options = { all: false, targets: [], outdir: "bin", minify: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === "--all") {
      options.all = true;
    } else if (arg === "--minify") {
      options.minify = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else if (arg === "--target") {
      const value = argv[index + 1];
      if (!value) throw new Error("--target needs a value");
      if (!(TARGETS as readonly string[]).includes(value)) {
        throw new Error(`Unknown target "${value}". Known: ${TARGETS.join(", ")}`);
      }
      options.targets.push(value as Target);
      index += 1;
    } else if (arg === "--outdir") {
      const value = argv[index + 1];
      if (!value) throw new Error("--outdir needs a value");
      options.outdir = value;
      index += 1;
    } else {
      throw new Error(`Unknown option "${arg}".\n\n${usage()}`);
    }
  }

  return options;
}

function bunVersion(): string | undefined {
  const result = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout.trim();
}

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version?: string };
  return pkg.version ?? "0.0.0";
}

function formatSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function binaryName(target: Target | undefined): string {
  const platform = target ?? HOST_TARGETS[`${process.platform}-${process.arch}`];
  const windows = platform?.includes("windows") ?? process.platform === "win32";
  return windows ? "gac.exe" : "gac";
}

function build(target: Target | undefined, options: Options, version: string): string {
  const outdir = resolve(ROOT, options.outdir);
  mkdirSync(outdir, { recursive: true });
  const outfile = join(outdir, binaryName(target));

  const args = [
    "build",
    ENTRY,
    "--compile",
    "--outfile",
    outfile,
    "--define",
    `__GAC_VERSION__=${JSON.stringify(version)}`,
  ];
  if (target) args.push(`--target=${target}`);
  if (options.minify) args.push("--minify");

  const label = target ?? `${process.platform}-${process.arch}`;
  process.stdout.write(`\n› Building ${label} → ${outfile}\n`);
  const result = spawnSync("bun", args, { cwd: ROOT, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`bun build failed for ${label} (exit ${result.status})`);

  process.stdout.write(`✔ ${outfile} (${formatSize(statSync(outfile).size)})\n`);
  return outfile;
}

function main(): number {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`✖ ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const bun = bunVersion();
  if (!bun) {
    process.stderr.write(
      "✖ Bun is required to build a standalone executable.\n" +
        "  Install it with `curl -fsSL https://bun.sh/install | bash` or `npm i -g bun`.\n" +
        "  (The generated binary itself does not need Bun or Node to run.)\n",
    );
    return 1;
  }

  const version = packageVersion();
  const targets: (Target | undefined)[] = options.all
    ? [...TARGETS]
    : options.targets.length > 0
      ? options.targets
      : [HOST_TARGETS[`${process.platform}-${process.arch}`]];

  process.stdout.write(`Bun ${bun} · git-auto-commit ${version}\n`);

  const built: string[] = [];
  try {
    for (const target of targets) built.push(build(target, options, version));
  } catch (error) {
    process.stderr.write(`✖ ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  process.stdout.write(`\n${built.length} executable(s) ready:\n`);
  for (const file of built) process.stdout.write(`  ${file}\n`);
  process.stdout.write("\nSmoke test: ./bin/gac --version\n");
  return 0;
}

process.exitCode = main();
