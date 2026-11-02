/**
 * A small fake browser page for the GUI's DOM code (`src/gui/side-width.ts`, `src/gui/toasts.ts`):
 * elements with attributes, text, boxes and a selector engine for the few selectors that code uses (tag, `.class`,
 * `[attr]`, `[attr="value"]`, `:scope`, `>` and descendant combinators; anything else throws),
 * events with capture, bubbling and `once`, a `MutationObserver` the test flushes, and frames
 * and a clock the test advances. `installFakePage` puts them on the globals; `removeFakePage`
 * takes them off.
 */
import { vi } from "vite-plus/test";

export type Rect = { left: number; top: number; width: number; height: number };

export const OFF_SCREEN: Rect = { left: 0, top: 0, width: 0, height: 0 };

type Listener = {
  type: string;
  callback: (event: FakeEvent) => void;
  capture: boolean;
  once: boolean;
};
type ListenerOptions = boolean | { capture?: boolean; once?: boolean };

/** One event the page saw, in dispatch order; `target` is an element's name or "document". */
export type SeenEvent = {
  type: string;
  target: string;
  clientX: number | undefined;
  clientY: number | undefined;
};

export class FakeEvent {
  readonly type: string;
  bubbles = false;
  clientX: number | undefined;
  clientY: number | undefined;
  target: FakeTarget | undefined;

  constructor(type: string, init: Record<string, unknown> = {}) {
    this.type = type;
    Object.assign(this, init);
  }
}

class FakeTarget {
  readonly listeners: Listener[] = [];
  parent: FakeTarget | undefined;
  /** For the log of events. */
  name = "";

  addEventListener(
    type: string,
    callback: (event: FakeEvent) => void,
    options: ListenerOptions = false,
  ) {
    const capture = typeof options === "boolean" ? options : !!options.capture;
    const once = typeof options === "boolean" ? false : !!options.once;
    const same = this.listeners.some(
      (listener) =>
        listener.type === type && listener.callback === callback && listener.capture === capture,
    );
    if (!same) this.listeners.push({ type, callback, capture, once });
  }

  removeEventListener(
    type: string,
    callback: (event: FakeEvent) => void,
    options?: ListenerOptions,
  ) {
    const capture = typeof options === "boolean" ? options : !!options?.capture;
    const at = this.listeners.findIndex(
      (listener) =>
        listener.type === type && listener.callback === callback && listener.capture === capture,
    );
    if (at >= 0) this.listeners.splice(at, 1);
  }

  dispatchEvent(event: FakeEvent) {
    event.target = this;
    seen.push({
      type: event.type,
      target: this.name || "document",
      clientX: event.clientX,
      clientY: event.clientY,
    });
    const above: FakeTarget[] = [];
    for (let node = this.parent; node; node = node.parent) above.unshift(node);
    for (const node of above) node.fire(event, "capture");
    this.fire(event, "target");
    if (event.bubbles) for (const node of [...above].reverse()) node.fire(event, "bubble");
    return true;
  }

  private fire(event: FakeEvent, phase: "capture" | "target" | "bubble") {
    for (const listener of this.listeners.slice()) {
      if (listener.type !== event.type) continue;
      if (phase === "capture" && !listener.capture) continue;
      if (phase === "bubble" && listener.capture) continue;
      if (listener.once)
        this.removeEventListener(listener.type, listener.callback, listener.capture);
      listener.callback(event);
    }
  }
}

type Compound = {
  scope: boolean;
  tag: string | undefined;
  classes: string[];
  attributes: Array<[string, string | undefined]>;
};
type Step = { combinator: ">" | " " | undefined; compound: Compound };

