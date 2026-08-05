import { REQUEST_TIMEOUT_MS } from "./types.js";

export const NINE_ROUTER_MAX_BODY_BYTES = 256 * 1024;

export type NineRouterHttpResult =
  | { readonly success: true; readonly body: unknown }
  | { readonly success: false; readonly error: string; readonly retryAfterMs?: number };

async function readBoundedJson(response: Response): Promise<NineRouterHttpResult> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!contentType || (contentType !== "application/json" && !contentType.endsWith("+json"))) {
    return { success: false, error: "Expected a JSON response" };
  }
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > NINE_ROUTER_MAX_BODY_BYTES) {
    return { success: false, error: "Response exceeded 262144 bytes" };
  }
  const reader = response.body?.getReader();
  if (!reader) return { success: false, error: "Invalid JSON response" };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > NINE_ROUTER_MAX_BODY_BYTES) {
        await reader.cancel();
        return { success: false, error: "Response exceeded 262144 bytes" };
      }
      chunks.push(chunk.value);
    }
  } catch {
    return { success: false, error: "Failed to read nineRouter response" };
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { success: true, body: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { success: false, error: "Invalid JSON response" };
  }
}

function parseRetryAfterMs(value: string | null): number | undefined {
  const seconds = Number(value?.trim());
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 900000) : undefined;
}

export function createNineRouterManagementRequest(
  root: string,
  key: string,
): (path: string, timeoutMs?: number) => Promise<NineRouterHttpResult> {
  return async (path, timeoutMs = REQUEST_TIMEOUT_MS) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${root}${path}`, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      });
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        return { success: false, error: "Redirect rejected" };
      }
      if (!response.ok) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
        return {
          success: false,
          error: `HTTP ${response.status}`,
          ...(retryAfterMs ? { retryAfterMs } : {}),
        };
      }
      return readBoundedJson(response);
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        return { success: false, error: `Request timeout after ${Math.round(timeoutMs / 1000)}s` };
      }
      return { success: false, error: "Failed to read nineRouter response" };
    } finally {
      clearTimeout(timer);
    }
  };
}
