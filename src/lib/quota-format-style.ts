export const SINGLE_WINDOW_PER_PROVIDER_FORMAT_STYLE = "singleWindow" as const;
export const ALL_WINDOWS_FORMAT_STYLE = "allWindows" as const;
export const DEFAULT_QUOTA_FORMAT_STYLE = SINGLE_WINDOW_PER_PROVIDER_FORMAT_STYLE;

export type CanonicalQuotaFormatStyle =
  | typeof SINGLE_WINDOW_PER_PROVIDER_FORMAT_STYLE
  | typeof ALL_WINDOWS_FORMAT_STYLE;

export type QuotaFormatStyle = CanonicalQuotaFormatStyle | "classic" | "grouped";

export type QuotaFormatProjection = "singleWindowPerProvider" | "allWindows";
export type QuotaFormatRenderer = "classic" | "grouped";
export type QuotaFormatSessionTokens = "summary" | "detailed";

export type QuotaFormatStyleDefinition = {
  id: CanonicalQuotaFormatStyle;
  aliases: readonly QuotaFormatStyle[];
  label: string;
  projection: QuotaFormatProjection;
  renderer: QuotaFormatRenderer;
  sessionTokens: QuotaFormatSessionTokens;
};

const QUOTA_FORMAT_STYLE_DEFINITIONS = {
  [SINGLE_WINDOW_PER_PROVIDER_FORMAT_STYLE]: {
    id: SINGLE_WINDOW_PER_PROVIDER_FORMAT_STYLE,
    aliases: [SINGLE_WINDOW_PER_PROVIDER_FORMAT_STYLE, "classic"],
    label: "Single window",
    projection: "singleWindowPerProvider",
    renderer: "classic",
    sessionTokens: "summary",
  },
  [ALL_WINDOWS_FORMAT_STYLE]: {
    id: ALL_WINDOWS_FORMAT_STYLE,
    aliases: [ALL_WINDOWS_FORMAT_STYLE, "grouped"],
    label: "All windows",
    projection: "allWindows",
    renderer: "grouped",
    sessionTokens: "detailed",
  },
} as const satisfies Record<CanonicalQuotaFormatStyle, QuotaFormatStyleDefinition>;

const QUOTA_FORMAT_STYLE_ALIAS_MAP = new Map<QuotaFormatStyle, CanonicalQuotaFormatStyle>(
  Object.values(QUOTA_FORMAT_STYLE_DEFINITIONS).flatMap((definition) =>
    definition.aliases.map((alias) => [alias, definition.id] as const),
  ),
);

export function isQuotaFormatStyle(value: unknown): value is QuotaFormatStyle {
  return typeof value === "string" && QUOTA_FORMAT_STYLE_ALIAS_MAP.has(value as QuotaFormatStyle);
}

export function resolveQuotaFormatStyle(value: unknown): CanonicalQuotaFormatStyle {
  if (!isQuotaFormatStyle(value)) {
    return DEFAULT_QUOTA_FORMAT_STYLE;
  }

  return QUOTA_FORMAT_STYLE_ALIAS_MAP.get(value)!;
}

export function getQuotaFormatStyleDefinition(value: unknown): QuotaFormatStyleDefinition {
  return QUOTA_FORMAT_STYLE_DEFINITIONS[resolveQuotaFormatStyle(value)];
}

export function getQuotaFormatStyleLabel(value: unknown): string {
  return getQuotaFormatStyleDefinition(value).label;
}
