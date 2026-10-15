# ACC-03 shared accounting presentation

Issue: [#18](https://github.com/thanhndv212/opencode-quota/issues/18). Status: implemented; local acceptance passed, hosted acceptance and merge pending. Evidence date: 2026-10-15. Dependencies: ACC-01/02 complete.

## Behavior

One deterministic accounting display projection supplies exact quantities, typed operands, source authority, safe account labels, source-observation time, fetch time and window/reset details to desktop, CLI and command reports. It never converts a balance or unknown limit into a percentage. Existing legacy entries remain the compact compatibility contract; typed-only providers can project into percent/value display rows without mutating cached records or schema-v1 exports.

The dashboard and History tab provide a Balances and usage details disclosure. History separates account series and adds account selection. Unknown rows remain separate; local token totals and legacy reset records are explicitly unqualified by account. Raw credentials/account principals/internal resolved-auth identities are absent from display metadata.

`opencode-quota show --details` and `/quota` expose full typed details. `/quota_status` uses the same facts from its existing probes. Sidebar/toasts append bounded supplementary quantities/unlimited states; primary percentage bars retain the existing remaining-floor and used-display behavior. Over-limit values remain explicit in rich details. JSON stays schema-v1; combining `--json --details` is rejected without fetching.

Fresh/stale updates retain or clear details together with their original quota observation. A failed refresh cannot attach previous-account details to a new successful snapshot. Display strings remove terminal controls; long detail lines wrap to bounded widths. Source time remains unknown when the provider does not establish it.

## Acceptance and limits

Node 22.23.3/pnpm 10.0.0: typecheck, 147 Vitest files / 1,509 tests, clean installed tarball, account-cache process smoke, native Node/Bun 1.3.14 history compatibility and installed macOS Electron 42.5.0 smoke passed. The installed smoke checks real main/preload/renderer/history projection, typed details and original quota/history/budget flows. Wide/narrow rendered captures were inspected at [wide](evidence/ACC03-accounting-wide.png) and [narrow](evidence/ACC03-accounting-narrow.png); the disclosure, labels, timestamps and values fit without clipping. The final Five-hour label correction passed a repeated installed Electron assertion and capture; it follows the explicit OpenAI window contract rather than its historical internal `hourly` key.

Shared semantic tests cover quantities/zero/unknown/over-limit, operands, source/fetch time separation, known versus unknown account labels, terminal sanitization, narrow lines, report/sidebar/toast agreement, single-fetch CLI details and stale metadata retention. Existing deterministic command boundary tests remain part of the full suite.

Fixture evidence does not certify live providers or actual-host command routing. No database/config migration or export version change occurs here. Rollback restores the earlier package; additive history tables remain readable for re-upgrade. Fixed-window exhaustion and reset notices are separate INS work; no eligibility is inferred from a display label.