function parseCompound(text: string, selector: string): Compound {
  const compound: Compound = { scope: false, tag: undefined, classes: [], attributes: [] };
  let rest = text;
  const tag = /^(?:[a-z][a-z0-9-]*|\*)/i.exec(rest);
  if (tag) {
    compound.tag = tag[0] === "*" ? undefined : tag[0].toLowerCase();
    rest = rest.slice(tag[0].length);
  }
  let consumed = 0;
  for (const match of rest.matchAll(/:scope|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g)) {
    if (match.index !== consumed) break;
    consumed += match[0].length;
    if (match[0] === ":scope") compound.scope = true;
    else if (match[1]) compound.classes.push(match[1]);
    else if (match[2]) compound.attributes.push([match[2], match[3]]);
  }
  if (consumed !== rest.length) throw new Error(`fake page: unsupported selector "${selector}"`);
  return compound;
}

function parseSelector(selector: string): Step[] {
  const steps: Step[] = [];
  let combinator: Step["combinator"];
  for (const part of selector.trim().split(/(\s*>\s*|\s+)/)) {
    if (part === "") continue;
    if (part.includes(">")) combinator = ">";
    else if (part.trim() === "") combinator = " ";
    else {
      steps.push({ combinator, compound: parseCompound(part, selector) });
      combinator = undefined;
    }
  }
  if (steps.length === 0) throw new Error(`fake page: empty selector "${selector}"`);
  return steps;
}

export class FakeElement extends FakeTarget {
  readonly tagName: string;
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  rect: Rect;
  direction = "ltr";
  /** The element's own text, before its children's. */
  text = "";

  constructor(
    tag: string,
    options: { name?: string; attributes?: Record<string, string>; rect?: Rect } = {},
  ) {
    super();
    this.tagName = tag.toLowerCase();
    this.name = options.name ?? tag;
    this.rect = options.rect ?? OFF_SCREEN;
    for (const [key, value] of Object.entries(options.attributes ?? {})) {
      this.attributes.set(key, value);
    }
  }

  get parentElement(): FakeElement | null {
    return this.parent instanceof FakeElement ? this.parent : null;
  }

  append(...children: FakeElement[]) {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
    changed(this);
    return this;
  }

  /** Puts `siblings` right after this element, in its parent. */
  after(...siblings: FakeElement[]) {
    const parent = this.parentElement;
    if (!parent) return;
    for (const sibling of siblings) sibling.remove();
    parent.children.splice(parent.children.indexOf(this) + 1, 0, ...siblings);
    for (const sibling of siblings) sibling.parent = parent;
    changed(parent);
  }

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("");
  }

  /** In the page: the document is an ancestor. */
  get isConnected(): boolean {
    let node: FakeTarget | undefined = this.parent;
    while (node instanceof FakeElement) node = node.parent;
    return node instanceof FakeDocument;
  }

  remove() {
    const parent = this.parentElement;
    if (!parent) return;
    parent.children.splice(parent.children.indexOf(this), 1);
    this.parent = undefined;
    changed(parent);
  }

  hasAttribute(name: string) {
    return this.attributes.has(name);
  }

  setAttribute(name: string, value = "") {
    this.attributes.set(name, value);
    if (name === "class") changed(this);
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
    if (name === "class") changed(this);
  }

  closest(selector: string): FakeElement | null {
    const steps = parseSelector(selector);
    if (matches(this, this, steps)) return this;
    for (let element = this.parentElement; element; element = element.parentElement) {
      if (matches(element, element, steps)) return element;
    }
    return null;
  }

  getBoundingClientRect() {
    const { left, top, width, height } = this.rect;
    return { left, top, width, height, right: left + width, bottom: top + height };
  }

  contains(other: unknown): boolean {
    if (other === this) return true;
    return this.children.some((child) => child.contains(other));
  }

  querySelectorAll(selector: string): FakeElement[] {
    const steps = parseSelector(selector);
    return this.descendants().filter((element) => matches(element, this, steps));
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  descendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  hasClass(name: string) {
    return (this.attributes.get("class") ?? "").split(/\s+/).includes(name);
  }
}

function matchesCompound(element: FakeElement, scope: FakeElement, compound: Compound) {
  if (compound.scope) return element === scope;
  if (compound.tag && element.tagName !== compound.tag) return false;
  if (!compound.classes.every((name) => element.hasClass(name))) return false;
  return compound.attributes.every(([name, value]) =>
    value === undefined ? element.hasAttribute(name) : element.attributes.get(name) === value,
  );
}

