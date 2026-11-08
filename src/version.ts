import { readFileSync } from "node:fs";

/**
 * Injected by the standalone-binary build (`bun build --compile --define`).
 * `typeof` on a missing global is safe, so the fallback works everywhere else.
 */
declare const __GAC_VERSION__: string | undefined;

function fromPackageJson(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION: string = typeof __GAC_VERSION__ === "string" ? __GAC_VERSION__ : fromPackageJson();
