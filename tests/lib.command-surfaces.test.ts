import { describe, expect, it } from "vitest";

import { shouldRegisterServerSlashCommands } from "../src/lib/command-surfaces.js";

describe("deterministic command surfaces", () => {
  it("keeps server slash commands out of the embedded TUI worker", () => {
    expect(shouldRegisterServerSlashCommands({ isMainThread: false, argv: ["opencode"] })).toBe(
      false,
    );
  });

  it("keeps server slash commands out of the in-process mini TUI", () => {
    expect(
      shouldRegisterServerSlashCommands({ isMainThread: true, argv: ["opencode", "--mini"] }),
    ).toBe(false);
    expect(
      shouldRegisterServerSlashCommands({ isMainThread: true, argv: ["opencode", "--mini=true"] }),
    ).toBe(false);
  });

  it("registers slash commands on web and server hosts", () => {
    expect(
      shouldRegisterServerSlashCommands({ isMainThread: true, argv: ["opencode", "web"] }),
    ).toBe(true);
    expect(
      shouldRegisterServerSlashCommands({ isMainThread: true, argv: ["opencode", "serve"] }),
    ).toBe(true);
  });
});
