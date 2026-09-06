import { describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  rm: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  rm: fsMocks.rm,
}));

import { safeRm } from "../scripts/lib/upstream-plugin-fs.mjs";

describe("upstream-plugin-fs", () => {
  it("requests native retries for transient Windows cleanup failures", async () => {
    fsMocks.rm.mockResolvedValue(undefined);

    await safeRm("temporary-reference-tree");

    expect(fsMocks.rm).toHaveBeenCalledOnce();
    expect(fsMocks.rm).toHaveBeenCalledWith("temporary-reference-tree", {
      force: true,
      recursive: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
});
