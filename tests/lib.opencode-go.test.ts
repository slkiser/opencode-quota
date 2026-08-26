import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const fetchResponse = vi.fn();
  return {
    fetchResponse,
    fetchWithTimeout: vi.fn(
      async (
        _url: string,
        options: {
          consume: (response: Response, signal: AbortSignal) => Promise<unknown> | unknown;
        },
      ) => {
        const response = await fetchResponse();
        return await options.consume(response, new AbortController().signal);
      },
    ),
  };
});

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}));

import { queryOpenCodeGoQuota } from "../src/lib/opencode-go.js";

type WindowKey = "rolling" | "weekly" | "monthly";

function validPayload(): Record<string, unknown> {
  return {
    usage: {
      rolling: {
        status: "ok",
        percent: 12.5,
        resetsAt: "2026-08-12T12:30:00Z",
      },
      weekly: {
        status: "ok",
        percent: 45,
        resetsAt: "2026-08-16T18:00:00+02:00",
      },
      monthly: {
        status: "ok",
        percent: 80,
        resetsAt: "2026-09-01T00:00:00-04:00",
      },
    },
    ignored: true,
  };
}

function windowFrom(payload: Record<string, unknown>, key: WindowKey): Record<string, unknown> {
  return ((payload.usage as Record<string, unknown>)[key] ?? {}) as Record<string, unknown>;
}

function mockSuccess(payload: unknown): void {
  mocks.fetchResponse.mockResolvedValueOnce({
    ok: true,
    json: vi.fn().mockResolvedValue(payload),
  });
}

function mockHttpFailure(status: number, text: string): void {
  mocks.fetchResponse.mockResolvedValueOnce({
    ok: false,
    status,
    text: vi.fn().mockResolvedValue(text),
  });
}

