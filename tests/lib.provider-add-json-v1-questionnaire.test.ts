import { describe, expect, it, vi } from "vitest";

import { promptJsonV1Adapter } from "../src/lib/provider-add-json-v1-questionnaire.js";
import { validateQuotaProviders, type JsonV1Metric } from "../src/lib/quota-providers.js";

function createPrompts(answers: unknown[], cancel: unknown = Symbol("cancel")) {
  const remaining = [...answers];
  const take = vi.fn(async () => remaining.shift());
  return {
    cancel,
    remaining,
    prompts: {
      select: vi.fn(() => take()),
      text: vi.fn(() => take()),
      confirm: vi.fn(() => take()),
      isCancel: (value: unknown) => value === cancel,
    },
  };
}

function singleMappingAnswers(params: {
  resultType: string;
  metricAnswers: unknown[];
  unitAllowed: boolean;
}): unknown[] {
  return [
    false,
    params.resultType,
    "Metric",
    "",
    ...params.metricAnswers,
    ...(params.unitAllowed ? [""] : []),
    false,
    false,
    false,
  ];
}

describe("json-v1 provider-add questionnaire", () => {
  it.each<{
    name: string;
    resultType: string;
    metricAnswers: unknown[];
    unitAllowed: boolean;
    expected: JsonV1Metric;
  }>([
    {
      name: "remaining percentage",
      resultType: "quota",
      metricAnswers: ["percentage", "remaining", "literal", "25"],
      unitAllowed: false,
      expected: {
        type: "percentage",
        meaning: "remaining",
        percentage: { literal: 25 },
      },
    },
    {
      name: "used and limit",
      resultType: "rate_limit",
      metricAnswers: ["used-limit", "literal", "2", "literal", "10"],
      unitAllowed: true,
      expected: {
        type: "used-limit",
        used: { literal: 2 },
        limit: { literal: 10 },
      },
    },
    {
      name: "remaining and limit",
      resultType: "quota",
      metricAnswers: ["remaining-limit", "literal", "8", "literal", "10"],
      unitAllowed: true,
      expected: {
        type: "remaining-limit",
        remaining: { literal: 8 },
        limit: { literal: 10 },
      },
    },
    {
      name: "spend and budget",
      resultType: "budget",
      metricAnswers: ["spend-budget", "literal", "2", "literal", "10"],
      unitAllowed: true,
      expected: {
        type: "spend-budget",
        spend: { literal: 2 },
        budget: { literal: 10 },
      },
    },
    {
      name: "remaining and budget",
      resultType: "budget",
      metricAnswers: ["remaining-budget", "literal", "8", "literal", "10"],
      unitAllowed: true,
      expected: {
        type: "remaining-budget",
        remaining: { literal: 8 },
        budget: { literal: 10 },
      },
    },
    {
      name: "used value including literal zero",
      resultType: "usage",
      metricAnswers: ["literal", "0"],
      unitAllowed: true,
      expected: { type: "value", valueType: "used", value: { literal: 0 } },
    },
    {
      name: "limit value",
      resultType: "quota",
      metricAnswers: ["value-limit", "literal", "10"],
      unitAllowed: true,
      expected: { type: "value", valueType: "limit", value: { literal: 10 } },
    },
    {
      name: "remaining value",
      resultType: "quota",
      metricAnswers: ["value-remaining", "literal", "-1"],
      unitAllowed: true,
      expected: { type: "value", valueType: "remaining", value: { literal: -1 } },
    },
    {
      name: "balance value",
      resultType: "balance",
      metricAnswers: ["literal", "-1"],
      unitAllowed: true,
      expected: { type: "value", valueType: "balance", value: { literal: -1 } },
    },
    {
      name: "spend value",
      resultType: "spend",
      metricAnswers: ["literal", "12.5"],
      unitAllowed: true,
      expected: { type: "value", valueType: "spend", value: { literal: 12.5 } },
    },
    {
      name: "budget value",
      resultType: "budget",
      metricAnswers: ["value-budget", "literal", "50"],
      unitAllowed: true,
      expected: { type: "value", valueType: "budget", value: { literal: 50 } },
    },
    {
      name: "status text",
      resultType: "status",
      metricAnswers: ["literal", "Available"],
      unitAllowed: false,
      expected: { type: "status", value: { literal: "Available" } },
    },
  ])("constructs the existing $name metric shape", async (params) => {
    const { prompts, remaining } = createPrompts(singleMappingAnswers(params));

    const result = await promptJsonV1Adapter(prompts);

    expect(result).toEqual({
      state: "complete",
      adapter: {
        mappings: [
          {
            resultType: params.resultType,
            name: "Metric",
            metric: params.expected,
          },
        ],
      },
    });
    expect(remaining).toEqual([]);
  });

  it("constructs nested paths, divisors, units, timestamps, and stable mapping order", async () => {
    const { prompts, remaining } = createPrompts([
      true,
      "data",
      true,
      "plans",
      false,
      "quota",
      "Requests",
      "Daily:",
      "remaining-limit",
      "path",
      "remaining",
      false,
      "1000",
      "literal",
      "100",
      "requests",
      "suffix",
      true,
      "path",
      "unix-seconds",
      "reset_at",
      false,
      true,
      "literal",
      "unix-milliseconds",
      "0",
      true,
      "status",
      "Status",
      "",
      "path",
      "state",
      false,
      false,
      false,
      false,
    ]);

    const result = await promptJsonV1Adapter(prompts);

    expect(result).toEqual({
      state: "complete",
      adapter: {
        rowsPath: ["data", "plans"],
        mappings: [
          {
            resultType: "quota",
            name: "Requests",
            label: "Daily:",
            unit: "requests",
            unitPosition: "suffix",
            resetTime: { path: ["reset_at"], encoding: "unix-seconds" },
            observedTime: { literal: 0, encoding: "unix-milliseconds" },
            metric: {
              type: "remaining-limit",
              remaining: { path: ["remaining"], divideBy: 1000 },
              limit: { literal: 100 },
            },
          },
          {
            resultType: "status",
            name: "Status",
            metric: { type: "status", value: { path: ["state"] } },
          },
        ],
      },
    });
    expect(remaining).toEqual([]);
  });

  it("stops automatically at the existing path and mapping maximums", async () => {
    const answers: unknown[] = [true];
    for (let index = 0; index < 8; index += 1) {
      answers.push(`row-${index + 1}`);
      if (index < 7) answers.push(true);
    }
    for (let index = 0; index < 16; index += 1) {
      answers.push("status", `Status ${index + 1}`, "", "literal", `ok-${index + 1}`, false, false);
      if (index < 15) answers.push(true);
    }
    const { prompts, remaining } = createPrompts(answers);

    const result = await promptJsonV1Adapter(prompts);

    expect(result.state).toBe("complete");
    if (result.state !== "complete") throw new Error("questionnaire was cancelled");
    expect(result.adapter.rowsPath).toEqual([
      "row-1",
      "row-2",
      "row-3",
      "row-4",
      "row-5",
      "row-6",
      "row-7",
      "row-8",
    ]);
    expect(result.adapter.mappings).toHaveLength(16);
    expect(result.adapter.mappings.map((mapping) => mapping.name)).toEqual(
      Array.from({ length: 16 }, (_, index) => `Status ${index + 1}`),
    );
    expect(remaining).toEqual([]);
  });

  it.each([
    {
      name: "nested path",
      answers: (cancel: unknown) => [true, cancel],
    },
    {
      name: "metric source",
      answers: (cancel: unknown) => [false, "usage", "Usage", "", cancel],
    },
    {
      name: "timestamp",
      answers: (cancel: unknown) => [
        false,
        "status",
        "Status",
        "",
        "literal",
        "Available",
        true,
        cancel,
      ],
    },
    {
      name: "add-another prompt",
      answers: (cancel: unknown) => [
        false,
        "status",
        "Status",
        "",
        "literal",
        "Available",
        false,
        false,
        cancel,
      ],
    },
    {
      name: "empty required answer",
      answers: () => [true, ""],
    },
  ])("returns cancellation for $name without constructing an adapter", async ({ answers }) => {
    const cancel = Symbol("cancel");
    const { prompts } = createPrompts(answers(cancel), cancel);

    await expect(promptJsonV1Adapter(prompts)).resolves.toEqual({ state: "cancelled" });
  });

  it("leaves unsafe path rejection and redacted diagnostics to the established validator", async () => {
    const { prompts } = createPrompts([
      false,
      "usage",
      "do-not-echo",
      "",
      "path",
      "__proto__",
      false,
      "none",
      "",
      false,
      false,
      false,
    ]);
    const result = await promptJsonV1Adapter(prompts);
    expect(result.state).toBe("complete");
    if (result.state !== "complete") throw new Error("questionnaire was cancelled");

    const validation = validateQuotaProviders([
      {
        id: "private-gateway",
        mode: "remote-api",
        url: "https://gateway.example/quota",
        format: "json-v1",
        adapter: result.adapter,
      },
    ]);

    expect(validation.value).toBeUndefined();
    expect(validation.issues).toContainEqual(
      expect.objectContaining({
        key: "quotaProviders[0].adapter.mappings[0].metric.value.path[0]",
        message: "expected a safe 1-64 code point property segment",
      }),
    );
    expect(JSON.stringify(validation.issues)).not.toContain("do-not-echo");
  });
});
