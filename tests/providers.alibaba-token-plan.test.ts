import { describe, expect, it, vi } from "vite-plus/test";

import { rowsFromProviderResult } from "../src/core/rows.js";
import {
  queryAlibabaTokenPlanQuota,
  resolveAlibabaTokenPlanExecutable,
} from "../src/lib/alibaba-token-plan.js";
import { alibabaTokenPlanProvider } from "../src/providers/alibaba-token-plan.js";
import { rowSummary } from "./helpers/provider-fetch.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

vi.mock("../src/lib/alibaba-token-plan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/alibaba-token-plan.js")>();
  return {
    ...actual,
    resolveAlibabaTokenPlanExecutable: vi.fn(actual.resolveAlibabaTokenPlanExecutable),
    queryAlibabaTokenPlanQuota: vi.fn(actual.queryAlibabaTokenPlanQuota),
  };
});

describe("alibaba-token-plan provider", () => {
  it("is available from explicit selection or recognized runtime presence without probing PATH", async () => {
    const supported = process.platform === "darwin" || process.platform === "linux";
    const selected = createProviderAvailabilityContext({
      providerIds: ["alibaba-token-plan"],
    });
    await expect(alibabaTokenPlanProvider.isAvailable(selected)).resolves.toBe(supported);

    const codingPlanOnly = createProviderAvailabilityContext({
      providerIds: ["alibaba", "alibaba-coding-plan"],
    });
    await expect(alibabaTokenPlanProvider.isAvailable(codingPlanOnly)).resolves.toBe(false);

    const runtime = createProviderAvailabilityContext({
      configOverrides: { currentProviderID: "alibaba-token-plan" },
    });
    await expect(alibabaTokenPlanProvider.isAvailable(runtime)).resolves.toBe(supported);

    const model = createProviderAvailabilityContext({
      configOverrides: { currentModel: "alibaba-token-plan/qwen3" },
    });
    await expect(alibabaTokenPlanProvider.isAvailable(model)).resolves.toBe(supported);
    expect(resolveAlibabaTokenPlanExecutable).not.toHaveBeenCalled();
  });

  it.each([
    ["alibaba-token-plan/qwen3", "alibaba-token-plan", true],
    ["alibaba/qwen3-coder", "alibaba", false],
    ["alibaba-coding-plan/qwen3", "alibaba-coding-plan", false],
    ["alibaba-token-plan/qwen3", undefined, true],
    ["alibaba/qwen3-coder", undefined, false],
  ])("matchesCurrentModel(%s, provider %s) -> %s", (model, currentProviderID, expected) => {
    const context = currentProviderID ? ({ currentProviderID } as never) : undefined;
    expect(alibabaTokenPlanProvider.matchesCurrentModel?.(model, context)).toBe(expected);
  });

  it("asks the CLI in the project folder", async () => {
    vi.mocked(queryAlibabaTokenPlanQuota).mockResolvedValueOnce({ ok: true });

    await alibabaTokenPlanProvider.fetch({
      workspaceRoot: "/home/user/project",
      config: { requestTimeoutMs: 5000 },
    } as never);

    expect(queryAlibabaTokenPlanQuota).toHaveBeenLastCalledWith({
      requestTimeoutMs: 5000,
      runtime: { cwd: "/home/user/project" },
    });
  });

  const RESET = "2024-05-01T20:53:20.000Z";
  const PLATFORM = { key: "platform", value: process.platform };

  it.each([
    [
      "both windows",
      {
        ok: true,
        fiveHour: { percentRemaining: 40 },
        weekly: { percentRemaining: 60, resetTimeIso: RESET },
      },
      [
        ["alibaba-token-plan.five_hour", null, "5h", "five_hour", 40, null],
        ["alibaba-token-plan.weekly", null, "Weekly", "week", 60, RESET],
      ],
      undefined,
      [{ key: "cli_available", value: "true" }, PLATFORM, { key: "windows", value: "5h,weekly" }],
    ],
    [
      "only the weekly window, without making up the other",
      { ok: true, weekly: { percentRemaining: 60, resetTimeIso: RESET } },
      [["alibaba-token-plan.weekly", null, "Weekly", "week", 60, RESET]],
      undefined,
      [{ key: "cli_available", value: "true" }, PLATFORM, { key: "windows", value: "weekly" }],
    ],
    [
      "a missing CLI",
      {
        ok: false,
        error: {
          kind: "executable_not_found",
          message: "Alibaba Cloud CLI (bl) was not found on the trusted PATH.",
        },
      },
      [],
      { code: "local_tool" },
      [
        { key: "cli_available", value: "false" },
        PLATFORM,
        { key: "failure_kind", value: "executable_not_found" },
        {
          key: "error",
          value:
            "Alibaba Personal Token Plan: Alibaba Cloud CLI (bl) was not found on the trusted PATH.",
        },
        { key: "error_kind", value: "local_tool" },
      ],
    ],
    [
      "an expired console sign-in",
      {
        ok: false,
        error: {
          kind: "not_authenticated",
          message:
            "Alibaba Cloud console session is missing or expired. Run `bl auth login --console`.",
        },
      },
      [],
      { code: "login_expired" },
      [
        { key: "cli_available", value: "true" },
        PLATFORM,
        { key: "failure_kind", value: "not_authenticated" },
        {
          key: "error",
          value:
            "Alibaba Personal Token Plan: Alibaba Cloud console session is missing or expired. Run `bl auth login --console`.",
        },
        { key: "error_kind", value: "login_expired" },
      ],
    ],
    [
      "a timeout",
      {
        ok: false,
        error: {
          kind: "timeout",
          message: "Timed out while running the Alibaba Cloud CLI.",
        },
      },
      [],
      { code: "timeout" },
      [
        { key: "cli_available", value: "true" },
        PLATFORM,
        { key: "failure_kind", value: "timeout" },
        {
          key: "error",
          value: "Alibaba Personal Token Plan: Timed out while running the Alibaba Cloud CLI.",
        },
        { key: "error_kind", value: "timeout" },
      ],
    ],
    [
      "an unsupported platform, as not set up",
      {
        ok: false,
        error: {
          kind: "unsupported_platform",
          message: "Alibaba Personal Token Plan is not supported on this platform.",
        },
      },
      [],
      { code: "not_configured" },
      [
        { key: "cli_available", value: "true" },
        PLATFORM,
        { key: "failure_kind", value: "unsupported_platform" },
      ],
    ],
  ])("shows %s", async (_name, reply, rows, error, debug) => {
    vi.mocked(queryAlibabaTokenPlanQuota).mockResolvedValueOnce(reply as never);

    const fetched = rowsFromProviderResult(
      "alibaba-token-plan",
      await alibabaTokenPlanProvider.fetch({ config: {} } as never),
    );

    expect(rowSummary(fetched.rows)).toEqual(rows);
    if (error) expect(fetched.error).toMatchObject(error);
    else expect(fetched.error).toBeUndefined();
    expect(fetched.debug).toEqual(debug);
  });
});