function matches(
  element: FakeElement,
  scope: FakeElement,
  steps: Step[],
  index = steps.length - 1,
): boolean {
  const step = steps[index];
  if (!step || !matchesCompound(element, scope, step.compound)) return false;
  if (index === 0) return true;
  if (step.combinator === ">") {
    const parent = element.parentElement;
    return !!parent && matches(parent, scope, steps, index - 1);
  }
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (matches(ancestor, scope, steps, index - 1)) return true;
  }
  return false;
}

export class FakeDocument extends FakeTarget {
  readonly body = new FakeElement("body", { name: "body" });

  constructor() {
    super();
    this.body.parent = this;
  }

  querySelectorAll(selector: string) {
    return this.body.querySelectorAll(selector);
  }

  querySelector(selector: string) {
    return this.body.querySelector(selector);
  }

  hasFocus() {
    return true;
  }
}

class FakeMutationObserver {
  target: FakeElement | undefined;
  pending = false;
  private readonly callback: () => void;

  constructor(callback: () => void) {
    this.callback = callback;
  }

  observe(
    target: FakeElement,
    options: { childList?: boolean; subtree?: boolean; attributeFilter?: string[] },
  ) {
    if (!options.childList || !options.subtree) {
      throw new Error("fake page: the observer fakes childList and subtree only");
    }
    if (options.attributeFilter && options.attributeFilter.join() !== "class") {
      throw new Error("fake page: the observer fakes class attribute changes only");
    }
    this.target = target;
    observers.add(this);
  }

  disconnect() {
    this.target = undefined;
    this.pending = false;
    observers.delete(this);
  }

  run() {
    this.pending = false;
    this.callback();
  }
}

const observers = new Set<FakeMutationObserver>();
const seen: SeenEvent[] = [];

/** A child list changed: the observers watching an ancestor of it have a record to deliver. */
function changed(parent: FakeElement) {
  for (const observer of observers) {
    if (observer.target?.contains(parent)) observer.pending = true;
  }
}

export type FakePage = {
  readonly document: FakeDocument;
  /** The events dispatched since the page was installed, oldest first. */
  readonly events: readonly SeenEvent[];
  /** Delivers the mutations observers have waiting, as the browser does after a script. */
  flushMutations(): void;
  /** Runs `count` animation frames, `ms` apart; callbacks asked for during a frame wait for the next. */
  frames(count: number, ms?: number): void;
  /** Frames asked for and not yet run or cancelled. */
  pendingFrames(): number;
  /** Listeners on the document, for checking that cleanup left none. */
  documentListeners(): number;
  /** Observers still watching. */
  observing(): number;
};

export function installFakePage(): FakePage {
  const document = new FakeDocument();
  const clock = { now: 0, next: 1, queue: new Map<number, () => void>() };
  seen.length = 0;
  observers.clear();

  vi.stubGlobal("document", document);
  vi.stubGlobal("window", {});
  vi.stubGlobal("Element", FakeElement);
  vi.stubGlobal("MouseEvent", FakeEvent);
  vi.stubGlobal("PointerEvent", FakeEvent);
  vi.stubGlobal("MutationObserver", FakeMutationObserver);
  vi.stubGlobal("getComputedStyle", (element: FakeElement) => ({ direction: element.direction }));
  vi.stubGlobal("performance", { now: () => clock.now });
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    const id = clock.next++;
    clock.queue.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    clock.queue.delete(id);
  });

  return {
    document,
    events: seen,
    flushMutations() {
      for (const observer of Array.from(observers)) if (observer.pending) observer.run();
    },
    frames(count, ms = 16) {
      for (let frame = 0; frame < count; frame++) {
        clock.now += ms;
        const due = [...clock.queue];
        clock.queue.clear();
        for (const [, callback] of due) callback();
      }
    },
    pendingFrames: () => clock.queue.size,
    documentListeners: () => document.listeners.length,
    observing: () => observers.size,
  };
}

export function removeFakePage() {
  vi.unstubAllGlobals();
  observers.clear();
  seen.length = 0;
}