describe("queryOpenCodeGoQuota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the fixed Bearer JSON request and normalizes all windows", async () => {
    const token = "go-test-token";
    mockSuccess(validPayload());

    const result = await queryOpenCodeGoQuota(token, { requestTimeoutMs: 4321 });

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith("https://opencode.ai/zen/go/v1/usage", {
      request: {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      },
      timeoutMs: 4321,
      consume: expect.any(Function),
    });
    const request = mocks.fetchWithTimeout.mock.calls[0]?.[1]?.request;
    expect(JSON.stringify(request)).not.toContain("Cookie");
    expect(result).toEqual({
      success: true,
      rolling: {
        status: "ok",
        usagePercent: 12.5,
        percentRemaining: 87.5,
        resetTimeIso: "2026-08-12T12:30:00.000Z",
      },
      weekly: {
        status: "ok",
        usagePercent: 45,
        percentRemaining: 55,
        resetTimeIso: "2026-08-16T16:00:00.000Z",
      },
      monthly: {
        status: "ok",
        usagePercent: 80,
        percentRemaining: 20,
        resetTimeIso: "2026-09-01T04:00:00.000Z",
      },
    });
  });

  it("accepts 0 and 100 percent plus valid past timestamps", async () => {
    const payload = validPayload();
    windowFrom(payload, "rolling").percent = 0;
    windowFrom(payload, "rolling").resetsAt = "2020-01-01T00:00:00Z";
    windowFrom(payload, "weekly").percent = 100;
    mockSuccess(payload);

    const result = await queryOpenCodeGoQuota("token");

    expect(result).toMatchObject({
      success: true,
      rolling: { usagePercent: 0, percentRemaining: 100 },
      weekly: { usagePercent: 100, percentRemaining: 0 },
    });
  });

  it("accepts a rate-limited window as a valid exhausted state", async () => {
    const payload = validPayload();
    windowFrom(payload, "monthly").status = "rate-limited";
    windowFrom(payload, "monthly").percent = 100;
    mockSuccess(payload);

    const result = await queryOpenCodeGoQuota("token");

    expect(result).toMatchObject({
      success: true,
      monthly: { status: "rate-limited", usagePercent: 100, percentRemaining: 0 },
    });
  });

  it.each([null, [], "bad", 1])("rejects a non-object root: %j", async (payload) => {
    mockSuccess(payload);
    await expect(queryOpenCodeGoQuota("token")).resolves.toEqual({
      success: false,
      error: "Invalid OpenCode Go API response: root must be an object",
    });
  });

  it.each([null, [], "bad", 1])("rejects a non-object usage value: %j", async (usage) => {
    mockSuccess({ usage });
    await expect(queryOpenCodeGoQuota("token")).resolves.toEqual({
      success: false,
      error: "Invalid OpenCode Go API response: usage must be an object",
    });
  });

  it.each(["rolling", "weekly", "monthly"] as const)("requires the %s window", async (window) => {
    const payload = validPayload();
    delete (payload.usage as Record<string, unknown>)[window];
    mockSuccess(payload);

    await expect(queryOpenCodeGoQuota("token")).resolves.toEqual({
      success: false,
      error: `Invalid OpenCode Go API response: ${window} window is missing or malformed`,
    });
  });

  it.each([
    "OK",
    " ok",
    "ok ",
    "error",
    null,
    1,
  ])("requires exact raw status ok: %j", async (status) => {
    const payload = validPayload();
    windowFrom(payload, "weekly").status = status;
    mockSuccess(payload);

    const result = await queryOpenCodeGoQuota("token");
    expect(result).toMatchObject({ success: false });
    expect(result).toHaveProperty(
      "error",
      expect.stringContaining("Invalid OpenCode Go API response: weekly status is not ok"),
    );
  });

  it.each([
    -1,
    101,
    "10",
    null,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("rejects invalid percent %j", async (percent) => {
    const payload = validPayload();
    windowFrom(payload, "monthly").percent = percent;
    mockSuccess(payload);

    await expect(queryOpenCodeGoQuota("token")).resolves.toEqual({
      success: false,
      error:
        "Invalid OpenCode Go API response: monthly percent must be a finite number from 0 to 100",
    });
  });

  it.each([
    "2026-08-12",
    "2026-08-12T12:30:00",
    "Wed, 12 Aug 2026 12:30:00 GMT",
    "2026-08-12T12:30:00+0200",
    "2026-02-30T00:00:00Z",
    "2025-02-29T00:00:00Z",
    "not-a-date",
    null,
  ])("rejects non-offset-qualified resetsAt %j", async (resetsAt) => {
    const payload = validPayload();
    windowFrom(payload, "rolling").resetsAt = resetsAt;
    mockSuccess(payload);

    const result = await queryOpenCodeGoQuota("token");
    expect(result).toEqual({
      success: false,
      error:
        "Invalid OpenCode Go API response: rolling resetsAt must be an offset-qualified ISO timestamp",
    });
  });

  it("returns a stable malformed JSON error with token redaction", async () => {
    const token = "distinctive-secret-token";
    mocks.fetchResponse.mockResolvedValueOnce({
      ok: true,
      json: vi
        .fn()
        .mockRejectedValue(new SyntaxError(`Unexpected ${token}\nend ${token} of JSON input`)),
    });

    const result = await queryOpenCodeGoQuota(token);

    expect(JSON.stringify(result)).not.toContain(token);
    expect(result).toEqual({
      success: false,
      error:
        "Invalid OpenCode Go API response: body is not valid JSON: Unexpected [redacted] end [redacted] of JSON input",
    });
  });

  it("redacts repeated tokens before sanitizing and bounding HTTP bodies", async () => {
    const token = "distinctive-secret-token";
    mockHttpFailure(401, `\u001b[31m${token}\n${"x".repeat(140)} ${token}\u001b[0m`);

    const result = await queryOpenCodeGoQuota(token);

    expect(result).toMatchObject({ success: false, retryable: false });
    expect(JSON.stringify(result)).not.toContain(token);
    expect((result as { error: string }).error).toContain("OpenCode Go API error 401: [redacted]");
    expect((result as { error: string }).error.length).toBeLessThanOrEqual(
      "OpenCode Go API error 401: ".length + 120,
    );
  });

  it("retains the HTTP status when reading a non-success body fails", async () => {
    const token = "distinctive-secret-token";
    mocks.fetchResponse.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: vi
        .fn()
        .mockRejectedValue(new Error(`body ${token}\n${"x".repeat(140)} ${token} failed`)),
    });

    const result = await queryOpenCodeGoQuota(token);

    expect(result).toMatchObject({ success: false, retryable: true });
    expect(JSON.stringify(result)).not.toContain(token);
    expect((result as { error: string }).error).toContain(
      "OpenCode Go API error 503: body [redacted]",
    );
    expect((result as { error: string }).error.length).toBeLessThanOrEqual(
      "OpenCode Go API error 503: ".length + 120,
    );
  });

  it.each(["network", "body"])("redacts tokens from %s failures", async (failure) => {
    const token = "distinctive-secret-token";
    if (failure === "network") {
      mocks.fetchResponse.mockRejectedValueOnce(new Error(`failed ${token} twice ${token}`));
    } else {
      mocks.fetchResponse.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: vi.fn().mockRejectedValue(new Error(`body ${token} failed`)),
      });
    }

    const result = await queryOpenCodeGoQuota(token);

    expect(result).toMatchObject({ success: false, retryable: true });
    expect(JSON.stringify(result)).not.toContain(token);
    expect((result as { error: string }).error).toContain("[redacted]");
  });

  it("redacts a token returned as a remote window status", async () => {
    const token = "distinctive-secret-token";
    const payload = validPayload();
    windowFrom(payload, "rolling").status = `${token}\nretry`;
    mockSuccess(payload);

    const result = await queryOpenCodeGoQuota(token);

    expect(JSON.stringify(result)).not.toContain(token);
    expect(result).toEqual({
      success: false,
      error: "Invalid OpenCode Go API response: rolling status is not ok: [redacted] retry",
    });
  });
});
