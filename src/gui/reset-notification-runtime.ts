import { randomUUID } from "node:crypto";
import type { ResetNotificationConfig } from "../lib/types.js";
import type { QuotaResetEvent } from "../lib/quota-reset-transition.js";
import type { ResetClaim } from "../dashboard/reset-events.js";
import { HistoryHelperClient } from "./history-client.js";

export type NoticeOutcome = "shown" | "failed" | "uncertain";
/** Availability renewals and delivery use local history only, never provider requests. */
export class ResetNotificationRuntime {
  private readonly consumerId = `desktop/${randomUUID()}`;
  private readonly helper: Pick<HistoryHelperClient, "request" | "dispose">;
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  private disposed = false;
  private failed = false;
  private advertised = false;
  constructor(
    private readonly options: {
      config: () => ResetNotificationConfig;
      supported: () => boolean;
      deliver: (event: QuotaResetEvent) => Promise<NoticeOutcome>;
      helper?: Pick<HistoryHelperClient, "request" | "dispose">;
      onChange?: () => void;
    },
  ) {
    this.helper = options.helper ?? new HistoryHelperClient();
  }
  start(): void {
    void this.tick();
    this.timer ??= setInterval(() => {
      void this.tick();
    }, 20000);
    this.timer.unref?.();
  }
  async tick(): Promise<void> {
    if (this.disposed || this.busy) return;
    this.busy = true;
    try {
      const config = this.options.config();
      const available =
        config?.enabled && config.watched.length > 0 && !this.failed && this.options.supported();
      // Default-off must not create a DB/helper merely for disabled notifications.
      if (!available && !this.advertised) return;
      await this.helper.request({
        operation: "reset-desktop",
        consumerId: this.consumerId,
        watched: available ? config.watched : [],
        available: Boolean(available),
      });
      this.advertised = Boolean(available);
      if (!available || this.disposed) return;
      const claims = await this.helper.request<ResetClaim[]>({
        operation: "reset-claim",
        ...config,
        maxClaims: 1,
        channel: "desktop",
        consumerId: this.consumerId,
      });
      for (const claim of claims) {
        if (this.disposed) break;
        let outcome: NoticeOutcome;
        try {
          outcome = await this.options.deliver(claim.event);
        } catch {
          outcome = "failed";
        }
        if (outcome === "uncertain") continue; // Lease expiry exposes ambiguity; do not auto-duplicate.
        await this.helper.request({
          operation: "reset-settle",
          id: claim.event.id,
          leaseToken: claim.leaseToken,
          channel: "desktop",
          delivered: outcome === "shown",
        });
        if (outcome === "failed") {
          this.failed = true; // Do not repeatedly attempt a denied/unsupported channel.
          await this.helper.request({
            operation: "reset-desktop",
            consumerId: this.consumerId,
            watched: [],
            available: false,
          });
          this.advertised = false;
          break;
        }
      }
      this.options.onChange?.();
    } catch {
      /* History/helper failure cannot break quota refresh. */
    } finally {
      this.busy = false;
    }
  }
  /** Explicit settings reload is also the user's retry of a failed OS capability. */
  resetCapability(): void {
    this.failed = false;
  }
  status(): string {
    if (!this.options.config()?.enabled)
      return "Reset notifications are disabled in quota-toast.json.";
    if (this.failed)
      return "Desktop delivery failed or was denied; plugin fallback remains available. Reload settings to retry desktop delivery.";
    if (!this.options.supported())
      return "Desktop notifications are unsupported; plugin fallback remains available.";
    return "Desktop delivery is enabled for explicitly watched windows. OS visibility remains subject to system permissions.";
  }
  async events() {
    return this.helper.request<import("../lib/quota-reset-transition.js").StoredResetEvent[]>({
      operation: "reset-events",
    });
  }
  async retry(id: string): Promise<boolean> {
    const changed = await this.helper.request<boolean>({ operation: "reset-retry", id });
    if (changed) {
      this.failed = false;
      await this.tick();
    }
    return changed;
  }
  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.helper.dispose(); // Availability expires within 45s if exit prevents withdrawal.
  }
}
