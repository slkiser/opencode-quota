/**
 * The usage window's CSS, added with the `Style` registry. Every class starts with `oq-`. Colors
 * come from the app's theme variables where it has them (text, surfaces, borders, the success,
 * warning and critical icon colors), with fallbacks for light and dark: the window's root sets
 * `data-mode` from `ctx.appearance.mode()`. The series colors are mid tones that read on both.
 * The always-on surfaces (`.oq-surface`: the Quota tab and the bottom strip) take the TUI's named
 * colors as `--oq-n-<name>` from the same theme variables.
 */
export const STYLE = `
.oq-window {
  --oq-text: var(--text-strong, #0b0b0b);
  --oq-text-2: var(--text-base, #52514e);
  --oq-muted: var(--text-weak, #8a8984);
  --oq-line: var(--border-weak-base, #e7e6e2);
  --oq-raised: var(--surface-raised-base, #ffffff);
  --oq-hover: var(--surface-base-hover, #f1f1ef);
  --oq-empty: #ebeae6;
  --oq-good: var(--icon-success-base, #0ca30c);
  --oq-warning: var(--icon-warning-base, #d99a0b);
  --oq-low: var(--icon-critical-base, #d03b3b);
  --oq-low-bg: color-mix(in srgb, var(--oq-low) 10%, transparent);
  --oq-s0: #2a78d6;
  --oq-s1: #eb6834;
  --oq-s2: #1baf7a;
  --oq-s3: #e3a008;
  --oq-s4: #9a6bd8;
  --oq-s5: #9b9a95;
  --oq-t0: #8f8e8a;
  --oq-t1: #c4c3be;
  --oq-t2: #5c5b57;
  --oq-t3: #1f1f1d;
  color: var(--oq-text);
  font-size: 13px;
  line-height: 1.45;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.oq-window[data-mode="dark"] {
  --oq-text: var(--text-strong, #ededec);
  --oq-text-2: var(--text-base, #b5b4b0);
  --oq-muted: var(--text-weak, #8a8984);
  --oq-line: var(--border-weak-base, #2f2f2d);
  --oq-raised: var(--surface-raised-base, #1d1d1c);
  --oq-hover: var(--surface-base-hover, #262625);
  --oq-empty: #353533;
  --oq-s0: #4a90e2;
  --oq-s1: #f07b4b;
  --oq-s2: #2cc28c;
  --oq-s3: #f0b429;
  --oq-s4: #a985e0;
  --oq-s5: #8a8984;
  --oq-t0: #8f8e8a;
  --oq-t1: #5c5b57;
  --oq-t2: #c4c3be;
  --oq-t3: #f2f2f0;
}
.oq-c0 { --oq-c: var(--oq-s0); } .oq-c1 { --oq-c: var(--oq-s1); } .oq-c2 { --oq-c: var(--oq-s2); }
.oq-c3 { --oq-c: var(--oq-s3); } .oq-c4 { --oq-c: var(--oq-s4); } .oq-c5 { --oq-c: var(--oq-s5); }
.oq-good { --oq-c: var(--oq-good); } .oq-warning { --oq-c: var(--oq-warning); } .oq-low { --oq-c: var(--oq-low); }
.oq-input { --oq-c: var(--oq-t0); } .oq-cacheRead { --oq-c: var(--oq-t1); }
.oq-cacheWrite { --oq-c: var(--oq-t2); } .oq-output { --oq-c: var(--oq-t3); }
.oq-muted { color: var(--oq-muted); }
.oq-small { font-size: 12px; }
.oq-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--oq-c); flex: none; }
.oq-mark { color: var(--oq-c); font-size: 10px; }

.oq-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; }
.oq-head .oq-right { margin-left: auto; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.oq-seg { display: inline-flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--oq-hover); }
.oq-seg button { border: 0; background: transparent; color: var(--oq-text-2); font: inherit; font-size: 12px;
  padding: 3px 9px; border-radius: 6px; cursor: pointer; white-space: nowrap; }
.oq-seg button:hover { color: var(--oq-text); }
.oq-seg button[aria-pressed="true"] { background: var(--oq-raised); color: var(--oq-text);
  box-shadow: 0 0 0 1px var(--oq-line); }
.oq-seg button:disabled { opacity: .4; cursor: default; }
.oq-between { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--oq-text-2); }
.oq-between input { font: inherit; color: var(--oq-text); background: var(--oq-raised);
  border: 1px solid var(--oq-line); border-radius: 6px; padding: 2px 6px; color-scheme: light dark; }
.oq-note { font-size: 12px; color: var(--oq-text-2); }

.oq-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 12px; }
.oq-card { background: var(--oq-raised); border: 1px solid var(--oq-line); border-radius: 12px; padding: 12px 14px 8px; }
.oq-card.oq-current { box-shadow: 0 0 0 2px color-mix(in srgb, var(--oq-s0) 35%, transparent); }
.oq-card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.oq-card-head .oq-name { font-weight: 600; font-size: 14px; }
.oq-chip { display: inline-flex; font-size: 11px; padding: 1px 7px; border-radius: 99px;
  background: var(--oq-hover); color: var(--oq-text-2); white-space: nowrap; }
.oq-chip.oq-current-chip { margin-left: auto; color: var(--oq-s0); background: color-mix(in srgb, var(--oq-s0) 12%, transparent); }
.oq-error { font-size: 12px; color: var(--oq-low); background: var(--oq-low-bg); border-radius: 8px; padding: 6px 10px; margin: 4px 0 6px; }
.oq-row { display: grid; grid-template-columns: minmax(80px, 140px) 1fr auto; gap: 4px 12px; align-items: center; padding: 7px 0; }
.oq-row + .oq-row { border-top: 1px dashed var(--oq-line); }
.oq-row .oq-label { font-size: 12.5px; color: var(--oq-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oq-row .oq-value { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.oq-row .oq-sub { grid-column: 2 / 4; display: flex; gap: 10px; font-size: 11.5px; color: var(--oq-muted); }
.oq-row .oq-pace { margin-left: auto; }
.oq-row .oq-pace.oq-fast { color: var(--oq-low); }
.oq-row.oq-plain .oq-value { grid-column: 2 / 4; text-align: left; }
.oq-bar { position: relative; height: 8px; border-radius: 4px; background: var(--oq-empty); }
.oq-bar .oq-fill { position: absolute; inset: 0 auto 0 0; border-radius: 4px; background: var(--oq-c); }
.oq-bar .oq-even { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; border-radius: 1px;
  background: var(--oq-text); box-shadow: 0 0 0 1.5px var(--oq-raised); }
.oq-strip { display: flex; flex-wrap: wrap; gap: 6px 20px; align-items: center; background: var(--oq-raised);
  border: 1px solid var(--oq-line); border-radius: 12px; padding: 8px 14px; font-size: 12.5px; }
.oq-strip b { font-weight: 500; font-variant-numeric: tabular-nums; }
.oq-legend { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 12px; color: var(--oq-text-2); }
.oq-legend i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; background: var(--oq-c); }
.oq-legend .oq-even-key { width: 2px; background: var(--oq-text); }
.oq-legend b { font-weight: 500; color: var(--oq-text); }

.oq-top { display: grid; grid-template-columns: minmax(220px, 280px) 1fr; gap: 32px; }
.oq-total { font-size: 32px; font-weight: 600; letter-spacing: -.5px; font-variant-numeric: tabular-nums; }
.oq-providers { margin-top: 18px; display: grid; gap: 14px; }
.oq-provider .oq-l1 { display: flex; align-items: baseline; gap: 6px; }
.oq-provider .oq-l1 .oq-amount { margin-left: auto; font-variant-numeric: tabular-nums; }
.oq-provider .oq-l2 { color: var(--oq-text-2); font-size: 12px; margin-left: 14px; }
.oq-section { font-size: 14px; font-weight: 500; margin: 8px 0 0; display: flex; align-items: center; gap: 10px; }
.oq-section .oq-seg { margin-left: auto; }
.oq-totals { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; }
.oq-totals .oq-k { color: var(--oq-text-2); font-size: 12px; }
.oq-totals .oq-v { font-size: 17px; margin-top: 2px; font-variant-numeric: tabular-nums; }
.oq-types { display: flex; gap: 2px; height: 6px; max-width: 470px; }
.oq-types span { height: 6px; border-radius: 2px; background: var(--oq-c); }
.oq-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.oq-table th { text-align: right; color: var(--oq-text-2); font-weight: 400; font-size: 12px; padding: 6px 0 8px;
  border-bottom: 1px solid var(--oq-line); }
.oq-table td { text-align: right; padding: 9px 0 10px; border-bottom: 1px solid var(--oq-line); }
.oq-table th + th, .oq-table td + td { padding-left: 18px; }
.oq-table th:nth-child(-n+2), .oq-table td:nth-child(-n+2) { text-align: left; }
.oq-table td:first-child { color: var(--oq-muted); font-size: 12px; width: 28px; }
.oq-table td.oq-warning { color: var(--oq-c); }
.oq-table tr.oq-click { cursor: pointer; }
.oq-table tr.oq-click:hover td { background: var(--oq-hover); }
.oq-rowbar { height: 2px; border-radius: 2px; margin-top: 5px; background: var(--oq-c, var(--oq-text-2)); }
.oq-chart { position: relative; }
.oq-chart svg { display: block; width: 100%; height: auto; overflow: visible; }
.oq-chart .oq-axis { font-size: 10px; fill: var(--oq-muted); }
.oq-chart .oq-gridline { stroke: var(--oq-line); }
.oq-chart .oq-area { fill: var(--oq-c); fill-opacity: .14; }
.oq-chart .oq-edge { fill: none; stroke: var(--oq-c); stroke-width: 2; stroke-linejoin: round; }
.oq-chart .oq-cross { stroke: var(--oq-text-2); stroke-dasharray: 3 3; }
.oq-tip { position: absolute; top: 8px; pointer-events: none; min-width: 170px; z-index: 2; background: var(--oq-raised);
  border: 1px solid var(--oq-line); border-radius: 8px; padding: 8px 10px; font-size: 12px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, .14); }
.oq-tip .oq-tip-row { display: flex; gap: 8px; align-items: center; }
.oq-tip .oq-tip-row b { margin-left: auto; font-weight: 500; font-variant-numeric: tabular-nums; }
.oq-tip .oq-tip-total { border-top: 1px solid var(--oq-line); margin-top: 4px; padding-top: 4px; }
.oq-kv { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.oq-kv .oq-k { font-size: 12px; color: var(--oq-text-2); }
.oq-kv .oq-v { font-size: 16px; margin-top: 2px; font-variant-numeric: tabular-nums; }
.oq-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }

.oq-surface {
  --oq-n-text: var(--text-strong, #0b0b0b);
  --oq-n-muted: var(--text-weak, #8a8984);
  --oq-n-accent: var(--text-interactive-base, #2a78d6);
  --oq-n-green: var(--icon-success-base, #0ca30c);
  --oq-n-yellow: var(--icon-warning-base, #d99a0b);
  --oq-n-red: var(--icon-critical-base, #d03b3b);
  --oq-n-blue: var(--icon-info-base, #2a78d6);
  color: var(--oq-n-text);
  font-size: 12px;
  line-height: 1.45;
}
.oq-surface[data-mode="dark"] {
  --oq-n-text: var(--text-strong, #ededec);
  --oq-n-muted: var(--text-weak, #8a8984);
  --oq-n-accent: var(--text-interactive-base, #4a90e2);
  --oq-n-blue: var(--icon-info-base, #4a90e2);
}
.oq-surface button { border: 0; background: transparent; font: inherit; color: inherit; padding: 0; cursor: pointer; }
.oq-panel { padding: 10px 12px; overflow: auto; height: 100%; box-sizing: border-box; }
.oq-panel .oq-muted { color: var(--oq-n-muted); }
.oq-panel-title { font-weight: 600; margin-bottom: 8px; }
.oq-pname { display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; margin-bottom: 2px; }
.oq-prow { display: grid; grid-template-columns: minmax(40px, auto) minmax(30px, 1fr) auto auto; gap: 6px;
  align-items: center; white-space: nowrap; margin: 2px 0; }
.oq-prow > span:first-child { overflow: hidden; text-overflow: ellipsis; }
.oq-prow.oq-plain { grid-template-columns: minmax(40px, auto) 1fr; }
.oq-prow .oq-pwide { grid-column: 2 / 5; overflow: hidden; text-overflow: ellipsis; }
.oq-pnum { text-align: right; font-variant-numeric: tabular-nums; }
.oq-pbar { position: relative; height: 6px; border-radius: 3px; }
.oq-pfill { position: absolute; inset: 0 auto 0 0; border-radius: 3px; }
.oq-peven { position: absolute; top: -2px; bottom: -2px; width: 2px; margin-left: -1px; border-radius: 1px; }
.oq-ppace { padding-left: 46px; font-size: 11.5px; }
.oq-strip-bottom { position: relative; display: flex; align-items: center; justify-content: flex-end;
  overflow: hidden; white-space: pre; padding: 2px 12px; margin-left: auto;
  font-family: var(--font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11.5px; }
.oq-strip-bottom .oq-sline:hover { text-decoration: underline; }
.oq-probe { position: absolute; visibility: hidden; pointer-events: none; }
`;
