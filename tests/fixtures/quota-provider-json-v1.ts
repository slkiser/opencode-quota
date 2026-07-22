import type { JsonV1Adapter } from "../../src/lib/quota-providers.js";

export const NEURALWATT_LIKE_ADAPTER = {
  rowsPath: ["data", "plans"],
  mappings: [
    {
      resultType: "quota",
      name: "Tokens",
      label: "Used:",
      unit: "tokens",
      unitPosition: "suffix",
      resetTime: { path: ["reset_at"], encoding: "iso-8601" },
      observedTime: { path: ["observed_at"], encoding: "unix-seconds" },
      metric: {
        type: "used-limit",
        used: { path: ["used_milli"], divideBy: 1_000 },
        limit: { path: ["limit"] },
      },
    },
    {
      resultType: "rate_limit",
      name: "Requests",
      unit: "req",
      unitPosition: "suffix",
      metric: {
        type: "remaining-limit",
        remaining: { path: ["requests_remaining"] },
        limit: { path: ["requests_limit"] },
      },
    },
    {
      resultType: "budget",
      name: "Used percent",
      metric: {
        type: "percentage",
        percentage: { path: ["used_percent"] },
        meaning: "used",
      },
    },
    {
      resultType: "budget",
      name: "Spend budget",
      unit: "$",
      unitPosition: "prefix",
      metric: {
        type: "spend-budget",
        spend: { path: ["spend"] },
        budget: { path: ["budget"] },
      },
    },
    {
      resultType: "budget",
      name: "Remaining budget",
      unit: "$",
      unitPosition: "prefix",
      metric: {
        type: "remaining-budget",
        remaining: { path: ["budget_remaining"] },
        budget: { path: ["budget"] },
      },
    },
    {
      resultType: "balance",
      name: "Balance",
      unit: "$",
      unitPosition: "prefix",
      metric: {
        type: "value",
        valueType: "balance",
        value: { path: ["balance"] },
      },
    },
    {
      resultType: "spend",
      name: "Spend",
      unit: "$",
      unitPosition: "prefix",
      metric: {
        type: "value",
        valueType: "spend",
        value: { path: ["spend"] },
      },
    },
    {
      resultType: "budget",
      name: "Budget",
      unit: "$",
      unitPosition: "prefix",
      metric: {
        type: "value",
        valueType: "budget",
        value: { path: ["budget"] },
      },
    },
    {
      resultType: "status",
      name: "Status",
      metric: {
        type: "status",
        value: { path: ["status"] },
      },
    },
  ],
} satisfies JsonV1Adapter;

export const NEURALWATT_LIKE_RESPONSE = {
  data: {
    plans: [
      {
        used_milli: 0,
        limit: 10,
        requests_remaining: 100,
        requests_limit: 100,
        used_percent: 0,
        spend: 0,
        budget: 25,
        budget_remaining: 25,
        balance: -3.5,
        status: " Ready ",
        reset_at: "2026-08-01T00:00:00+02:00",
        observed_at: 1_784_678_400,
      },
      {
        used_milli: 12_000,
        limit: 10,
        requests_remaining: -5,
        requests_limit: 100,
        used_percent: 125,
        spend: 30,
        budget: 25,
        budget_remaining: -5,
        balance: 0,
        status: "Over quota",
        reset_at: "2026-08-02T00:00:00Z",
        observed_at: 1_784_764_800,
      },
      {
        used_milli: null,
        limit: 10,
        requests_remaining: 5,
        requests_limit: null,
        spend: "redacted",
        budget: 25,
        budget_remaining: 20,
        balance: null,
        status: "Partial",
        reset_at: "not-a-timestamp",
        observed_at: 1_784_764_800,
      },
      "malformed-row",
    ],
  },
} as const;
