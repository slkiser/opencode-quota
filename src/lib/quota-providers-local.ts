// Fork adaptation of upstream completion-authoritative local estimates (5e23f3a / 2733b5b).
import { createHash } from "node:crypto";
import type { AccountingRow } from "./accounting.js";
import { accountingQuantityFromNumber, projectAccountingToLegacy } from "./accounting.js";
import type { QuotaProviderResult } from "./entries.js";
import type { LocalQuotaDefinition, LocalQuotaWindow } from "./quota-provider-definitions.js";
import { iterCompletedAssistantMessages, type OpenCodeMessage } from "./opencode-storage.js";
import { iterClaudeCodeCliMessages } from "./claude-code-cli-storage.js";
import { iterCodexCliMessages } from "./codex-cli-storage.js";
import { resolvePricingKey } from "./quota-stats.js";
import { lookupCost, type CostBuckets } from "./modelsdev-pricing.js";
import { mergeUserCostSync } from "./user-pricing.js";
import { tokenBucketsFromMessage, type TokenBuckets } from "./token-buckets.js";
import { calculateUsdFromTokenBuckets } from "./token-cost.js";
import { sanitizeSingleLineDisplaySnippet as clean } from "./display-sanitize.js";
import type { ResetDatabase } from "../dashboard/reset-events.js";
const DAY = 86400000;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const validTokens = (v: unknown): v is TokenBuckets =>
  !!v &&
  typeof v === "object" &&
  ["input", "output", "reasoning", "cache_read", "cache_write"].every(
    (key) => Number.isSafeInteger((v as any)[key]) && (v as any)[key] >= 0,
  );
