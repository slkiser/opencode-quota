/**
 * Computes the text of the TUI quota surfaces: the sidebar panel, the toasts, the
 * session prompt line and the Home footer, plus the optional export file. The server
 * plugin serves these to the TUI over its RPC.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "./atomic-json.js";
import type { RuntimeContextRootHints } from "./config-file-utils.js";
import { sanitizeDisplayText } from "./display-sanitize.js";
import { formatQuotaRows } from "./format.js";
import {
  BUNDLED_MAINTAINER_ANNOUNCEMENTS,
  formatMaintainerAnnouncementHomeCountLine,
  getMaintainerAnnouncementsSummary,
  getMaintainerAnnouncementTargetProviderIds,
} from "./maintainer-announcements.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import { getQuotaProviderShape, normalizeQuotaProviderId } from "./provider-metadata.js";
import {
  buildQuotaExport,
  createExportProviderContext,
  resolveExportPath,
  writeQuotaExport,
} from "./quota-export.js";
import { resolveQuotaFormatStyle } from "./quota-format-style.js";
import {
  type CollectQuotaRenderDataResult,
  collectConcreteEnabledProviderIds,
  collectQuotaRenderData,
} from "./quota-render-data.js";
import {
  formatQuotaResetNotification,
  observeQuotaResetNotifications,
} from "./quota-reset-notifications.js";
import {
  createQuotaProviderRuntimeContext,
  createQuotaRuntimeRequestContext,
  type QuotaRuntimeClient,
  type QuotaRuntimeContext,
  type QuotaSessionModelContext,
  resolveQuotaRuntimeContext,
} from "./quota-runtime-context.js";
import { buildCompactQuotaStatusLine } from "./tui-compact-format.js";
import {
  formatPromptBarPercentMeta,
  pickPromptBarEntry,
  resolvePromptBarLabel,
} from "./tui-prompt-bar-format.js";
import { buildSidebarQuotaPanelLines } from "./tui-sidebar-format.js";
import type { QuotaToastConfig } from "./types.js";

/** Where the surfaces read settings, provider ids and the session model from. */
export type QuotaSurfaceHost = {
  client: QuotaRuntimeClient;
  roots: RuntimeContextRootHints;
  resolveSessionMeta: (sessionID: string) => Promise<QuotaSessionModelContext>;
};

export async function getQuotaMessage(
  host: QuotaSurfaceHost,
  sessionID: string,
  surface: "sidebar" | "idle" | "compacted" | "question",
): Promise<
  | { message: string; duration: number; activeProviderCount: number; resetNotification?: string }
  | undefined
