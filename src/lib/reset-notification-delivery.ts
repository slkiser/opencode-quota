import type { QuotaResetEvent } from "./quota-reset-transition.js";
import { sanitizeSingleLineDisplaySnippet } from "./display-sanitize.js";

export function resetNotificationText(event: QuotaResetEvent): string {
  return sanitizeSingleLineDisplaySnippet(
    `${event.providerId} / ${event.windowId}: quota replenished (${event.percentRemaining}% remaining).`,
    500,
  );
}
/** A resolved call can still contain an SDK HTTP error. Never consume that event. */
export async function deliverResetToast(
  event: QuotaResetEvent,
  showToast: (params: {
    body: { title: string; message: string; variant: "success"; duration: number };
  }) => Promise<unknown>,
): Promise<boolean> {
  try {
    const result = await showToast({
      body: {
        title: "Quota reset",
        message: resetNotificationText(event),
        variant: "success",
        duration: 9000,
      },
    });
    return !(
      result &&
      typeof result === "object" &&
      "error" in result &&
      result.error !== undefined &&
      result.error !== null
    );
  } catch {
    return false;
  }
}
