import { describe, expect, it } from "vite-plus/test";
import { ru } from "../src/gui/i18n-ru.js";
import { en } from "../src/gui/i18n.js";

describe("Russian GUI translations", () => {
  it("provides every English key and preserves interpolation placeholders", () => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      const placeholders = (value: string) => (value.match(/\{\{[^}]+\}\}/g) ?? []).sort();
      expect([key, placeholders(ru[key])]).toEqual([key, placeholders(en[key])]);
    }
  });

  it("translates the main usage and settings screens", () => {
    expect(ru["view.limits"]).toBe("Лимиты");
    expect(ru["settings.save"]).toBe("Сохранить");
    expect(ru["usage.empty"]).not.toBe(en["usage.empty"]);
  });
});