> {
  const runtime = await resolveQuotaRuntimeContext({
    client: host.client,
    roots: host.roots,
    sessionID,
    resolveSessionMeta: host.resolveSessionMeta,
    includeSessionMeta: (config) => config.onlyCurrentModel,
  });
  const config = runtime.config;
  if (!config.enabled) return;
  if (surface === "sidebar") {
    if (!config.tuiSidebarPanel.enabled) return;
  } else if (!config.enableToast) {
    return;
  }
  if (
    (surface === "idle" && !config.showOnIdle) ||
    (surface === "compacted" && !config.showOnCompact) ||
    (surface === "question" && !config.showOnQuestion)
  ) {
    return;
  }

  if (
    surface !== "sidebar" &&
    config.debug &&
    config.enabledProviders !== "auto" &&
    config.enabledProviders.length === 0
  ) {
    return {
      message: sanitizeDisplayText(
        formatQuotaToastDebugInfo({
          trigger: surface,
          reason: "enabledProviders empty",
          config,
          configMeta: runtime.configMeta,
        }),
      ),
      duration: config.toastDurationMs,
      activeProviderCount: 0,
    };
  }

  const rootFormatStyle = resolveQuotaFormatStyle(config.formatStyle);
  const formatStyle =
    surface === "sidebar" && config.tuiSidebarPanel.formatStyle
      ? resolveQuotaFormatStyle(config.tuiSidebarPanel.formatStyle)
      : rootFormatStyle;
  const result = await collectQuotaRenderData({
    client: runtime.client,
    resolveRuntimeProviderIds: runtime.resolveRuntimeProviderIds,
    config,
    configMeta: runtime.configMeta,
    request: createQuotaRuntimeRequestContext(runtime),
    workspaceRoot: runtime.roots.workspaceRoot,
    surfaceExplicitProviderIssues: true,
    formatStyle,
    providers: runtime.providers,
  });
  let resetNotification: string | undefined;
  if (
    surface !== "sidebar" &&
    config.resetNotifications.enabled &&
    result.providerResults.length > 0
  ) {
    try {
      const notices = await observeQuotaResetNotifications({
        providers: result.providerResults,
        windows: config.resetNotifications.windows,
      });
      resetNotification = formatQuotaResetNotification(notices) ?? undefined;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[opencode-quota] failed to observe quota reset transitions: ${reason}`);
    }
  }
  const data = result.data;
  const message =
    surface === "sidebar"
      ? data
        ? buildSidebarQuotaPanelLines({
            data,
            config: {
              ...config,
              formatStyle,
            },
          }).join("\n")
        : undefined
      : getToastMessage({ trigger: surface, runtime, result, style: rootFormatStyle });
  return message
    ? {
        message: sanitizeDisplayText(message),
        duration: config.toastDurationMs,
        activeProviderCount: result.active.length,
        // The RPC route accepts only JSON values, so an unset notice leaves the key out.
        ...(resetNotification === undefined ? {} : { resetNotification }),
      }
    : undefined;
}

function getToastMessage(params: {
  trigger: string;
  runtime: QuotaRuntimeContext;
  result: CollectQuotaRenderDataResult;
  style: ReturnType<typeof resolveQuotaFormatStyle>;
}): string | undefined {
  const config = params.runtime.config;
  const { availability, active, hasExplicitProviderIssues, data } = params.result;
  const debugInfo = (reason: string) =>
    formatQuotaToastDebugInfo({
      trigger: params.trigger,
      reason,
      config,
      configMeta: params.runtime.configMeta,
      currentModel: params.result.selection?.currentModel,
      availability: availability.map((item) => ({ id: item.provider.id, ok: item.ok })),
    });

  if (data?.entries.length || data?.sessionTokens) {
    const formatted = formatQuotaRows({
      version: "2.0.0",
      layout: config.layout,
      entries: data?.entries ?? [],
      errors: data?.errors ?? [],
      style: params.style,
      percentDisplayMode: config.percentDisplayMode,
      percentLabelStyle: config.percentLabelStyle,
      accountingDetail: config.accountingDetail,
      resetTimeDecimals: config.resetTimeDecimals,
      resetTimeSpaced: config.resetTimeSpaced,
      sessionTokens: data?.sessionTokens,
    });
    if (!config.debug) return formatted;
    const debugFooter = `\n\n[debug] src=${params.runtime.configMeta.source} providers=${config.enabledProviders === "auto" ? "(auto)" : config.enabledProviders.join(",") || "(none)"} avail=${availability
      .map((item) => `${item.provider.id}:${item.ok ? "ok" : "no"}`)
      .join(" ")}`;
    return formatted + debugFooter;
  }

  if (config.showOnBothFail && data?.errors.length) {
    const errorLines = data.errors.map((error) => `${error.label}: ${error.message}`).join("\n");
    if (!config.debug) return errorLines;
    return `${errorLines}\n\n${debugInfo(
      hasExplicitProviderIssues ? "providers missing/unavailable" : "all providers failed",
    )}`;
  }

  if (!config.debug) return undefined;
  return debugInfo(active.length === 0 ? "no enabled providers available" : "no entries");
}

function formatQuotaToastDebugInfo(params: {
  trigger: string;
  reason: string;
  config: QuotaToastConfig;
  configMeta: Pick<QuotaRuntimeContext["configMeta"], "source" | "paths">;
  currentModel?: string;
  availability?: Array<{ id: string; ok: boolean }>;
}): string {
  const availability = params.availability
    ? params.availability.map((item) => `${item.id}=${item.ok ? "ok" : "no"}`).join(" ")
    : "unknown";

  const providers =
    params.config.enabledProviders === "auto"
      ? "(auto)"
      : params.config.enabledProviders.length > 0
        ? params.config.enabledProviders.join(",")
        : "(none)";

  const modelPart = params.currentModel ? ` model=${params.currentModel}` : "";
  const paths = params.configMeta.paths.length > 0 ? params.configMeta.paths.join(" | ") : "(none)";

  return [
    "Quota Toast Debug (opencode-quota)",
    `trigger=${params.trigger} reason=${params.reason}`,
    `configSource=${params.configMeta.source} paths=${paths}`,
    `enabled=${params.config.enabled} providers=${providers}${modelPart}`,
    `available=${availability}`,
  ].join("\n");
}

// A daily Home notice stays this long after it first shows on a day, so the
// footer's one-minute refresh does not hide it while you are on Home.
const DAILY_HOME_NOTICE_VISIBLE_MS = 10 * 60_000;

type DailyHomeNoticeClaim = { day: string; shownAtMs: number };

/** Today's claim when the state file could not be written; keeps this process to once a day. */
let unsavedDailyHomeNoticeClaim: DailyHomeNoticeClaim | undefined;

/**
 * Whether the daily Home notice may show now. The first call on each local day
 * starts that day's window and records it in the state dir.
 */
async function claimDailyHomeNotice(nowMs: number): Promise<boolean> {
  const statePath = join(
    getOpencodeRuntimeDirs().stateDir,
    "opencode-quota",
    "maintainer-announcements-home.json",
  );
  const now = new Date(nowMs);
  const day = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  let shownAtMs: number | undefined;
  try {
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      day?: unknown;
      shownAtMs?: unknown;
    };
    if (state.day === day && Number.isFinite(state.shownAtMs)) {
      shownAtMs = state.shownAtMs as number;
    }
  } catch {
    // No state yet, or unreadable: fall back to this process's claim.
  }
  if (shownAtMs === undefined && unsavedDailyHomeNoticeClaim?.day === day) {
    shownAtMs = unsavedDailyHomeNoticeClaim.shownAtMs;
  }
  if (shownAtMs !== undefined) {
    // A claim from the future (the clock went back) counts as used up.
    const elapsedMs = nowMs - shownAtMs;
    return elapsedMs >= 0 && elapsedMs < DAILY_HOME_NOTICE_VISIBLE_MS;
  }
  const claim: DailyHomeNoticeClaim = { day, shownAtMs: nowMs };
  try {
    await writeJsonAtomic(statePath, claim, {
      trailingNewline: true,
      directoryMode: 0o700,
      fileMode: 0o600,
    });
  } catch {
    unsavedDailyHomeNoticeClaim = claim;
  }
  return true;
}

async function getHomeAnnouncementText(runtime: QuotaRuntimeContext): Promise<string> {
  const announcements = BUNDLED_MAINTAINER_ANNOUNCEMENTS;
  const targetProviderIds = new Set(getMaintainerAnnouncementTargetProviderIds({ announcements }));
  const announcementProviders = runtime.providers.filter((provider) => {
    const shape = getQuotaProviderShape(normalizeQuotaProviderId(provider.id));
    return shape ? targetProviderIds.has(shape.id) : false;
  });
  const providerIds = await collectConcreteEnabledProviderIds({
    providers: announcementProviders,
    ctx: createQuotaProviderRuntimeContext({
      ...runtime,
      workspaceRoot: runtime.roots.workspaceRoot,
    }),
    enabledProviders: runtime.config.enabledProviders,
  });
  const summary = getMaintainerAnnouncementsSummary({
    enabledProviders: providerIds,
    announcements,
  });
  // Only a day with an active notice uses up that day's showing.
  if (
    summary.activeCount > 0 &&
    runtime.config.maintainerAnnouncements.homeFrequency !== "always" &&
    !(await claimDailyHomeNotice(Date.now()))
  ) {
    return "";
  }
  return formatMaintainerAnnouncementHomeCountLine(summary.activeCount);
}

export async function getQuotaFooter(
  host: QuotaSurfaceHost,
  sessionID: string | undefined,
  surface: "prompt" | "home",
): Promise<string[]> {
  // OpenCode 2 also mounts the prompt footer under the Home prompt, without a
  // session. As in v4, the prompt line belongs to session prompts only.
  if (surface === "prompt" && !sessionID) return [];
  const resolvedRuntime = await resolveQuotaRuntimeContext({
    client: host.client,
    roots: host.roots,
    sessionID,
    resolveSessionMeta: host.resolveSessionMeta,
    includeSessionMeta: (config) => config.onlyCurrentModel && surface === "prompt",
  });
  // Home has no session: as in v4, it shows every enabled provider and no session
  // tokens, and shares its cache keys with the export (createExportProviderContext).
  const runtime: QuotaRuntimeContext =
    surface === "home"
      ? {
          ...resolvedRuntime,
          config: { ...resolvedRuntime.config, onlyCurrentModel: false, showSessionTokens: false },
          session: {},
        }
      : resolvedRuntime;
  const config = runtime.config;
  if (!config.enabled) return [];
  if (
    surface === "prompt" &&
    !config.tuiPromptBar.enabled &&
    !(config.tuiCompactStatus.enabled && config.tuiCompactStatus.sessionPrompt)
  )
    return [];
  const announcementEnabled =
    surface === "home" &&
    config.maintainerAnnouncements.enabled &&
    config.maintainerAnnouncements.home;
  const homeCompactEnabled = config.tuiCompactStatus.enabled && config.tuiCompactStatus.homeBottom;
  if (surface === "home" && !announcementEnabled && !homeCompactEnabled) return [];
  const announcement = announcementEnabled ? await getHomeAnnouncementText(runtime) : "";
  if (surface === "home" && !homeCompactEnabled) return announcement ? [announcement] : [];
  const rootFormatStyle = resolveQuotaFormatStyle(config.formatStyle);
  const compactFormatStyle = config.tuiCompactStatus.formatStyle
    ? resolveQuotaFormatStyle(config.tuiCompactStatus.formatStyle)
    : rootFormatStyle;
  const result = await collectQuotaRenderData({
    client: runtime.client,
    resolveRuntimeProviderIds: runtime.resolveRuntimeProviderIds,
    config,
    configMeta: runtime.configMeta,
    request: createQuotaRuntimeRequestContext(runtime),
    workspaceRoot: runtime.roots.workspaceRoot,
    surfaceExplicitProviderIssues: true,
    formatStyle: rootFormatStyle,
    providers: runtime.providers,
    includeAllWindowsData: true,
  });
  const data = result.data;
  if (!data) return announcement ? [announcement] : [];
  if (surface === "prompt" && config.tuiPromptBar.enabled) {
    const entry = pickPromptBarEntry(data);
    if (!entry) return [];
    const promptBar = sanitizeDisplayText(
      [
        resolvePromptBarLabel(entry),
        entry.percentRemaining === undefined
          ? ""
          : formatPromptBarPercentMeta({
              percentRemaining: entry.percentRemaining,
              percentDisplayMode: config.percentDisplayMode,
              resetTimeIso: entry.resetTimeIso,
              resetTimeDecimals: config.resetTimeDecimals,
              resetTimeSpaced: config.resetTimeSpaced,
              runway: entry.runway,
            }),
      ]
        .filter(Boolean)
        .join(" | "),
    );
    return promptBar ? [promptBar] : [];
  }
  const compactData =
    compactFormatStyle === "allWindows" && result.allWindowsData
      ? result.allWindowsData
      : compactFormatStyle === "singleWindow" && result.singleWindowData !== undefined
        ? result.singleWindowData
        : data;
  const compact = compactData
    ? buildCompactQuotaStatusLine({
        data: compactData,
        maxWidth: config.tuiCompactStatus.maxWidth,
        percentDisplayMode: config.percentDisplayMode,
        accountingDetail: config.accountingDetail,
        resetTimeSpaced: config.resetTimeSpaced,
      })
    : "";
  return [announcement, compact].filter(Boolean);
}

/**
 * Writes the quota export file if `config.export.enabled` is true and returns whether it
 * wrote the file. Errors propagate.
 */
export async function writeQuotaExportIfEnabled(host: QuotaSurfaceHost): Promise<boolean> {
  const runtime = await resolveQuotaRuntimeContext({
    client: host.client,
    roots: host.roots,
  });
  if (!runtime.config.enabled || !runtime.config.export.enabled) return false;

  const exportData = await buildQuotaExport({
    providers: runtime.providers,
    ctx: createExportProviderContext(runtime),
    ttlMs: runtime.config.minIntervalMs,
    fromCache: true,
  });
  await writeQuotaExport(exportData, resolveExportPath(runtime.config.export.path));
  return true;
}
