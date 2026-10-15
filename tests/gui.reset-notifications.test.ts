import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { ResetNotificationRuntime } from "../src/gui/reset-notification-runtime.js";
import { deliverResetToast } from "../src/lib/reset-notification-delivery.js";
const native = vi.hoisted(() => ({ supported: true, mode: "show", notices: [] as any[] }));
vi.mock("electron", () => ({
  Notification: class extends EventEmitter {
    static isSupported() {
      return native.supported;
    }
    constructor(public options: any) {
      super();
      native.notices.push(this);
    }
    show() {
      if (native.mode !== "silent") this.emit(native.mode);
    }
    close() {
      this.emit("close");
    }
  },
}));
import { showNativeResetNotification } from "../src/gui/native-reset-notification.js";
const event = {
  id: "a".repeat(64),
  providerId: "openai",
  windowId: "weekly",
  accountIdentity: "b".repeat(64),
  rowId: "quota",
  label: "Weekly",
  previousResetAt: 1,
  resetAt: 10,
  observedAt: 2,
  previousRemaining: 20,
  percentRemaining: 100,
};
const config = {
  enabled: true,
  preferDesktop: true,
  watched: [{ providerId: "openai", windowId: "weekly" }],
};
afterEach(() => {
  vi.useRealTimers();
  native.supported = true;
  native.mode = "show";
  native.notices = [];
});
describe("reset notification channels", () => {
  it("acknowledges show, handles click and fails safely for denied/unsupported delivery", async () => {
    const open = vi.fn();
    expect(await showNativeResetNotification(event, open)).toBe("shown");
    native.notices[0].emit("click");
    expect(open).toHaveBeenCalledWith(event);
    expect(native.notices[0].options.body).toContain("100% remaining");
    native.mode = "failed";
    expect(await showNativeResetNotification(event, open)).toBe("failed");
    native.supported = false;
    expect(await showNativeResetNotification(event, open)).toBe("failed");
  });
  it("leaves unacknowledged OS delivery uncertain rather than retrying automatically", async () => {
    vi.useFakeTimers();
    native.mode = "silent";
    const result = showNativeResetNotification(event, vi.fn());
    await vi.advanceTimersByTimeAsync(10000);
    expect(await result).toBe("uncertain");
  });
  it("does not consume rejected or HTTP-error toast responses", async () => {
    expect(await deliverResetToast(event, async () => ({ error: { message: "denied" } }))).toBe(
      false,
    );
    expect(
      await deliverResetToast(event, async () => {
        throw new Error("offline");
      }),
    ).toBe(false);
    const show = vi.fn(async () => ({ data: true }));
    expect(await deliverResetToast(event, show)).toBe(true);
    expect(show.mock.calls[0][0].body.message).toContain("openai / weekly");
  });
  it("keeps default-off idle and blocks overlapping deliveries", async () => {
    const helper = { request: vi.fn(), dispose: vi.fn() };
    const off = new ResetNotificationRuntime({
      config: () => ({ ...config, enabled: false }),
      supported: () => true,
      deliver: vi.fn(),
      helper,
    });
    off.start();
    await off.tick();
    off.dispose();
    expect(helper.request).not.toHaveBeenCalled();
    let finish!: (value: "shown") => void;
    helper.request.mockImplementation(async (request: any) =>
      request.operation === "reset-claim" ? [{ event, leaseToken: "token" }] : true,
    );
    const deliver = vi.fn(
      () =>
        new Promise<"shown">((resolve) => {
          finish = resolve;
        }),
    );
    const runtime = new ResetNotificationRuntime({
      config: () => config,
      supported: () => true,
      deliver,
      helper,
    });
    const tick = runtime.tick();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    await runtime.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    finish("shown");
    await tick;
    expect(helper.request).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "reset-settle", delivered: true, channel: "desktop" }),
    );
    runtime.dispose();
  });
  it.each(["failed", "uncertain"] as const)(
    "persists %s outcomes without inventing delivery",
    async (outcome) => {
      const helper = {
        request: vi.fn(async (request: any) =>
          request.operation === "reset-claim" ? [{ event, leaseToken: "token" }] : true,
        ),
        dispose: vi.fn(),
      };
      const deliver = vi.fn(async () => outcome);
      const runtime = new ResetNotificationRuntime({
        config: () => config,
        supported: () => true,
        deliver,
        helper,
      });
      await runtime.tick();
      if (outcome === "uncertain")
        expect(helper.request.mock.calls.some(([r]) => r.operation === "reset-settle")).toBe(false);
      else {
        expect(helper.request).toHaveBeenCalledWith(
          expect.objectContaining({ operation: "reset-settle", delivered: false }),
        );
        await runtime.tick();
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(helper.request).toHaveBeenLastCalledWith(
          expect.objectContaining({ operation: "reset-desktop", available: false }),
        );
      }
      runtime.dispose();
    },
  );
});
