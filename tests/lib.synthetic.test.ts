import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { querySyntheticQuota } from "../src/lib/synthetic.js";

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFile: vi.fn(),
}));

describe("querySyntheticQuota", () => {
  const originalEnv = process.env;
  const originalCwd = process.cwd();
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-synthetic-"));
    process.env = { ...originalEnv, XDG_CONFIG_HOME: tempDir };
    process.chdir(tempDir);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.chdir(originalCwd);
    process.env = originalEnv;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns null when not configured", async () => {
    const { readAuthFile } = await import("../src/lib/opencode-auth.js");
    (readAuthFile as any).mockResolvedValueOnce({});

    delete process.env.SYNTHETIC_API_KEY;

    await expect(querySyntheticQuota()).resolves.toBeNull();
  });

  it("returns both top-level Synthetic quota windows from the API", async () => {
    process.env.SYNTHETIC_API_KEY = "test-key";

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            rollingFiveHourLimit: {
              max: 100,
              remaining: 74.5,
              nextTickAt: "2026-01-20T18:12:03.000Z",
              tickPercent: 74.5,
              limited: false,
            },
            weeklyTokenLimit: {
              maxCredits: "$24.00",
              remainingCredits: "$2.02",
              nextRegenAt: "2026-01-27T18:12:03.000Z",
              percentRemaining: 8.4552365,
              nextRegenCredits: "$0.48",
            },
          }),
          { status: 200 },
        ),
    ) as any;
    vi.stubGlobal("fetch", fetchMock);

    const out = await querySyntheticQuota();
    expect(out).toEqual({
      success: true,
      windows: {
        fiveHour: {
          limit: 100,
          used: 25.5,
          percentRemaining: 75,
          resetTimeIso: "2026-01-20T18:12:03.000Z",
        },
        weekly: {
          limit: 24,
          used: 21.98,
          percentRemaining: 8,
          resetTimeIso: "2026-01-27T18:12:03.000Z",
        },
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.synthetic.new/v2/quotas",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
        }),
      }),
    );
  });

  it.each(["bad-value", -5, 150] as const)(
    "falls back to deterministic weekly percent derivation when weeklyTokenLimit.percentRemaining is invalid (%s)",
    async (percentRemaining) => {
      process.env.SYNTHETIC_API_KEY = "test-key";

      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                rollingFiveHourLimit: {
                  max: 100,
                  remaining: 50,
                  nextTickAt: "2026-01-20T18:12:03.000Z",
                },
                weeklyTokenLimit: {
                  maxCredits: "$24.00",
                  remainingCredits: "$2.02",
                  nextRegenAt: "2026-01-27T18:12:03.000Z",
                  percentRemaining,
                  nextRegenCredits: "$0.48",
                },
              }),
              { status: 200 },
            ),
        ) as any,
      );

      await expect(querySyntheticQuota()).resolves.toEqual({
        success: true,
        windows: {
          fiveHour: {
            limit: 100,
            used: 50,
            percentRemaining: 50,
            resetTimeIso: "2026-01-20T18:12:03.000Z",
          },
          weekly: {
            limit: 24,
            used: 21.98,
            percentRemaining: 8,
            resetTimeIso: "2026-01-27T18:12:03.000Z",
          },
        },
      });
    },
  );

  it("normalizes valid reset timestamps and drops malformed ones", async () => {
    process.env.SYNTHETIC_API_KEY = "test-key";

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              rollingFiveHourLimit: {
                max: 135,
                remaining: 0,
                nextTickAt: "2025-09-21T14:36:14.288Z",
              },
              weeklyTokenLimit: {
                maxCredits: "$24.00",
                remainingCredits: "$2.02",
                nextRegenAt: "2025-09-28T14:36:14.288Z",
                percentRemaining: 8.4552365,
              },
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              rollingFiveHourLimit: {
                max: 135,
                remaining: 0,
                nextTickAt: "\u001b[31mbad-date",
              },
              weeklyTokenLimit: {
                maxCredits: "$24.00",
                remainingCredits: "$2.02",
                nextRegenAt: "\u001b[31mbad-date",
                percentRemaining: 8.4552365,
              },
            }),
            { status: 200 },
          ),
        ),
    );

    await expect(querySyntheticQuota()).resolves.toEqual({
      success: true,
      windows: {
        fiveHour: {
          limit: 135,
          used: 135,
          percentRemaining: 0,
          resetTimeIso: "2025-09-21T14:36:14.288Z",
        },
        weekly: {
          limit: 24,
          used: 21.98,
          percentRemaining: 8,
          resetTimeIso: "2025-09-28T14:36:14.288Z",
        },
      },
    });
    await expect(querySyntheticQuota()).resolves.toEqual({
      success: true,
      windows: {
        fiveHour: {
          limit: 135,
          used: 135,
          percentRemaining: 0,
          resetTimeIso: undefined,
        },
        weekly: {
          limit: 24,
          used: 21.98,
          percentRemaining: 8,
          resetTimeIso: undefined,
        },
      },
    });
  });

  it("handles API errors and sanitizes response text", async () => {
    process.env.SYNTHETIC_API_KEY = "test-key";

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Unauthorized\u001b[31m", { status: 401 })) as any,
    );

    const out = await querySyntheticQuota();
    expect(out).toEqual({
      success: false,
      error: "Synthetic API error 401: Unauthorized",
    });
  });

  it("ignores repo-local provider config for secret lookup", async () => {
    writeFileSync(
      join(tempDir, "opencode.json"),
      JSON.stringify({
        provider: {
          synthetic: {
            options: {
              apiKey: "{env:SYNTHETIC_API_KEY}",
            },
          },
        },
      }),
      "utf-8",
    );

    const out = await querySyntheticQuota();
    expect(out).toBeNull();
  });

  it("reads synthetic api keys from trusted global config only", async () => {
    mkdirSync(join(tempDir, "opencode"), { recursive: true });
    writeFileSync(
      join(tempDir, "opencode", "opencode.json"),
      JSON.stringify({
        provider: {
          synthetic: {
            options: {
              apiKey: "global-config-key",
            },
          },
        },
      }),
      "utf-8",
    );

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            rollingFiveHourLimit: {
              max: 100,
              remaining: 75,
            },
            weeklyTokenLimit: {
              maxCredits: "$24.00",
              remainingCredits: "$2.02",
              percentRemaining: 8.4552365,
            },
          }),
          { status: 200 },
        ),
    ) as any;
    vi.stubGlobal("fetch", fetchMock);

    const out = await querySyntheticQuota();
    expect(out).toEqual({
      success: true,
      windows: {
        fiveHour: {
          limit: 100,
          used: 25,
          percentRemaining: 75,
          resetTimeIso: undefined,
        },
        weekly: {
          limit: 24,
          used: 21.98,
          percentRemaining: 8,
          resetTimeIso: undefined,
        },
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.synthetic.new/v2/quotas",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer global-config-key",
        }),
      }),
    );
  });

  it("rejects arbitrary env templates in trusted global config", async () => {
    process.env.GITHUB_TOKEN = "github-secret";
    mkdirSync(join(tempDir, "opencode"), { recursive: true });
    writeFileSync(
      join(tempDir, "opencode", "opencode.json"),
      JSON.stringify({
        provider: {
          synthetic: {
            options: {
              apiKey: "{env:GITHUB_TOKEN}",
            },
          },
        },
      }),
      "utf-8",
    );

    const out = await querySyntheticQuota();
    expect(out).toBeNull();
  });

  it("reports zero percent remaining when either top-level window is exhausted", async () => {
    process.env.SYNTHETIC_API_KEY = "test-key";

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              rollingFiveHourLimit: {
                max: 100,
                remaining: 0,
              },
              weeklyTokenLimit: {
                maxCredits: "$24.00",
                remainingCredits: "$0.00",
                percentRemaining: 0,
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await querySyntheticQuota();
    expect(out).toEqual({
      success: true,
      windows: {
        fiveHour: {
          limit: 100,
          used: 100,
          percentRemaining: 0,
          resetTimeIso: undefined,
        },
        weekly: {
          limit: 24,
          used: 24,
          percentRemaining: 0,
          resetTimeIso: undefined,
        },
      },
    });
  });

  it("accepts the real weeklyTokenLimit sample shape and ignores legacy subscription fields", async () => {
    process.env.SYNTHETIC_API_KEY = "test-key";

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              rollingFiveHourLimit: {
                max: 1350,
                remaining: 1195.5,
                nextTickAt: "2026-02-06T16:16:18.386Z",
                tickPercent: 88.6,
                limited: false,
              },
              weeklyTokenLimit: {
                maxCredits: "$24.00",
                remainingCredits: "$2.02",
                nextRegenAt: "2026-02-10T00:00:00.000Z",
                percentRemaining: 8.4552365,
                nextRegenCredits: "$0.48",
              },
              freeToolCalls: {
                max: 250,
                remaining: 220,
              },
              search: {
                hourly: {
                  max: 300,
                  remaining: 245,
                  nextTickAt: "2026-02-06T12:00:00.000Z",
                },
              },
              subscription: {
                limit: 10,
                requests: 9,
                renewsAt: "2027-01-01T00:00:00.000Z",
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    await expect(querySyntheticQuota()).resolves.toEqual({
      success: true,
      windows: {
        fiveHour: {
          limit: 1350,
          used: 154.5,
          percentRemaining: 89,
          resetTimeIso: "2026-02-06T16:16:18.386Z",
        },
        weekly: {
          limit: 24,
          used: 21.98,
          percentRemaining: 8,
          resetTimeIso: "2026-02-10T00:00:00.000Z",
        },
      },
    });
  });

  it("rejects malformed top-level rollingFiveHourLimit payloads", async () => {
    process.env.SYNTHETIC_API_KEY = "test-key";

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              rollingFiveHourLimit: {
                max: "1350",
                remaining: "20",
                nextTickAt: "2026-02-06T16:16:18.386Z",
              },
              weeklyTokenLimit: {
                maxCredits: "$24.00",
                remainingCredits: "$2.02",
                nextRegenAt: "2026-02-10T00:00:00.000Z",
                percentRemaining: 8.4552365,
              },
              subscription: {
                limit: 100,
                requests: 25,
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    await expect(querySyntheticQuota()).resolves.toEqual({
      success: false,
      error: "Synthetic API response missing rollingFiveHourLimit quota window",
    });
  });

  it("rejects malformed weeklyTokenLimit credit strings", async () => {
    process.env.SYNTHETIC_API_KEY = "test-key";

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              rollingFiveHourLimit: {
                max: 1350,
                remaining: 1200,
                nextTickAt: "2026-02-06T16:16:18.386Z",
              },
              weeklyTokenLimit: {
                maxCredits: "24.00",
                remainingCredits: "$2.02",
                nextRegenAt: "2026-02-10T00:00:00.000Z",
                percentRemaining: 8.4552365,
              },
              subscription: {
                limit: 100,
                requests: 25,
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    await expect(querySyntheticQuota()).resolves.toEqual({
      success: false,
      error: "Synthetic API response missing weeklyTokenLimit quota window",
    });
  });

  it("requires the weekly top-level Synthetic window even when rollingFiveHourLimit exists", async () => {
    process.env.SYNTHETIC_API_KEY = "test-key";

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              rollingFiveHourLimit: {
                max: 135,
                remaining: 120,
                nextTickAt: "2026-02-06T16:16:18.386Z",
              },
              subscription: {
                limit: 200,
                requests: 50,
                renewsAt: "2026-02-06T16:16:18.386Z",
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    await expect(querySyntheticQuota()).resolves.toEqual({
      success: false,
      error: "Synthetic API response missing weeklyTokenLimit quota window",
    });
  });

  it("rejects legacy subscription-only payloads instead of falling back", async () => {
    process.env.SYNTHETIC_API_KEY = "test-key";

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              subscription: {
                limit: 200,
                requests: 50,
                renewsAt: "2026-02-06T16:16:18.386Z",
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    await expect(querySyntheticQuota()).resolves.toEqual({
      success: false,
      error: "Synthetic API response missing rollingFiveHourLimit quota window",
    });
  });
});