export function localWindowSince(window: LocalQuotaWindow, now: number): number {
  return window.type === "utc-day"
    ? Math.floor(now / DAY) * DAY
    : now - window.durationMinutes! * 60000;
}
function price(
  provider: string,
  model: string,
  tokens: TokenBuckets,
  map?: Record<string, string>,
): number | null {
  const resolution = resolvePricingKey({ providerID: provider, modelID: model });
  const fallback = map && Object.hasOwn(map, model) ? map[model] : undefined;
  const slash = fallback?.indexOf("/") ?? -1;
  const key = resolution.ok
    ? resolution.key
    : slash > 0
      ? { provider: fallback!.slice(0, slash), model: fallback!.slice(slash + 1) }
      : null;
  if (!key) return null;
  const rates = mergeUserCostSync(key.provider, key.model, lookupCost(key.provider, key.model));
  if (!rates) return null;
  const effective: CostBuckets = {
    ...rates,
    cache_read: rates.cache_read ?? rates.input,
    cache_write: rates.cache_write ?? rates.input,
    reasoning: rates.reasoning ?? rates.output,
  };
  if (
    (Object.keys(tokens) as Array<keyof TokenBuckets>).some(
      (bucket) =>
        tokens[bucket] > 0 &&
        (typeof effective[bucket] !== "number" ||
          !Number.isFinite(effective[bucket]) ||
          effective[bucket]! < 0),
    )
  )
    return null;
  const cost = calculateUsdFromTokenBuckets(effective, tokens);
  return Number.isFinite(cost) && cost >= 0 ? cost : null;
}
export interface LocalEstimateDependencies {
  readOpenCode?: typeof iterCompletedAssistantMessages;
  readClaude?: typeof iterClaudeCodeCliMessages;
  readCodex?: typeof iterCodexCliMessages;
  price?: (
    provider: string,
    model: string,
    tokens: TokenBuckets,
    map?: Record<string, string>,
  ) => number | null;
}
function sourceTokens(message: OpenCodeMessage, source: string): TokenBuckets | null {
  if (source === "claude-cli" && message.usageComplete !== true) return null;
  if (
    !message.tokens ||
    !message.tokens.cache ||
    ![
      message.tokens.input,
      message.tokens.output,
      message.tokens.cache.read,
      message.tokens.cache.write,
    ].every((n) => Number.isSafeInteger(n) && n >= 0)
  )
    return null;
  const tokens = tokenBucketsFromMessage(message);
  return validTokens(tokens) ? tokens : null;
}
function base(
  def: LocalQuotaDefinition,
  window: LocalQuotaWindow,
  id: string,
  name: string,
  now: number,
): AccountingRow {
  return {
    id,
    name: clean(`${def.label} ${window.label} ${name}`, 250),
    group: clean(def.label, 80),
    resultType: "quota",
    prominence: "primary",
    source: {
      id: def.id,
      acquisitionMethod: "local_estimation",
      ownership: "user_configured",
      authority: "locally_derived",
    },
    account: { kind: "unknown" },
    freshness: { kind: "observed", observedAtIso: new Date(now).toISOString() },
    window:
      window.type === "utc-day"
        ? {
            kind: "fixed",
            id: window.id,
            startedAtIso: new Date(localWindowSince(window, now)).toISOString(),
            endsAtIso: new Date(localWindowSince(window, now) + DAY).toISOString(),
            fullReset: true,
          }
        : { kind: "rolling", id: window.id, durationMs: window.durationMinutes! * 60000 },
    value: { kind: "status", status: "unknown" },
  };
}
export async function syncLocalQuotaEstimate(
  db: ResetDatabase,
  def: LocalQuotaDefinition,
  now = Date.now(),
  deps: LocalEstimateDependencies = {},
): Promise<QuotaProviderResult> {
  if (!Number.isFinite(now) || now < 0 || now > 8640000000000000)
    throw new Error("Invalid local evaluation time");
  const since = Math.min(...def.windows.map((window) => localWindowSince(window, now)));
  const errors: Array<{ label: string; message: string }> = [];
  const batches = await Promise.all(
    def.sources.map(async (source) => {
      try {
        const messages =
          source === "opencode"
            ? await (deps.readOpenCode ?? iterCompletedAssistantMessages)({
                completedSinceMs: since,
                completedUntilMs: now,
                providerID: def.providerId,
              })
            : source === "claude-cli"
              ? await (deps.readClaude ?? iterClaudeCodeCliMessages)({
                  sinceMs: since,
                  untilMs: now,
                  strictReads: true,
                  completionEvents: true,
                })
              : await (deps.readCodex ?? iterCodexCliMessages)({
                  sinceMs: since,
                  untilMs: now,
                  strictReads: true,
                });
        if (messages.length > 100000) throw new Error("Local source limit exceeded");
        return { source, messages };
      } catch {
        errors.push({
          label: clean(def.label, 80),
          message: `Local ${source} source unavailable; estimates incomplete`,
        });
        return { source, messages: [] as OpenCodeMessage[] };
      }
    }),
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM custom_estimate_events WHERE definition_id=? AND completed_at<?").run(
      def.id,
      since - DAY,
    );
    for (const { source, messages } of batches) {
      const unique = new Map<string, OpenCodeMessage>();
      for (const message of messages) {
        const at = source === "opencode" ? message.time?.completed : message.time?.created;
        if (
          message.role !== "assistant" ||
          message.providerID !== def.providerId ||
          !Number.isFinite(at) ||
          at! < since ||
          at! > now ||
          typeof message.id !== "string" ||
          !message.id
        )
          continue;
        if (def.modelIds && !def.modelIds.includes(message.modelID ?? "")) continue;
        const previous = unique.get(message.id);
        if (previous?.usageComplete === true && message.usageComplete !== true) continue;
        if (previous && (previous.time?.completed ?? previous.time?.created ?? 0) > (at ?? 0))
          continue;
        unique.set(message.id, message);
      }
      const aliases = new Map<string, string>();
      for (const message of unique.values()) {
        const key = hash([source, message.id]);
        const saved = db
          .prepare(
            "SELECT event_id FROM custom_estimate_aliases WHERE definition_id=? AND source=? AND message_key=?",
          )
          .get(def.id, source, key);
        if (saved) aliases.set(key, saved.event_id);
      }
      const reserved = new Set(aliases.values()),
        claimed = new Set<string>();
      const groups = new Map<string, string[]>();
      // Reserve known identities before assigning changed canonical copies. A new
      // genuine repeat must not steal a known completion's multiplicity slot.
      for (const message of [...unique.values()].sort(
        (a, b) =>
          Number(aliases.has(hash([source, b.id]))) - Number(aliases.has(hash([source, a.id]))) ||
          (a.time?.created ?? 0) - (b.time?.created ?? 0) ||
          a.id.localeCompare(b.id),
      )) {
        const at = (source === "opencode" ? message.time?.completed : message.time?.created)!;
        const model =
          typeof message.modelID === "string" && message.modelID.length <= 200
            ? clean(message.modelID, 200)
            : "unknown";
        const messageKey = hash([source, message.id]);
        const fingerprint =
          source === "opencode"
            ? hash([source, message.time?.created ?? at, at, def.providerId, model])
            : messageKey;
        let candidates = groups.get(fingerprint);
        if (!candidates) {
          candidates = db
            .prepare(
              "SELECT event_id FROM custom_estimate_events WHERE definition_id=? AND source=? AND fingerprint=? ORDER BY event_id",
            )
            .all(def.id, source, fingerprint)
            .map((item) => item.event_id);
          groups.set(fingerprint, candidates!);
        }
        let eventId =
          aliases.get(messageKey) ??
          candidates!.find((id) => !claimed.has(id) && !reserved.has(id));
        if (!eventId) {
          let ordinal = candidates!.length;
          do {
            eventId = hash([fingerprint, ordinal++]);
            if (ordinal > 200001) throw new Error("Local identity limit exceeded");
          } while (
            db
              .prepare(
                "SELECT 1 FROM custom_estimate_events WHERE definition_id=? AND source=? AND event_id=?",
              )
              .get(def.id, source, eventId)
          );
          candidates!.push(eventId);
        }
        claimed.add(eventId);
        if (typeof eventId !== "string" || !/^[a-f0-9]{64}$/u.test(eventId))
          throw new Error("Corrupt local event identity");
        const tokens = sourceTokens(message, source);
        const existing = db
          .prepare(
            "SELECT tokens FROM custom_estimate_events WHERE definition_id=? AND source=? AND event_id=?",
          )
          .get(def.id, source, eventId);
        // A late partial stream record cannot erase already verified final usage.
        if (source !== "opencode" && !tokens && existing?.tokens) continue;
        db.prepare(
          `INSERT INTO custom_estimate_events(definition_id,source,event_id,fingerprint,completed_at,provider_id,model_id,tokens) VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(definition_id,source,event_id) DO UPDATE SET fingerprint=excluded.fingerprint,completed_at=excluded.completed_at,provider_id=excluded.provider_id,model_id=excluded.model_id,tokens=excluded.tokens`,
        ).run(
          def.id,
          source,
          eventId,
          fingerprint,
          at,
          def.providerId,
          model,
          tokens ? JSON.stringify(tokens) : null,
        );
        db.prepare(
          "INSERT OR IGNORE INTO custom_estimate_aliases(definition_id,source,message_key,event_id) VALUES(?,?,?,?)",
        ).run(def.id, source, messageKey, eventId);
      }
    }
    db.prepare(
      `DELETE FROM custom_estimate_aliases WHERE definition_id=? AND NOT EXISTS(SELECT 1 FROM custom_estimate_events e WHERE e.definition_id=custom_estimate_aliases.definition_id AND e.source=custom_estimate_aliases.source AND e.event_id=custom_estimate_aliases.event_id)`,
    ).run(def.id);
    if (
      db
        .prepare("SELECT count(*) AS n FROM custom_estimate_events WHERE definition_id=?")
        .get(def.id).n > 200000 ||
      db
        .prepare("SELECT count(*) AS n FROM custom_estimate_aliases WHERE definition_id=?")
        .get(def.id).n > 400000
    )
      throw new Error("Local journal limit exceeded");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const journal = db
    .prepare("SELECT * FROM custom_estimate_events WHERE definition_id=?")
    .all(def.id);
  for (const event of journal)
    if (
      !["opencode", "claude-cli", "codex-cli"].includes(event.source) ||
      !Number.isFinite(event.completed_at) ||
      event.completed_at < 0 ||
      typeof event.event_id !== "string" ||
      !/^[a-f0-9]{64}$/u.test(event.event_id) ||
      typeof event.model_id !== "string" ||
      typeof event.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/u.test(event.fingerprint) ||
      typeof event.provider_id !== "string"
    )
      throw new Error("Local journal unavailable");
  const eligible = journal.filter(
    (event) =>
      def.sources.includes(event.source) &&
      event.provider_id === def.providerId &&
      event.completed_at >= since &&
      event.completed_at <= now &&
      (!def.modelIds || def.modelIds.includes(event.model_id)),
  );
  const priced = eligible.map((event) => {
    let tokens: unknown;
    try {
      tokens = event.tokens ? JSON.parse(event.tokens) : null;
    } catch {
      tokens = null;
    }
    const cost = validTokens(tokens)
      ? (deps.price ?? price)(event.provider_id, event.model_id, tokens, def.pricingModelMap)
      : null;
    return {
      ...event,
      cost: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null,
    };
  });
  const rows: AccountingRow[] = [];
  for (const window of def.windows) {
    const selected = priced.filter((event) => event.completed_at >= localWindowSince(window, now));
    const count = selected.length;
    const requests = base(def, window, `${window.id}-requests`, "observed request estimate", now);
    const limit = {
      quantity: {
        decimal: String(window.requestLimit),
        unit: { kind: "count" as const, unit: "request" as const },
      },
      authority: "user_configured" as const,
    };
    requests.value = {
      kind: "percent",
      remaining: errors.length ? null : 100 - (count / window.requestLimit) * 100,
      basis: {
        limit,
        ...(!errors.length
          ? {
              used: {
                quantity: {
                  decimal: String(count),
                  unit: { kind: "count" as const, unit: "request" as const },
                },
                authority: "locally_derived" as const,
              },
            }
          : {}),
      },
    };
    rows.push(requests);
    if (errors.length)
      rows.push({
        ...base(def, window, `${window.id}-recorded`, "recorded requests (incomplete source)", now),
        prominence: "supplementary",
        value: {
          kind: "quantity",
          quantity: { decimal: String(count), unit: { kind: "count", unit: "request" } },
        },
      });
    if (window.usdBudget !== undefined) {
      const budget = {
        ...base(def, window, `${window.id}-budget`, "local USD budget estimate", now),
        resultType: "budget" as const,
      };
      const unknown = selected.filter((event) => event.cost === null).length;
      const spent = selected.reduce((sum, event) => sum + (event.cost ?? 0), 0);
      if (
        errors.length ||
        unknown ||
        !Number.isFinite(spent) ||
        !Number.isFinite(100 - (spent / window.usdBudget) * 100)
      )
        budget.value = {
          kind: "status",
          status: "unknown",
          detail: errors.length
            ? "Source incomplete"
            : `Pricing/final usage incomplete for ${unknown} observed requests`,
        };
      else
        budget.value = {
          kind: "percent",
          remaining: 100 - (spent / window.usdBudget) * 100,
          basis: {
            used: {
              quantity: accountingQuantityFromNumber(spent, { kind: "currency", code: "USD" })!,
              authority: "locally_derived",
            },
            limit: {
              quantity: accountingQuantityFromNumber(window.usdBudget, {
                kind: "currency",
                code: "USD",
              })!,
              authority: "user_configured",
            },
          },
        };
      rows.push(budget);
    }
  }
  const accounting = { version: 1 as const, rows };
  return { attempted: true, accounting, entries: projectAccountingToLegacy(accounting), errors };
}
