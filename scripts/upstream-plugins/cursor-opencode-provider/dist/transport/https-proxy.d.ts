/**
 * HTTPS proxy helpers for the Cursor Run HTTP/2 transport.
 *
 * Unary RPCs use Bun `fetch()`, which already honors HTTPS_PROXY / NO_PROXY.
 * `node:http2` does not, so Run sessions tunnel through an HTTP CONNECT proxy
 * when those env vars apply. See GitHub issue #26.
 *
 * Important (Bun 1.3.x): do the CONNECT handshake on a native `net.Socket`,
 * then `tls.connect({ socket })` on that same socket. Do not insert a custom
 * Duplex between the proxy socket and TLS — destroying such a session mid-
 * handshake can segfault Bun.
 */
import net from "node:net";
import tls from "node:tls";
export type ProxyEnv = Record<string, string | undefined>;
/**
 * HTTPS_PROXY / https_proxy for an HTTPS target. Like curl, HTTP_PROXY is not
 * consulted for HTTPS. Only `http://` proxies can carry the CONNECT tunnel;
 * `https://` (TLS to the proxy) and other schemes are ignored so the Run keeps
 * its direct connection rather than failing on every connect.
 */
export declare function resolveHttpsProxyUrl(targetHost: string, env?: ProxyEnv, targetPort?: number): URL | undefined;
/**
 * curl/Node-style NO_PROXY matching: `*`, exact host, optional `:port`, and
 * leading-dot / bare-domain suffix forms (`.corp.example` / `corp.example`).
 * A port-qualified entry only bypasses that port.
 */
export declare function hostMatchesNoProxy(targetHost: string, noProxy: string | undefined, targetPort?: number): boolean;
/** Dialable proxy address: IPv6 literals without URL brackets, default port 80. */
export declare function proxyEndpoint(proxy: URL): {
    host: string;
    port: number;
};
export type OpenHttpsConnectTunnelOptions = {
    proxy: URL;
    targetHost: string;
    targetPort?: number;
    signal?: AbortSignal;
    /** Injected for tests. */
    connect?: typeof net.connect;
};
/**
 * Open a plain TCP connection to the proxy and establish an HTTP CONNECT tunnel
 * to `targetHost:targetPort`. Returns the tunneled socket ready for TLS.
 */
export declare function openHttpsConnectTunnel(options: OpenHttpsConnectTunnelOptions): Promise<net.Socket>;
export type OpenProxiedTlsSocketOptions = {
    proxy: URL;
    targetHost: string;
    targetPort?: number;
    signal?: AbortSignal;
    connect?: typeof net.connect;
    tlsConnect?: typeof tls.connect;
};
/** CONNECT through the proxy, then complete TLS (ALPN h2) on the native socket. */
export declare function openProxiedTlsSocket(options: OpenProxiedTlsSocketOptions): Promise<tls.TLSSocket>;
