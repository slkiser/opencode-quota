import {
  getCachedAccessToken,
  makeAccountCacheKey,
  setCachedAccessToken,
} from "./google-token-cache.js";
import { fetchWithTimeout } from "./http.js";

const TOKEN_REFRESH_URL = "https://oauth2.googleapis.com/token";
const TOKEN_TIMEOUT_MS = 8_000;

async function refreshAccessToken(params: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  timeoutMs?: number;
}): Promise<{ accessToken: string; expiresIn: number } | { error: string }> {
  try {
    return await fetchWithTimeout(TOKEN_REFRESH_URL, {
      request: {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: params.clientId,
          client_secret: params.clientSecret,
          refresh_token: params.refreshToken,
          grant_type: "refresh_token",
        }),
      },
      timeoutMs: params.timeoutMs ?? TOKEN_TIMEOUT_MS,
      consume: async (response, timeoutSignal) => {
        if (!response.ok) {
          try {
            const errorData = (await response.json()) as {
              error?: string;
              error_description?: string;
            };
            if (errorData.error === "invalid_grant") {
              return { error: "Token revoked" };
            }
            return { error: errorData.error_description || `HTTP ${response.status}` };
          } catch (error) {
            if (timeoutSignal.aborted) throw error;
            return { error: `HTTP ${response.status}` };
          }
        }

        const data = (await response.json()) as {
          access_token: string;
          expires_in: number;
        };

        return {
          accessToken: data.access_token,
          expiresIn: data.expires_in,
        };
      },
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("timeout")) {
      return { error: "Token refresh timeout" };
    }
    return { error: "Token refresh failed" };
  }
}

export async function getGoogleAccessToken(params: {
  account: {
    refreshToken: string;
    projectId: string;
    accessToken?: string;
    expiresAt?: number;
  };
  credentials: { clientId: string; clientSecret: string };
  skewMs?: number;
  force?: boolean;
  timeoutMs?: number;
}): Promise<{ accessToken: string } | { error: string }> {
  const skewMs = params.skewMs ?? 2 * 60_000;
  const key = makeAccountCacheKey({
    refreshToken: params.account.refreshToken,
    projectId: params.account.projectId,
  });

  if (!params.force) {
    const cached = await getCachedAccessToken({ key, skewMs });
    if (cached) return { accessToken: cached.accessToken };

    if (
      params.account.accessToken &&
      typeof params.account.expiresAt === "number" &&
      params.account.expiresAt > Date.now() + skewMs
    ) {
      return { accessToken: params.account.accessToken };
    }
  }

  const refreshed = await refreshAccessToken({
    refreshToken: params.account.refreshToken,
    clientId: params.credentials.clientId,
    clientSecret: params.credentials.clientSecret,
    timeoutMs: params.timeoutMs,
  });
  if ("error" in refreshed) return refreshed;

  await setCachedAccessToken({
    key,
    entry: {
      accessToken: refreshed.accessToken,
      expiresAt: Date.now() + Math.max(1, refreshed.expiresIn) * 1000,
    },
  });

  return { accessToken: refreshed.accessToken };
}
