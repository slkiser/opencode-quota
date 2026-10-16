import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import { execSync } from "node:child_process";
// Device fingerprints MUST be stable across restarts: Cursor keys "device
// identity" off the ids embedded in x-cursor-checksum, and treats every new
// machineId as a separate device ("too many connections from different
// devices"). The real Cursor CLI derives these from stable OS identifiers
// (IOPlatformUUID / MAC address) rather than persisting them, so recomputing
// each launch yields the SAME value forever on a given machine. We replicate
// that derivation verbatim so we present exactly one device, matching the CLI.
//
// Source: cursor-agent-extracted — machineId = sha256(IOPlatformUUID) with a
// MAC/hostname fallback; macMachineId = sha256(first non-zero MAC).
let _cached;
function sha256hex(s) {
    return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}
// macOS: `ioreg -rd1 -c IOPlatformExpertDevice` → IOPlatformUUID, parsed and
// normalised exactly as the CLI does.
function readMacOSUUID() {
    try {
        const out = execSync("ioreg -rd1 -c IOPlatformExpertDevice", {
            timeout: 5000,
        }).toString();
        const after = out.split("IOPlatformUUID")[1];
        if (!after)
            return undefined;
        return after
            .split("\n")[0]
            .replace(/=|\s+|"/gi, "")
            .toLowerCase();
    }
    catch {
        return undefined;
    }
}
// Linux: machine-id files (stable, per-install).
function readLinuxMachineId() {
    for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
        try {
            const v = fs.readFileSync(p, "utf8");
            if (v)
                return v.trim();
        }
        catch {
            /* ignore */
        }
    }
    return undefined;
}
// Windows: MachineGuid from the registry.
function readWindowsMachineGuid() {
    try {
        const out = execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', { timeout: 5000 }).toString();
        const m = out.split("MachineGuid")[1];
        if (!m)
            return undefined;
        const hex = m.replace(/=|\s+|"/gi, "");
        return hex || undefined;
    }
    catch {
        return undefined;
    }
}
function platformUuid() {
    switch (process.platform) {
        case "darwin":
            return readMacOSUUID();
        case "linux":
            return readLinuxMachineId();
        case "win32":
            return readWindowsMachineGuid();
        default:
            return undefined;
    }
}
// First non-zero MAC address across all interfaces (matches CLI's $e()).
function firstMacAddress() {
    try {
        const ifaces = os.networkInterfaces();
        for (const list of Object.values(ifaces)) {
            if (!list)
                continue;
            for (const ni of list) {
                if (ni && ni.mac && ni.mac !== "00:00:00:00:00:00")
                    return ni.mac;
            }
        }
    }
    catch {
        /* ignore */
    }
    return undefined;
}
/**
 * Stable device fingerprints, derived exactly like the Cursor CLI.
 * Cached for the process lifetime after first computation.
 */
export function getDeviceIds() {
    if (_cached)
        return _cached;
    const mac = firstMacAddress();
    const uuid = platformUuid();
    // machineId: sha256(platform UUID); fall back to sha256(MAC) then hostname,
    // mirroring the CLI's Xe() fallback chain.
    let machineId;
    if (uuid) {
        machineId = sha256hex(uuid);
    }
    else if (mac) {
        machineId = sha256hex(mac);
    }
    else {
        machineId = sha256hex(os.hostname());
    }
    // macMachineId: sha256(MAC), or undefined if no interface MAC is available.
    const macMachineId = mac ? sha256hex(mac) : undefined;
    _cached = { machineId, macMachineId };
    return _cached;
}
