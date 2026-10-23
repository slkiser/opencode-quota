/**
 * The priorities of the TUI's keymap layers. OpenCode asks the highest enabled layer first, so
 * a layer here wins over every lower one that binds the same key.
 */
export const KEY_LAYERS = {
  /** Enter on a typed quota command; above OpenCode's textarea layer. */
  typedCommand: 1,
  /** The quota window's own keys. */
  window: 10,
  /** The open tab's keys: Settings lines or the Usage tab. */
  tab: 11,
  /** ctrl+s on the Settings tabs. */
  save: 12,
  /** The bottom bar's "Keep your changes?" question. */
  confirmClose: 15,
  /** A Settings line taking typed text. */
  typing: 20,
} as const;

export type KeyLayerName = keyof typeof KEY_LAYERS;
