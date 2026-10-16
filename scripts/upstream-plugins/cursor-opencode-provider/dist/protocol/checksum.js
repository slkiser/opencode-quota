export function obfuscate(bytes) {
    const out = new Uint8Array(bytes);
    let a = 165;
    for (let i = 0; i < out.length; i++) {
        out[i] = ((out[i] ^ a) + i) & 0xff;
        a = out[i];
    }
    return out;
}
export function createCursorChecksumHeader(machineId, macMachineId) {
    const n = Math.floor(Date.now() / 1e6);
    const ts = new Uint8Array([
        (n >> 40) & 0xff,
        (n >> 32) & 0xff,
        (n >> 24) & 0xff,
        (n >> 16) & 0xff,
        (n >> 8) & 0xff,
        n & 0xff,
    ]);
    const obfuscated = obfuscate(ts);
    const prefix = btoa(String.fromCharCode(...obfuscated)).replace(/=+$/, "");
    return macMachineId ? `${prefix}${machineId}/${macMachineId}` : `${prefix}${machineId}`;
}
