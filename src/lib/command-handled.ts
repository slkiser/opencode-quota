/**
 * Command-handled sentinel.
 *
 * Thrown by slash-command handlers to signal that the command output
 * has already been injected and no further processing is needed.
 */

export const COMMAND_HANDLED_SENTINEL = "__QUOTA_COMMAND_HANDLED__" as const;

const COMMAND_HANDLED_ERROR_BRAND = Symbol.for("@slkiser/opencode-quota/command-handled");

function createCommandHandledError(): Error {
  const err = Object.create(Error.prototype) as Error;
  Object.defineProperties(err, {
    [COMMAND_HANDLED_ERROR_BRAND]: { value: true },
    message: { value: "", configurable: true, writable: true },
    name: { value: "", configurable: true, writable: true },
    stack: { value: "", configurable: true, writable: true },
  });
  return err;
}

/**
 * Throw a quiet command-handled abort error.
 * Use this instead of `throw new Error("__QUOTA_COMMAND_HANDLED__")`.
 */
export function handled(): never {
  throw createCommandHandledError();
}

/**
 * Returns true when an error is a command-handled abort.
 */
export function isCommandHandledError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }

  const marker = (err as unknown as Record<PropertyKey, unknown>)[COMMAND_HANDLED_ERROR_BRAND];
  return marker === true || err.message === COMMAND_HANDLED_SENTINEL;
}
