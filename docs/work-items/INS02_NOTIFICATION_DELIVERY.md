# INS-02 — Desktop and plugin reset notices

Issue: [#20](https://github.com/thanhndv212/opencode-quota/issues/20). Status: implemented; local acceptance passed; [PR #50](https://github.com/thanhndv212/opencode-quota/pull/50) merged at `7e1d60e`; [main CI 38745556505](https://github.com/thanhndv212/opencode-quota/actions/runs/38745556505) passed all six checks; Linux X11/Dunst native acceptance passed; macOS observation remains open. Latest evidence: 2026-10-17. Dependencies: INS-01 and GUI-02 complete.

Upstream provenance: mature reset notification policy at `2733b5bd010f659d1d6007e5d19026e82d51353f`, following `c2dca3c` and `cedee73`. Delivery is adapted to the fork's native history writers and separate Electron process.

Configure the shared sidecar `opencode-quota/quota-toast.json` next to the selected global/project OpenCode config:

```json
{
  "resetNotifications": {
    "enabled": true,
    "watched": [{ "providerId": "openai", "windowId": "weekly" }],
    "preferDesktop": true
  }
}
```

Default is disabled with no watched windows. Window IDs come from structured accounting metadata, never display-label guesses. Invalid overrides disable notices and report a configuration issue. Global defaults/project overrides and source provenance follow the ordinary sidecar loader. Plugin notices also respect `enabled` and `enableToast`; native desktop delivery respects `enabled` and this explicit notice setting.

The desktop advertises only configured, supported windows through a renewable 45-second local database lease. Plugin claims defer those windows when desktop preference is enabled, otherwise the first available channel wins. Native desktop claims are bounded to one event at a time. Unsupported or explicitly failed delivery withdraws availability and leaves the event pending for plugin fallback. No channel adds quota requests; desktop availability renewals read/write local history only. Reloading settings explicitly retries a failed desktop capability.

The native adapter acknowledges Electron's `show` event, handles `failed` without crashing, and navigates clicks to the provider/account/window history view. A ten-second unacknowledged outcome remains uncertain; crash/expired delivery leases are also uncertain. History preserves these events independently of delivery. The History tab offers an explicit retry with a duplicate-risk confirmation; it never silently retries an ambiguous notice. Toast promise rejection or an SDK error response does not consume the event. No permission prompts or system preference changes are issued.

Schema v4 adds desktop consumer leases. SQLite-managed private backups and transactional migration remain mandatory; simultaneous writers and legacy rollback are covered by actual native Node/Bun tests. Rollback: disable the setting first, stop writers, preserve the current database and restore the verified private pre-upgrade backup if downgrading to a schema-incompatible runtime. Never copy a live SQLite source through ordinary filesystem APIs.

## Validation and remaining gates

Node 22.23.3/pnpm 10.0.0: 150 files / 1,548 tests, typecheck, clean installed-tarball consumer, account-cache smoke, native Node/Bun 1.3.14 history compatibility and installed macOS Electron 42.5.0 smoke passed on the final implementation, including status diagnostics and selected-window filtering. Tests exercise real competing helper processes, desktop preference/expiry/withdrawal, denied/unsupported and uncertain native adapter outcomes, toast HTTP failures, default-off behavior, overlap protection and selected-window click IPC.

**macOS:** installed Electron navigation/preload and mocked native callback behavior verified. No observed OS notification delivery or signed artifact certification. Current [Electron Notification documentation](https://www.electronjs.org/docs/latest/api/notification) states macOS native notification delivery requires code signing; unsigned binaries emit failure. A signed build, user-permitted delivery and an observed click remain required evidence.

**Linux (initial 2026-10-15 checkpoint):** installed Electron fixture smoke preceded native-daemon acceptance. See the subsequent exact rc.2 evidence below. No claim covers every desktop, denied-permission session or real system-tray integration.

Keep issue #20 open until platform evidence is attached; do not mark M4 or the roadmap complete from unit/fixture checks. Continue INS-03 and M5 independently while these gates are unavailable.

## Native acceptance follow-up — 2026-10-16

The opt-in Linux acceptance workflow downloads the exact successful desktop candidate artifact, verifies its checksums/name/version/platform, extracts its `.deb` into a temporary installation and launches the actual binary under isolated X11/D-Bus with Dunst. A synthetic durable reset event plus its history fixture exercise production claim/show/settle logic. The harness requires one displayed daemon banner, captures the actual OS screen, activates Dunst's default notification action, and checks provider/window History navigation and delivered desktop state. No native Notification callbacks are mocked. Run 38962905962 rendered one actual native Dunst banner and persisted delivered desktop state. The [inspected OS screen](evidence/INS02-linux-native-banner.png) confirms the title and fixture/window/replenishment body. Its default-action navigation assertion failed; action callback/D-Bus diagnostics are being collected without relaxing that assertion. Linux acceptance remains partial until this is resolved. This evidence covers that tested X11/Dunst environment, not every Linux desktop or a live provider reset.

The ordinary macOS packaged-app smoke still passes with notifications off. A separate temporary bundle was locally ad-hoc signed for attempted native validation, using a distinct test bundle ID; no distribution signing identity exists. Computer Use inspection returned “Computer Use permissions are not granted”, so no macOS banner/click was observed and no OS setting was changed. Enabling the required UI capability and permitted native delivery remains external evidence needed; a local ad-hoc test would not certify Developer ID signing, notarization or Gatekeeper approval.

Dunst's supported default-action command is documented in its [official manual](https://dunst-project.org/documentation/dunstctl/). The harness explicitly classifies this as OS action activation, not a physical mouse-click or a universal desktop certification. Default-off behavior and all existing fixture failure/uncertain outcomes remain separate tests.

PR #58 merged at `c6b10f91eeed9e8a0859dcdbcccb812317ca9e7b`; all six merged-main CI 38962901809 checks passed. Native-daemon acceptance is separate from that fixture/package CI.

Native diagnostics in run 38963252079 confirm Dunst emitted ActionInvoked(default), Electron delivered the exact provider/account/window callback, and the correct window was rendered. The assertion failed because full render() rebuilt the heading as Quota Monitor. The follow-up fixes renderHeader() to derive its title from the selected tab and adds an installed renderer regression assertion. Version 3.11.0-rc.2 is prepared in a PR before a new tag; v3.11.0-rc.1 is preserved. Native acceptance will rerun against the new exact artifact; macOS visual permission remains unavailable.

Local rc.2 validation: Node 22.23.3/pnpm 10.0.0 typecheck, 161 files / 1,671 tests, clean installed tarball/editor CLI, account-cache process smoke, native Node/Bun 1.3.14 compatibility and installed macOS Electron 42.5.0 passed. The installed reset-navigation regression now checks the History heading as well as the selected window. No native delivery assertion was removed.

PR #59 merged at `da2464424b4c06aec94e24ac8b1d2905dd3020c1`; all six main CI 38964213629 checks passed before tag v3.11.0-rc.2. Exact tagged desktop run 38964538508 and subsequent native acceptance will supply the rc.2 artifact evidence. Preserve the rc.1 failure/diagnostic records; no assertions were relaxed.

## Exact rc.2 acceptance — 2026-10-17

Tagged desktop build [38964538508](https://github.com/thanhndv212/opencode-quota/actions/runs/38964538508) passed both platforms. Native Linux/AppImage run [38964954082](https://github.com/thanhndv212/opencode-quota/actions/runs/38964954082) passed all assertions against those exact checksummed artifacts: actual Dunst banner count, persisted desktop delivery, real default-action callback, selected provider/account/window and History heading. The [action capture](evidence/INS02-linux-rc2-native-action-history.png) was inspected. The exact AppImage also passed six-tab/preload/version/no-exception checks using extract-and-run; FUSE mounting and general desktop integration are not certified.

The first rc.2 root screenshot was a partial redraw. Capture follow-up 38965561481 produced the [inspected visible OS banner](evidence/INS02-linux-rc2-native-banner.png), then failed after successful assertions while deleting a still-changing Chromium cache. The harness now forces X11 repaint, delays capture one second and retries bounded profile cleanup. These changes affect acceptance tooling only; candidate binaries and tag remain unchanged.

macOS remains the only required external acceptance gate: a permitted native banner and its activation must be observed on the target system. Computer Use returned “Computer Use permissions are not granted”; no OS setting was changed. Do not repeat unchanged UI attempts until that capability changes. The ordinary exact downloaded macOS ZIP and CI-mounted DMG both passed isolated packaged runtime checks, which do not supply native banner/click evidence. Keep #20, M4 and the roadmap open, with the five-hour schedule active. No live reset, Developer ID, notarization or stable-release certification is claimed.

Final follow-up [38993028075](https://github.com/thanhndv212/opencode-quota/actions/runs/38993028075) passed both exact-deb native acceptance and exact-AppImage runtime, including cleanup. Its action capture was inspected and versioned. Its root capture was again a partial redraw; the separately inspected visible banner from 38965561481 is retained with that run provenance. Both complete native/AppImage evidence archives are attached to the rc.2 draft. Root capture remains best-effort under Xvfb; the observed banner and successful action/runtime checks are separate evidence.
