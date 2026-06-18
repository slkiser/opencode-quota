import { describe, expect, it } from "vitest";

import {
  COMMAND_HANDLED_SENTINEL,
  handled,
  isCommandHandledError,
} from "../src/lib/command-handled.js";

function captureHandledAbort(): unknown {
  try {
    handled();
  } catch (err) {
    return err;
  }
  throw new Error("handled() returned normally");
}

describe("command handled abort", () => {
  it("throws a quiet branded handled abort", () => {
    const err = captureHandledAbort();

    expect(err).toBeInstanceOf(Error);
    expect(isCommandHandledError(err)).toBe(true);
    expect((err as Error).message).toBe("");
    expect((err as Error).name).toBe("");
    expect(String(err)).toBe("");
    expect((err as Error).stack).toBe("");
    expect(String(err)).not.toContain(COMMAND_HANDLED_SENTINEL);
  });

  it("recognizes legacy sentinel-message errors", () => {
    expect(isCommandHandledError(new Error(COMMAND_HANDLED_SENTINEL))).toBe(true);
    expect(isCommandHandledError(new Error())).toBe(false);
  });
});
