import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimePathMocks = vi.hoisted(() => ({
  getOpencodeRuntimeDirCandidates: vi.fn(),
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: runtimePathMocks.getOpencodeRuntimeDirCandidates,
}));

const originalEnv = process.env;
const tempRoots: string[] = [];
const requiredCookie = "api-platform_serviceToken=service-secret; userId=user-secret";

async function createConfigDirs(): Promise<[string, string]> {
  const root = await mkdtemp(join(tmpdir(), "mimo-config-"));
  tempRoots.push(root);
  const primary = join(root, "primary");
  const fallback = join(root, "fallback");
  await mkdir(join(primary, "opencode-quota"), { recursive: true });
  await mkdir(join(fallback, "opencode-quota"), { recursive: true });
  return [primary, fallback];
}

function configPath(configDir: string): string {
  return join(configDir, "opencode-quota", "mimo.json");
}

describe("MiMo config resolution", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.MIMO_USAGE_COOKIE;
    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({ configDirs: [] });
  });

  afterEach(async () => {
    process.env = originalEnv;
    for (const root of tempRoots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes the optional Cookie prefix and retains only the fixed cookie set", async () => {
    const { normalizeMimoCookieHeader } = await import("../src/lib/mimo-config.js");

    expect(
      normalizeMimoCookieHeader(
        " Cookie: ignored=drop; userId=user=part; api-platform_slh=slh; " +
          "api-platform_serviceToken=service; api-platform_ph=ph ",
      ),
    ).toBe(
      "api-platform_serviceToken=service; userId=user=part; api-platform_ph=ph; api-platform_slh=slh",
    );
    expect(
      normalizeMimoCookieHeader("cookie: api-platform_serviceToken=service; userId=user"),
    ).toBe("api-platform_serviceToken=service; userId=user");
  });

  it.each([
    ["missing service token", "userId=user"],
    ["missing user id", "api-platform_serviceToken=service"],
    [
      "duplicate retained name",
      "api-platform_serviceToken=first; userId=user; api-platform_serviceToken=second",
    ],
    ["empty retained value", "api-platform_serviceToken=; userId=user"],
    ["malformed pair", "api-platform_serviceToken=service; malformed; userId=user"],
    ["CR injection", "api-platform_serviceToken=service; userId=user\rignored=value"],
    ["LF injection", "api-platform_serviceToken=service; userId=user\nignored=value"],
  ])("rejects %s", async (_label, raw) => {
    const { normalizeMimoCookieHeader } = await import("../src/lib/mimo-config.js");
    expect(normalizeMimoCookieHeader(raw)).toBeNull();
  });

  it("prefers the environment and never reads a lower-priority valid file", async () => {
    const [primary] = await createConfigDirs();
    await writeFile(configPath(primary), JSON.stringify({ cookie: requiredCookie }));
    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({ configDirs: [primary] });
    process.env.MIMO_USAGE_COOKIE =
      "Cookie: userId=env-user; ignored=value; api-platform_serviceToken=env-service";

    const { resolveMimoConfig } = await import("../src/lib/mimo-config.js");

    await expect(resolveMimoConfig()).resolves.toEqual({
      state: "configured",
      source: "env:MIMO_USAGE_COOKIE",
      config: {
        cookie: "api-platform_serviceToken=env-service; userId=env-user",
      },
    });
  });

  it("treats a defined invalid environment value as blocking", async () => {
    const [primary] = await createConfigDirs();
    await writeFile(configPath(primary), JSON.stringify({ cookie: requiredCookie }));
    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({ configDirs: [primary] });
    process.env.MIMO_USAGE_COOKIE = " ";

    const { resolveMimoConfig } = await import("../src/lib/mimo-config.js");

    await expect(resolveMimoConfig()).resolves.toEqual({
      state: "invalid",
      source: "env:MIMO_USAGE_COOKIE",
      error: "Invalid cookie header",
    });
  });

  it("reads the first trusted user/global config file when the environment is absent", async () => {
    const [primary] = await createConfigDirs();
    await writeFile(
      configPath(primary),
      JSON.stringify({
        cookie:
          "api-platform_ph=ph; userId=file-user; api-platform_serviceToken=file-service; other=no",
      }),
    );
    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({ configDirs: [primary] });

    const { resolveMimoConfig } = await import("../src/lib/mimo-config.js");

    await expect(resolveMimoConfig()).resolves.toEqual({
      state: "configured",
      source: configPath(primary),
      config: {
        cookie: "api-platform_serviceToken=file-service; userId=file-user; api-platform_ph=ph",
      },
    });
  });

  it("stops at the first present invalid trusted config", async () => {
    const [primary, fallback] = await createConfigDirs();
    await writeFile(configPath(primary), "{");
    await writeFile(configPath(fallback), JSON.stringify({ cookie: requiredCookie }));
    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({
      configDirs: [primary, fallback],
    });

    const { resolveMimoConfig } = await import("../src/lib/mimo-config.js");

    await expect(resolveMimoConfig()).resolves.toEqual({
      state: "invalid",
      source: configPath(primary),
      error: "Failed to parse JSON",
    });
  });

  it.each([
    ["array", "[]", "Config file must contain a JSON object"],
    ["missing cookie", "{}", "Config file must contain only the cookie field"],
    [
      "endpoint override",
      JSON.stringify({ cookie: requiredCookie, endpoint: "https://example.test" }),
      "Config file must contain only the cookie field",
    ],
    ["wrong cookie type", JSON.stringify({ cookie: 123 }), "Config cookie field must be a string"],
    [
      "invalid cookie",
      JSON.stringify({ cookie: "api-platform_serviceToken=secret" }),
      "Invalid cookie header",
    ],
  ])("rejects %s without fallback", async (_label, body, error) => {
    const [primary] = await createConfigDirs();
    await writeFile(configPath(primary), body);
    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({ configDirs: [primary] });

    const { resolveMimoConfig } = await import("../src/lib/mimo-config.js");

    await expect(resolveMimoConfig()).resolves.toEqual({
      state: "invalid",
      source: configPath(primary),
      error,
    });
  });

  it("caches resolved credentials within the configured TTL", async () => {
    const [primary] = await createConfigDirs();
    const path = configPath(primary);
    await writeFile(path, JSON.stringify({ cookie: requiredCookie }));
    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({ configDirs: [primary] });

    const { resolveMimoConfigCached } = await import("../src/lib/mimo-config.js");
    const first = await resolveMimoConfigCached({ maxAgeMs: 5_000 });
    await writeFile(
      path,
      JSON.stringify({
        cookie: "api-platform_serviceToken=changed-service; userId=changed-user",
      }),
    );

    await expect(resolveMimoConfigCached({ maxAgeMs: 5_000 })).resolves.toEqual(first);
  });

  it("reports trusted checked paths without exposing cookie names or values", async () => {
    const [primary, fallback] = await createConfigDirs();
    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({
      configDirs: [primary, fallback],
    });
    process.env.MIMO_USAGE_COOKIE = requiredCookie;

    const { getMimoConfigDiagnostics } = await import("../src/lib/mimo-config.js");
    const diagnostics = await getMimoConfigDiagnostics();
    const serialized = JSON.stringify(diagnostics);

    expect(diagnostics).toEqual({
      state: "configured",
      source: "env:MIMO_USAGE_COOKIE",
      error: null,
      checkedPaths: [configPath(primary), configPath(fallback)],
    });
    expect(serialized).not.toContain("service-secret");
    expect(serialized).not.toContain("user-secret");
    expect(serialized).not.toContain("api-platform_serviceToken");
    expect(serialized).not.toContain("userId");
    expect(serialized).not.toContain("auth.json");
  });
});
