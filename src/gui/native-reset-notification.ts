import { Notification } from "electron";
import type { QuotaResetEvent } from "../lib/quota-reset-transition.js";
import type { NoticeOutcome } from "./reset-notification-runtime.js";
import { resetNotificationText } from "../lib/reset-notification-delivery.js";
const active = new Set<Notification>();
export function showNativeResetNotification(
  event: QuotaResetEvent,
  open: (event: QuotaResetEvent) => void,
): Promise<NoticeOutcome> {
  if (!Notification.isSupported()) return Promise.resolve("failed");
  return new Promise((resolve) => {
    let notice: Notification;
    try {
      notice = new Notification({ title: "Quota reset", body: resetNotificationText(event) });
    } catch {
      resolve("failed");
      return;
    }
    if (active.size >= 64) {
      const oldest = active.values().next().value;
      oldest?.close();
      if (oldest) active.delete(oldest);
    }
    active.add(notice);
    let settled = false;
    const finish = (outcome: NoticeOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      finish("uncertain");
      notice.close();
      active.delete(notice);
    }, 10000);
    notice.once("show", () => finish("shown"));
    notice.once("failed", () => {
      finish("failed");
      active.delete(notice);
    });
    notice.once("click", () => {
      open(event);
      active.delete(notice);
    });
    notice.once("close", () => {
      finish("uncertain");
      active.delete(notice);
    });
    try {
      notice.show();
    } catch {
      finish("failed");
      active.delete(notice);
    }
  });
}
