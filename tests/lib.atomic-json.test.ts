import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("fs/promises", () => ({
  mkdir: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  writeFile: vi.fn(),
}));

describe("atomic-json", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes JSON with a trailing newline when requested", async () => {
    const fs = await import("fs/promises");
    const { writeJsonAtomic } = await import("../src/lib/atomic-json.js");

    await writeJsonAtomic("/tmp/opencode/state.json", { ok: true }, { trailingNewline: true });

    expect(fs.mkdir).toHaveBeenCalledWith("/tmp/opencode", { recursive: true });
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
    const [tmpPath, content, encoding] = (fs.writeFile as any).mock.calls[0];
    expect(tmpPath).toContain("/tmp/opencode/state.json.tmp-");
    expect(content).toBe('{\n  "ok": true\n}\n');
    expect(encoding).toBe("utf-8");
    expect(fs.rename).toHaveBeenCalledWith(tmpPath, "/tmp/opencode/state.json");
    expect(fs.rm).not.toHaveBeenCalled();
  });

  it("writes raw text without reformatting it", async () => {
    const fs = await import("fs/promises");
    const { writeTextAtomic } = await import("../src/lib/atomic-json.js");
    const content = '{ // comment\n  "plugin": [],\n}\n';

    await writeTextAtomic("/tmp/opencode/opencode.jsonc", content);

    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining("opencode.jsonc.tmp-"),
      content,
      "utf-8",
    );
  });

  it("replaces the destination when rename hits a retryable error", async () => {
    const fs = await import("fs/promises");
    const { writeJsonAtomic } = await import("../src/lib/atomic-json.js");
    const renameError = Object.assign(new Error("destination exists"), { code: "EPERM" });

    (fs.rename as any).mockRejectedValueOnce(renameError).mockResolvedValueOnce(undefined);

    await writeJsonAtomic("/tmp/opencode/state.json", { ok: true });

    const [tmpPath] = (fs.writeFile as any).mock.calls[0];
    expect(fs.rm).toHaveBeenCalledWith("/tmp/opencode/state.json", { force: true });
    expect(fs.rename).toHaveBeenNthCalledWith(1, tmpPath, "/tmp/opencode/state.json");
    expect(fs.rename).toHaveBeenNthCalledWith(2, tmpPath, "/tmp/opencode/state.json");
  });

  it("cleans up the temp file when rename fails with a non-retryable error", async () => {
    const fs = await import("fs/promises");
    const { writeJsonAtomic } = await import("../src/lib/atomic-json.js");
    const renameError = Object.assign(new Error("cross-device link"), { code: "EXDEV" });

    (fs.rename as any).mockRejectedValueOnce(renameError);

    await expect(writeJsonAtomic("/tmp/opencode/state.json", { ok: true })).rejects.toThrow(
      "cross-device link",
    );

    const [tmpPath] = (fs.writeFile as any).mock.calls[0];
    expect(fs.rm).toHaveBeenCalledWith(tmpPath, { force: true });
    expect(fs.rename).toHaveBeenCalledTimes(1);
  });
});
