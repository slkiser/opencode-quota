# INS-02 — Desktop and plugin reset notices

Issue: [#20](https://github.com/thanhndv212/opencode-quota/issues/20). Status: implemented; local acceptance passed; hosted checks and observed OS delivery gates remain open. Evidence date: 2026-10-15. Dependencies: INS-01 and GUI-02 complete.

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

**Linux:** CI's installed Electron smoke exercises startup/IPC/navigation under its fixture environment. No observed desktop notification-daemon delivery, denied-permission session or real system-tray delivery certification. These remain an explicit external acceptance gate on issue #20.

Keep issue #20 open until platform evidence is attached; do not mark M4 or the roadmap complete from unit/fixture checks. Continue INS-03 and M5 independently while these gates are unavailable.
