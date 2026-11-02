import { describe, expect, it } from "vite-plus/test";
import {
  type Box,
  dragX,
  isSessionDivider,
  NARROWEST,
  remember,
  SIDE_WIDTHS_INITIAL,
  type SideWidths,
  stillFor,
  widthStep,
} from "../src/gui/side-width-model.js";

const widths = (quota: number, other: number): SideWidths => ({ quota, other });

describe("remember", () => {
  it("keeps a whole number of pixels for one tab and leaves the other", () => {
    expect(remember(widths(0, 700), "quota", 412.6)).toEqual({ quota: 413, other: 700 });
    expect(remember(widths(300, 0), "other", 640.2)).toEqual({ quota: 300, other: 640 });
  });

  it("answers the same object when nothing changes, so nothing is written", () => {
    const same = widths(320, 700);
    expect(remember(same, "other", 699.8)).toBe(same);
    expect(remember(same, "quota", 0)).toBe(same);
    expect(remember(same, "quota", Number.NaN)).toBe(same);
  });
});

describe("widthStep", () => {
  it("narrows the panel when Quota replaces another tab, and remembers that tab's width", () => {
    const step = widthStep({
      shows: "quota",
      held: "other",
      current: 700,
      widths: SIDE_WIDTHS_INITIAL,
    });

    expect(step.widths).toEqual({ quota: 0, other: 700 });
    // 0 is less than the panel can be; the app stops the drag at its minimum.
    expect(step.narrowerBy).toBe(700 - NARROWEST);
  });

  it("refreshes the other tabs' width from the panel each time Quota replaces them", () => {
    const step = widthStep({ shows: "quota", held: "other", current: 520, widths: widths(0, 700) });

    expect(step.widths.other).toBe(520);
  });

  it("uses the width the user gave Quota, in either direction", () => {
    expect(
      widthStep({ shows: "quota", held: "other", current: 700, widths: widths(450, 700) })
        .narrowerBy,
    ).toBe(250);
    expect(
      widthStep({ shows: "quota", held: "other", current: 400, widths: widths(450, 400) })
        .narrowerBy,
    ).toBe(-50);
  });

  it("puts the other tabs' width back when Quota gives way", () => {
    const step = widthStep({ shows: "other", held: "quota", current: 320, widths: widths(0, 700) });

    expect(step.narrowerBy).toBe(-380);
    expect(step.widths).toEqual(widths(0, 700));
  });

  it("leaves the panel alone when Quota gives way and no width was remembered", () => {
    const step = widthStep({
      shows: "other",
      held: "quota",
      current: 320,
      widths: SIDE_WIDTHS_INITIAL,
    });

    expect(step.narrowerBy).toBeUndefined();
  });

  it("does nothing when the panel already holds the shown tab's width", () => {
    for (const shows of ["quota", "other"] as const) {
      const step = widthStep({ shows, held: shows, current: 500, widths: widths(320, 700) });
      expect(step.narrowerBy).toBeUndefined();
      expect(step.widths).toEqual(widths(320, 700));
    }
  });

  it("skips a drag of under a pixel", () => {
    const step = widthStep({
      shows: "other",
      held: "quota",
      current: 700.4,
      widths: widths(0, 700),
    });

    expect(step.narrowerBy).toBeUndefined();
  });

  it("narrows a session first seen showing Quota, and keeps the width it remembers for the others", () => {
    const first = widthStep({
      shows: "quota",
      held: undefined,
      current: 640,
      widths: widths(0, 700),
    });

    expect(first.widths.other).toBe(700);
    expect(first.narrowerBy).toBe(640);
  });

  it("takes the panel's width for the other tabs when none is remembered yet", () => {
    const first = widthStep({
      shows: "quota",
      held: undefined,
      current: 640,
      widths: SIDE_WIDTHS_INITIAL,
    });

    expect(first.widths.other).toBe(640);
  });

  it("takes a stored width that is zero, negative, NaN or infinite for none", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      // The other tabs' width is taken from the panel when Quota replaces them...
      const toQuota = widthStep({
        shows: "quota",
        held: undefined,
        current: 640,
        widths: widths(0, bad),
      });
      expect(toQuota.widths.other).toBe(640);

      // ...there is nothing to put back when Quota gives way...
      const back = widthStep({
        shows: "other",
        held: "quota",
        current: 320,
        widths: widths(0, bad),
      });
      expect(back.narrowerBy).toBeUndefined();

      // ...and Quota goes to the narrowest.
      const narrow = widthStep({
        shows: "quota",
        held: "other",
        current: 700,
        widths: widths(bad, 700),
      });
      expect(narrow.narrowerBy).toBe(700 - NARROWEST);
    }
  });

  it("replaces a bad stored width when the panel gives a good one", () => {
    expect(remember(widths(-5, 700), "quota", 450)).toEqual(widths(450, 700));
    expect(remember(widths(Number.NaN, 700), "quota", 450)).toEqual(widths(450, 700));
    const first = widthStep({
      shows: "other",
      held: undefined,
      current: 500,
      widths: widths(0, -1),
    });
    expect(first.widths.other).toBe(500);
  });

  it("leaves a session first seen showing another tab as it is", () => {
    const remembered = widthStep({
      shows: "other",
      held: undefined,
      current: 500,
      widths: widths(0, 700),
    });
    const none = widthStep({
      shows: "other",
      held: undefined,
      current: 500,
      widths: SIDE_WIDTHS_INITIAL,
    });

    expect(remembered.narrowerBy).toBeUndefined();
    expect(remembered.widths.other).toBe(700);
    expect(none.narrowerBy).toBeUndefined();
    expect(none.widths.other).toBe(500);
  });
});

