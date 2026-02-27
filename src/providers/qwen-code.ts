import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult } from "../lib/entries.js";
import { computeQwenQuota, readQwenLocalQuotaState } from "../lib/qwen-local-quota.js";
import { readAuthFileCached } from "../lib/opencode-auth.js";

const QWEN_AUTH_CACHE_MAX_AGE_MS = 5_000;

type GroupedToastEntry = {
  name: string;
  percentRemaining: number;
  resetTimeIso?: string;
  group?: string;
  label?: string;
  right?: string;
};

function hasQwenOAuthAuth(auth: Awaited<ReturnType<typeof readAuthFileCached>>): boolean {
  const qwen = auth?.["opencode-qwencode-auth"];
  return (
    !!qwen &&
    qwen.type === "oauth" &&
    typeof qwen.access === "string" &&
    qwen.access.trim().length > 0
  );
}

export const qwenCodeProvider: QuotaProvider = {
  id: "qwen-code",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    const auth = await readAuthFileCached({ maxAgeMs: QWEN_AUTH_CACHE_MAX_AGE_MS });
    return hasQwenOAuthAuth(auth);
  },

  matchesCurrentModel(model: string): boolean {
    return model.toLowerCase().startsWith("qwen-code/");
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const auth = await readAuthFileCached({ maxAgeMs: QWEN_AUTH_CACHE_MAX_AGE_MS });
    if (!hasQwenOAuthAuth(auth)) {
      return { attempted: false, entries: [], errors: [] };
    }

    const quota = computeQwenQuota({ state: await readQwenLocalQuotaState() });
    const style = ctx.config.toastStyle ?? "classic";

    if (style === "grouped") {
      const entries: GroupedToastEntry[] = [
        {
          name: "Qwen Daily",
          group: "Qwen (OAuth)",
          label: "Daily:",
          right: `${quota.day.used}/${quota.day.limit}`,
          percentRemaining: quota.day.percentRemaining,
          resetTimeIso: quota.day.resetTimeIso,
        },
        {
          name: "Qwen RPM",
          group: "Qwen (OAuth)",
          label: "RPM:",
          right: `${quota.rpm.used}/${quota.rpm.limit}`,
          percentRemaining: quota.rpm.percentRemaining,
          resetTimeIso: quota.rpm.resetTimeIso,
        },
      ];

      return { attempted: true, entries, errors: [] };
    }

    return {
      attempted: true,
      entries: [
        {
          name: "Qwen Daily",
          percentRemaining: quota.day.percentRemaining,
          resetTimeIso: quota.day.resetTimeIso,
        },
        {
          name: "Qwen RPM",
          percentRemaining: quota.rpm.percentRemaining,
          resetTimeIso: quota.rpm.resetTimeIso,
        },
      ],
      errors: [],
    };
  },
};
