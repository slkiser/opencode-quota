import { Rpc } from "@opencode/plugin/rpc";
import type { ProviderRow } from "../providers/contract.js";
import { isRecord } from "./json-guards.js";

export type PluginQuotaReader = (providerId: string, signal: AbortSignal) => Promise<unknown>;

export function pluginQuotaRpc(providerId: string) {
  return Rpc.define({
    id: `${providerId}.quota`,
    methods: {
      status: {
        input: { type: "object", properties: {}, additionalProperties: false },
        output: { type: "object", additionalProperties: true },
      },
    },
    events: {},
  });
}

function invalid(): never {
  throw new Error("Invalid plugin quota snapshot");
}

function text(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length <= max &&
    value.trim().length > 0 &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    })
  );
}

function amount(value: string): number {
  const match = /^(\d+(?:\.\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?)([KMB]?)$/i.exec(value.trim());
  if (!match) return invalid();
  const multiplier = { "": 1, K: 1e3, M: 1e6, B: 1e9 }[
    match[2].toUpperCase() as "" | "K" | "M" | "B"
  ];
  return Number(match[1].replaceAll(",", "")) * multiplier;
}

function remaining(bar: string): number {
  const percent = /^(\d+(?:\.\d+)?)%$/.exec(bar.trim());
  if (percent) {
    const used = Number(percent[1]);
    return used <= 100 ? 100 - used : invalid();
  }
  const parts = bar.split("/");
  if (parts.length !== 2) return invalid();
  const used = amount(parts[0]);
  const limit = amount(parts[1]);
  if (limit <= 0 || !Number.isFinite(used) || !Number.isFinite(limit)) return invalid();
  return Math.max(0, (1 - used / limit) * 100);
}

export function decodePluginQuota(snapshot: unknown): ProviderRow[] {
  if (
    !isRecord(snapshot) ||
    !text(snapshot.label, 48) ||
    !Array.isArray(snapshot.groups) ||
    snapshot.groups.length > 8
  )
    return invalid();
  return snapshot.groups.flatMap((group: unknown, index): ProviderRow[] => {
    if (!isRecord(group) || !text(group.title, 48)) return invalid();
    if (!("bar" in group) && text(group.value, 48) && !("resetTime" in group)) {
      return [
        {
          key: `window-${index + 1}`,
          label: group.title,
          type: "status",
          method: "remote_api",
          authority: "provider_reported",
          prominence: "primary",
          text: group.value,
        },
      ];
    }
    if (!text(group.bar, 64) || "value" in group) return invalid();
    const reset = group.resetTime;
    if (
      "resetTime" in group &&
      (typeof reset !== "number" ||
        !Number.isSafeInteger(reset) ||
        reset <= 0 ||
        reset > 253402300799999)
    )
      return invalid();
    return [
      {
        key: `window-${index + 1}`,
        label: group.title,
        type: "quota",
        method: "remote_api",
        authority: "provider_reported",
        prominence: "primary",
        percentRemaining: remaining(group.bar),
        ...(typeof reset === "number" ? { resetsAt: new Date(reset).toISOString() } : {}),
      },
    ];
  });
}