describe("dragX", () => {
  it("moves the pointer right to narrow the side panel on a left-to-right page", () => {
    expect(dragX(1000, 250, false)).toBe(1250);
    expect(dragX(1000, -100, false)).toBe(900);
  });

  it("moves it the other way on a right-to-left page", () => {
    expect(dragX(1000, 250, true)).toBe(750);
  });
});

describe("stillFor", () => {
  it("needs enough measurements, all within the tolerance", () => {
    expect(stillFor([700, 700, 700], 4, 0.5)).toBe(false);
    expect(stillFor([700, 700, 700, 700], 4, 0.5)).toBe(true);
    expect(stillFor([512, 600, 700, 700.3], 4, 0.5)).toBe(false);
  });

  it("looks only at the latest measurements", () => {
    expect(stillFor([0, 120, 480, 700, 700, 700, 700], 4, 0.5)).toBe(true);
  });
});

describe("isSessionDivider", () => {
  const box = (left: number, width: number, height = 800): Box => ({
    left,
    right: left + width,
    width,
    height,
  });
  // The chat panel 0-900, an 8px gap, the side panel 908-1400; the handle 8px wide, centered on 900.
  const chat = box(0, 900);
  const side = box(908, 492);

  it("accepts the handle on the edge the chat panel shares with the side panel", () => {
    expect(isSessionDivider(box(896, 8), chat, side)).toBe(true);
    // As the app's CSS places it: its right edge translated half its width past the chat panel.
    expect(isSessionDivider(box(900, 8), chat, side)).toBe(true);
  });

  it("accepts it with the side panel on the left, as on a right-to-left page", () => {
    const rtlSide = box(0, 492);
    const rtlChat = box(500, 900);
    expect(isSessionDivider(box(496, 8), rtlChat, rtlSide)).toBe(true);
  });

  it("rejects other horizontal handles: the left sidebar's, or one inside the side panel", () => {
    expect(isSessionDivider(box(236, 8), chat, side)).toBe(false);
    expect(isSessionDivider(box(1100, 8), chat, side)).toBe(false);
  });

  it("rejects it when a panel overlaps the chat panel or any of the three is off screen", () => {
    expect(isSessionDivider(box(896, 8), chat, box(600, 800))).toBe(false);
    expect(isSessionDivider(box(896, 8), chat, box(908, 0))).toBe(false);
    expect(isSessionDivider(box(896, 8, 0), chat, side)).toBe(false);
    expect(isSessionDivider(box(896, 8), box(0, 0), side)).toBe(false);
  });
});
