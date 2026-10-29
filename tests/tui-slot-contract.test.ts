import type { CliRenderer } from "@opentui/core";
import { createSlot, createSolidSlotRegistry } from "@opentui/solid";
import type { Setter } from "solid-js";
import { createComponent, createRoot, createSignal } from "solid-js/dist/solid.js";
import { describe, expect, it, vi } from "vite-plus/test";

type RegistrationState = "pending" | "disabled" | "active";
type TestSlots = {
  session_prompt: Record<never, never>;
};

function readSolidOutput(value: unknown): string {
  if (typeof value === "function") return readSolidOutput((value as () => unknown)());
  if (Array.isArray(value)) return value.map(readSolidOutput).join("");
  if (value === null || value === undefined || value === false) return "";
  return String(value);
}

describe("TUI slot host contract", () => {
  it("reactively activates a mounted null host and preserves the replace fallback", () => {
    const renderer = { once: vi.fn() } as unknown as CliRenderer;
    const registry = createSolidSlotRegistry<TestSlots>(renderer, {});
    const Slot = createSlot(registry);
    const [state, setState]: [() => RegistrationState, Setter<RegistrationState>] =
      createSignal<RegistrationState>("pending");
    let registrations = 0;
    let hostRenders = 0;
    let resourceStarts = 0;
    let pluginDisposals = 0;

    registrations += 1;
    const unregister = registry.register({
      id: "quota-test",
      dispose() {
        pluginDisposals += 1;
      },
      slots: {
        session_prompt() {
          hostRenders += 1;
          if (state() !== "active") return null;
          resourceStarts += 1;
          return "quota-prompt";
        },
      },
    });

    let disposeRoot!: () => void;
    const mountedSlot = createRoot((dispose) => {
      disposeRoot = dispose;
      return createComponent(Slot, {
        name: "session_prompt",
        mode: "replace",
        get children() {
          return "native-prompt";
        },
      });
    });

    try {
      expect(readSolidOutput(mountedSlot)).toBe("native-prompt");
      expect(resourceStarts).toBe(0);
      const pendingHostRenders = hostRenders;

      setState("disabled");
      expect(readSolidOutput(mountedSlot)).toBe("native-prompt");
      expect(hostRenders).toBeGreaterThan(pendingHostRenders);
      expect(resourceStarts).toBe(0);

      const disabledHostRenders = hostRenders;
      setState("active");
      expect(readSolidOutput(mountedSlot)).toBe("quota-prompt");
      expect(hostRenders).toBeGreaterThan(disabledHostRenders);
      expect(resourceStarts).toBe(1);
      expect(registrations).toBe(1);

      unregister();
      expect(readSolidOutput(mountedSlot)).toBe("native-prompt");
      expect(pluginDisposals).toBe(1);
    } finally {
      disposeRoot();
    }
  });
});
