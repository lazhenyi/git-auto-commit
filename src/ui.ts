import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const useColor =
  !!stdout.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";

function paint(code: string, text: string): string {
  return useColor ? `\u001B[${code}m${text}\u001B[0m` : text;
}

export const color = {
  bold: (text: string) => paint("1", text),
  dim: (text: string) => paint("2", text),
  red: (text: string) => paint("31", text),
  green: (text: string) => paint("32", text),
  yellow: (text: string) => paint("33", text),
  blue: (text: string) => paint("34", text),
  magenta: (text: string) => paint("35", text),
  cyan: (text: string) => paint("36", text),
  gray: (text: string) => paint("90", text),
};

let jsonMode = false;

/**
 * In JSON mode stdout must stay machine-readable, so human output moves to
 * stderr (which is also where `git` writes progress).
 */
export function setJsonMode(enabled: boolean): void {
  jsonMode = enabled;
}

function write(stream: NodeJS.WriteStream, text: string): void {
  (jsonMode ? process.stderr : stream).write(`${text}\n`);
}

export const log = {
  info(message: string): void {
    write(stdout, message);
  },
  step(message: string): void {
    write(stdout, `${color.cyan("›")} ${message}`);
  },
  success(message: string): void {
    write(stdout, `${color.green("✔")} ${message}`);
  },
  warn(message: string): void {
    write(process.stderr, `${color.yellow("!")} ${message}`);
  },
  error(message: string): void {
    write(process.stderr, `${color.red("✖")} ${message}`);
  },
  /** Follow-up advice for an error; always on stderr so pipes stay clean. */
  hint(message: string): void {
    process.stderr.write(`${color.gray(`Hint: ${message}`)}\n`);
  },
  debug(message: string): void {
    write(process.stderr, color.gray(`· ${message}`));
  },
};

/** Prints a commit message with a subtle gutter so it is easy to copy. */
export function printMessage(subject: string, body?: string): void {
  log.info("");
  log.info(`  ${color.bold(subject)}`);
  if (body) {
    for (const line of body.split("\n")) log.info(`  ${line}`);
  }
  log.info("");
}

export interface ConfirmOptions {
  defaultYes?: boolean;
  /** Offer `e` (edit in $EDITOR); only meaningful for a single commit. */
  allowEdit?: boolean;
}

export async function confirm(
  question: string,
  options: ConfirmOptions = {},
): Promise<"yes" | "no" | "edit"> {
  if (!stdin.isTTY) {
    // Never commit unattended without an explicit --yes.
    return "no";
  }

  const choices = options.allowEdit ? "[Y/n/e] " : "[Y/n] ";
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      const answer = (await rl.question(`${question} ${choices}`)).trim().toLowerCase();
      if (answer === "") return options.defaultYes === false ? "no" : "yes";
      if (answer === "y" || answer === "yes") return "yes";
      if (answer === "n" || answer === "no" || answer === "q" || answer === "quit") return "no";
      if (options.allowEdit && (answer === "e" || answer === "edit")) return "edit";
      log.warn(`Please answer ${options.allowEdit ? "y, n or e" : "y or n"}.`);
    }
  } finally {
    rl.close();
  }
}
