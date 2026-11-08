/** Error with a user-facing hint and a stable exit code. */
export class GacError extends Error {
  readonly hint?: string;
  readonly exitCode: number;

  constructor(message: string, options: { hint?: string; exitCode?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GacError";
    this.hint = options.hint;
    this.exitCode = options.exitCode ?? 1;
  }
}

export class UsageError extends GacError {
  constructor(message: string, hint?: string) {
    super(message, { hint, exitCode: 2 });
    this.name = "UsageError";
  }
}

/** The model answered, but the answer could not be turned into a commit. */
export class PlanError extends GacError {
  constructor(message: string, hint?: string) {
    super(message, { hint });
    this.name = "PlanError";
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
