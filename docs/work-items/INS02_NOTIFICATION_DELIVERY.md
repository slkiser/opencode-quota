# INS-02 — Desktop and plugin reset notices

Issue: [#20](https://github.com/thanhndv212/token-watcher/issues/20). Status: complete for scoped channel-policy and Linux/macOS native acceptance; [PR #50](https://github.com/thanhndv212/token-watcher/pull/50) merged at `7e1d60e`; [main CI 38745556505](https://github.com/thanhndv212/token-watcher/actions/runs/38745556505) passed all six checks; Linux X11/Dunst and permitted local ad-hoc macOS native card/activation acceptance passed; PR #61 records final evidence. Latest evidence: 2026-10-17. Dependencies: INS-01 and GUI-02 complete.

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

## Initial implementation validation and gates — 2026-10-15

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

Tagged desktop build [38964538508](https://github.com/thanhndv212/token-watcher/actions/runs/38964538508) passed both platforms. Native Linux/AppImage run [38964954082](https://github.com/thanhndv212/token-watcher/actions/runs/38964954082) passed all assertions against those exact checksummed artifacts: actual Dunst banner count, persisted desktop delivery, real default-action callback, selected provider/account/window and History heading. The [action capture](evidence/INS02-linux-rc2-native-action-history.png) was inspected. The exact AppImage also passed six-tab/preload/version/no-exception checks using extract-and-run; FUSE mounting and general desktop integration are not certified.

The first rc.2 root screenshot was a partial redraw. Capture follow-up 38965561481 produced the [inspected visible OS banner](evidence/INS02-linux-rc2-native-banner.png), then failed after successful assertions while deleting a still-changing Chromium cache. The harness now forces X11 repaint, delays capture one second and retries bounded profile cleanup. These changes affect acceptance tooling only; candidate binaries and tag remain unchanged.

The final macOS card/activation gate is now satisfied by the observed acceptance record below. Earlier attempts are retained chronologically: The initial Computer Use denial was resolved on 2026-10-17 after the user granted access. The locally ad-hoc-signed test then failed native delivery; see the observed attempt below. Do not claim this supplies banner/click acceptance. The ordinary exact downloaded macOS ZIP and CI-mounted DMG both passed isolated packaged runtime checks, which do not supply native banner/click evidence. Keep #20, M4 and the roadmap open, with the five-hour schedule active. No live reset, Developer ID, notarization or stable-release certification is claimed.

Final follow-up [38993028075](https://github.com/thanhndv212/token-watcher/actions/runs/38993028075) passed both exact-deb native acceptance and exact-AppImage runtime, including cleanup. Its action capture was inspected and versioned. Its root capture was again a partial redraw; the separately inspected visible banner from 38965561481 is retained with that run provenance. Both complete native/AppImage evidence archives are attached to the rc.2 draft. Root capture remains best-effort under Xvfb; the observed banner and successful action/runtime checks are separate evidence.

## macOS observed attempt after access grant — 2026-10-17

The user granted Computer Use access and native UI inspection now succeeds. System Settings showed Codex Computer Use screen recording enabled. The original rc.2 ZIP SHA256 was rechecked before extracting a separate local validation copy. The test changed only bundle metadata (distinct `ai.opencode.quota.validation.rc2` identity/display name) and applied local ad-hoc signing; production JavaScript and the draft assets/tag were not changed. `codesign --verify --deep --strict` passed for the first copy. This is not a Developer ID signature or a notarized artifact.

With explicit private XDG paths and `--user-data-dir`, the real app loaded the synthetic fixture provider and pending hourly reset. Actual History UI reported: “Desktop delivery failed or was denied; plugin fallback remains available. Reload settings to retry desktop delivery.” The native adapter was not mocked. macOS logs showed the bundle identifier entitlement check succeeding, followed by an add-notification completion with `hasError: 1`. The durable fixture event remained `pending`, with null delivery timestamp/channel. No banner or activation was observed. The exact underlying OS error was not exposed by these logs; do not infer a specific signing/permission cause from the generic failure.

A Finder registration/reopen attempt also failed to produce an observed banner. Finder launch did not retain the explicit Electron `--user-data-dir`; exclude that launch from isolated-profile acceptance. No quota settings or system notification preferences were edited. All task-owned validation app processes were stopped afterward. Local signing inventory still reports zero valid code-signing identities.

The [machine-readable attempt record](evidence/INS02-MACOS-NATIVE-ATTEMPT.json) distinguishes the original artifact from the locally modified test bundle. Remaining evidence: a properly recognized/signed app with permitted native delivery, a visibly observed notification, and activation selecting the exact provider/account/window History view. UI access is no longer the blocker; the rejected local ad-hoc attempt is a failed acceptance result. Keep #20/M4 and the schedule open. Repeating the unchanged ad-hoc setup is not additional acceptance evidence.

Standard-location follow-up: a unique temporary `/Applications/Quota Validation rc2.app` copy, launched with explicit private XDG settings and Electron `--user-data-dir`, produced a native show acknowledgement and persisted the fixture event as `delivered` via `desktop`. No existing application was replaced. This suggests application registration/location affected the earlier rejection, but the exact OS cause is not proven. A show acknowledgement is not visible notification acceptance. Computer Use could not capture the closed Notification Center (zero-size capture), and its key API rejected the documented Fn-N shortcut. The user was asked to open Notification Center for actual card inspection/activation. This gate remains pending; the test instance stays running for that observation. The local ad-hoc copy does not certify Developer ID/notarized distribution.

## Final observed macOS acceptance — 2026-10-17

**PASS, scoped local acceptance.** On macOS 26.6.2 arm64 / Electron 42.5.0, the user granted Computer Use access and explicitly authorized enabling notifications for only the temporary `Quota Validation rc2` app. System Settings initially showed Allow notifications off; enabling it was verified. A fresh synthetic hourly event (`c…c`) was inserted into the isolated journal. Computer Use inspected the actual Notification Center card: app `Quota Validation rc2`, title `Quota reset`, body `fixture-os-validation / hourly: quota replenished (100% remaining).` This is actual OS UI evidence, not an inferred show callback.

Clicking that freshly observed native card opened `Quota History`, provider `fixture-os-validation`, and `Window: hourly`. The manually seeded reset initially lacked its matching accounting observation; adding that synthetic observation and refreshing exposed the account option while retaining the callback account filter. The final inspected UI and screenshot show `Account aaaaaaaa`, the hourly filter and delivered event at 17:05:23 local time. No production code or native callback was replaced. The [final acceptance JSON](evidence/INS02-MACOS-NATIVE-ACCEPTANCE.json) records expected opaque identity, observed labels, payload hashes, permission authorization and cleanup. Earlier failed and acknowledgement-only phases remain separate evidence in the attempt record.

The test copy was extracted from the verified rc.2 ZIP, given a distinct bundle identity/display name and locally ad-hoc signed. Its production app/helper payload hashes matched the temporary source copy. This establishes permitted local native delivery/navigation for that tested copy; it does not certify native delivery from the unchanged unsigned draft binaries, Developer ID signing, notarization, Gatekeeper approval, live providers or stable publication. Exact Linux X11/Dunst acceptance remains separately recorded; other desktops are not inferred.

The test app was quit, its temporary notification permission restored off, and the uniquely created Applications copy removed without replacing a pre-existing app. Computer Use permission remains as granted by the user. Channel-policy, failure/uncertain fallback, concurrency/default-off and native package checks from the original implementation remain mandatory; this final observation completes their OS acceptance complement. Close #20/M4 after final protected delivery and green merged-main CI; optional/deferred work stays unchanged.
