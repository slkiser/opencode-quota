import { en } from "./i18n/catalog.js";
import { zhHans } from "./i18n/zh-Hans.js";

export type UiLocale = "en" | "zh-Hans";
export type UiLanguage = "auto" | UiLocale;
export type TranslationParams = Readonly<Record<string, string | number | boolean>>;
export type Localization = {
  locale: () => UiLocale;
  t: (key: string, params?: TranslationParams) => string;
  plural: (key: string, count: number, params?: TranslationParams) => string;
};

const CATALOGS: Readonly<Record<UiLocale, Readonly<Record<string, string>>>> = {
  en,
  "zh-Hans": zhHans,
};

/** Resolves the persisted choice against a host BCP 47 locale; unsupported locales use English. */
export function resolveUiLocale(language: string, hostLocale?: string): UiLocale {
  if (language === "en" || language === "zh-Hans") return language;
  const detected = (hostLocale ?? Intl.DateTimeFormat().resolvedOptions().locale).replaceAll(
    "_",
    "-",
  );
  if (/^zh(?:-(?:Hans|CN|SG)(?:-|$)|$)/iu.test(detected)) return "zh-Hans";
  return "en";
}

function interpolate(template: string, params?: TranslationParams): string {
  if (!params) return template;
  return template.replace(/\{\{\s*([^{}\s]+)\s*\}\}/gu, (match, key: string) =>
    Object.hasOwn(params, key) ? String(params[key]) : match,
  );
}

/** Looks up a translated key, falling back to English for this key alone. */
export function translate(locale: UiLocale, key: string, params?: TranslationParams): string {
  const template = CATALOGS[locale][key] ?? CATALOGS.en[key] ?? key;
  return interpolate(template, params);
}

/** Translates a count-sensitive key using the locale's CLDR plural category. */
export function translatePlural(
  locale: UiLocale,
  key: string,
  count: number,
  params: TranslationParams = {},
): string {
  const category = new Intl.PluralRules(locale).select(count);
  const pluralKey = `${key}.${category}`;
  const template =
    CATALOGS[locale][pluralKey] ??
    CATALOGS.en[pluralKey] ??
    CATALOGS[locale][`${key}.other`] ??
    CATALOGS.en[`${key}.other`] ??
    CATALOGS[locale][key] ??
    CATALOGS.en[key] ??
    key;
  return interpolate(template, { ...params, count });
}

/** Intl's canonical formatting locale for supported interface languages. */
export function intlLocale(locale: UiLocale): string {
  return locale === "zh-Hans" ? "zh-Hans" : "en-US";
}

/** A reactive translator; the host locale is consulted only while the saved choice is `auto`. */
export function createLocalization(language: () => string, hostLocale: () => string): Localization {
  const locale = () => resolveUiLocale(language(), hostLocale());
  return {
    locale,
    t: (key, params) => translate(locale(), key, params),
    plural: (key, count, params) => translatePlural(locale(), key, count, params),
  };
}

/** Overrides only localization methods while forwarding every other host API unchanged. */
export function withLocalization<T extends object>(
  host: T,
  localization: Localization,
): T & Localization {
  return new Proxy(host as T & Localization, {
    get(target, key, receiver) {
      if (key === "locale") return localization.locale;
      if (key === "t") return localization.t;
      if (key === "plural") return localization.plural;
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
}

export { en, zhHans };
