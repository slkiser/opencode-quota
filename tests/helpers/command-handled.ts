import { expect } from "vitest";

import {
  COMMAND_HANDLED_SENTINEL,
  isCommandHandledError,
} from "../../src/lib/command-handled.js";

export async function expectCommandHandledAbort(result: unknown): Promise<Error> {
  try {
    await Promise.resolve(result);
  } catch (err) {
    expect(isCommandHandledError(err)).toBe(true);
    expect(err).toBeInstanceOf(Error);

    const handledError = err as Error;
    expect(handledError.message).not.toContain(COMMAND_HANDLED_SENTINEL);
    expect(String(handledError)).not.toContain(COMMAND_HANDLED_SENTINEL);
    expect(handledError.stack ?? "").not.toContain(COMMAND_HANDLED_SENTINEL);
    return handledError;
  }

  throw new Error("Expected command-handled abort");
}
