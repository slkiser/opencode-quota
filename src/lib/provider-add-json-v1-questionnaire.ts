import {
  JSON_V1_MAX_MAPPINGS,
  JSON_V1_MAX_PATH_SEGMENTS,
  type JsonV1Adapter,
  type JsonV1Mapping,
  type JsonV1Metric,
  type JsonV1NumberSource,
  type JsonV1Path,
  type JsonV1TextSource,
  type JsonV1TimestampEncoding,
  type JsonV1TimestampSource,
} from "./quota-providers.js";

type PromptOption<T extends string> = {
  label: string;
  value: T;
  hint?: string;
};

export interface JsonV1QuestionnairePrompts {
  select: (options: {
    message: string;
    options: Array<PromptOption<string>>;
    initialValue?: string;
  }) => Promise<unknown>;
  text: (options: {
    message: string;
    placeholder?: string;
    initialValue?: string;
  }) => Promise<unknown>;
  confirm: (options: { message: string; initialValue?: boolean }) => Promise<unknown>;
  isCancel: (value: unknown) => boolean;
}

export type JsonV1QuestionnaireResult =
  | { state: "complete"; adapter: JsonV1Adapter }
  | { state: "cancelled" };

const RESULT_TYPE_OPTIONS: Array<PromptOption<JsonV1Mapping["resultType"]>> = [
  { label: "Quota", value: "quota" },
  { label: "Rate limit", value: "rate_limit" },
  { label: "Usage", value: "usage" },
  { label: "Spend", value: "spend" },
  { label: "Budget", value: "budget" },
  { label: "Balance", value: "balance" },
  { label: "Status", value: "status" },
];

const TIMESTAMP_ENCODING_OPTIONS: Array<PromptOption<JsonV1TimestampEncoding>> = [
  { label: "ISO 8601", value: "iso-8601", hint: "Example: 2026-07-23T12:00:00Z" },
  { label: "Unix seconds", value: "unix-seconds" },
  { label: "Unix milliseconds", value: "unix-milliseconds" },
];

function requiredText(value: unknown, prompts: JsonV1QuestionnairePrompts): string | null {
  if (prompts.isCancel(value)) return null;
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function optionalText(
  value: unknown,
  prompts: JsonV1QuestionnairePrompts,
): string | undefined | null {
  if (prompts.isCancel(value)) return null;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value.trim();
}

async function selectChoice<T extends string>(
  prompts: JsonV1QuestionnairePrompts,
  options: {
    message: string;
    options: Array<PromptOption<T>>;
    initialValue?: T;
  },
): Promise<T | null> {
  const value = await prompts.select(options);
  if (
    prompts.isCancel(value) ||
    typeof value !== "string" ||
    !options.options.some((option) => option.value === value)
  ) {
    return null;
  }
  return value as T;
}

async function confirmChoice(
  prompts: JsonV1QuestionnairePrompts,
  message: string,
  initialValue: boolean,
): Promise<boolean | null> {
  const value = await prompts.confirm({ message, initialValue });
  return prompts.isCancel(value) || typeof value !== "boolean" ? null : value;
}

async function promptPath(
  prompts: JsonV1QuestionnairePrompts,
  purpose: string,
): Promise<JsonV1Path | null> {
  const path: string[] = [];
  while (path.length < JSON_V1_MAX_PATH_SEGMENTS) {
    const ordinal = path.length + 1;
    const segment = requiredText(
      await prompts.text({
        message: `${purpose}: property segment ${ordinal}`,
        placeholder: ordinal === 1 ? "data" : "items",
      }),
      prompts,
    );
    if (!segment) return null;
    path.push(segment);

    if (path.length === JSON_V1_MAX_PATH_SEGMENTS) return path;
    const addSegment = await confirmChoice(
      prompts,
      `Add another property segment to ${purpose}?`,
      false,
    );
    if (addSegment === null) return null;
    if (!addSegment) return path;
  }
  return path;
}

async function promptNumberSource(
  prompts: JsonV1QuestionnairePrompts,
  name: string,
): Promise<JsonV1NumberSource | null> {
  const sourceType = await selectChoice(prompts, {
    message: `${name} source`,
    options: [
      { label: "Response field", value: "path", hint: "Choose property segments" },
      { label: "Fixed number", value: "literal", hint: "Saved in the config preview" },
    ],
    initialValue: "path",
  });
  if (!sourceType) return null;

  if (sourceType === "literal") {
    const literal = requiredText(
      await prompts.text({ message: `${name} fixed number`, placeholder: "0" }),
      prompts,
    );
    return literal === null ? null : { literal: Number(literal) };
  }

  const path = await promptPath(prompts, `${name} response field`);
  if (!path) return null;
  const divideBy = await selectChoice(prompts, {
    message: `Scale ${name} after reading it?`,
    options: [
      { label: "Do not scale", value: "none" },
      { label: "Divide by 100", value: "100" },
      { label: "Divide by 1,000", value: "1000" },
      { label: "Divide by 1,000,000", value: "1000000" },
    ],
    initialValue: "none",
  });
  if (!divideBy) return null;
  if (divideBy === "none") return { path };
  return { path, divideBy: Number(divideBy) as 100 | 1_000 | 1_000_000 };
}

async function promptTextSource(
  prompts: JsonV1QuestionnairePrompts,
  name: string,
): Promise<JsonV1TextSource | null> {
  const sourceType = await selectChoice(prompts, {
    message: `${name} source`,
    options: [
      { label: "Response field", value: "path", hint: "Choose property segments" },
      { label: "Fixed text", value: "literal", hint: "Saved in the config preview" },
    ],
    initialValue: "path",
  });
  if (!sourceType) return null;

  if (sourceType === "literal") {
    const literal = requiredText(
      await prompts.text({ message: `${name} fixed text`, placeholder: "Available" }),
      prompts,
    );
    return literal === null ? null : { literal };
  }

  const path = await promptPath(prompts, `${name} response field`);
  return path ? { path } : null;
}

async function promptTimestampSource(
  prompts: JsonV1QuestionnairePrompts,
  name: string,
): Promise<JsonV1TimestampSource | null> {
  const sourceType = await selectChoice(prompts, {
    message: `${name} source`,
    options: [
      { label: "Response field", value: "path", hint: "Choose property segments" },
      { label: "Fixed timestamp", value: "literal", hint: "Saved in the config preview" },
    ],
    initialValue: "path",
  });
  if (!sourceType) return null;

  const encoding = await selectChoice(prompts, {
    message: `${name} format`,
    options: TIMESTAMP_ENCODING_OPTIONS,
    initialValue: "iso-8601",
  });
  if (!encoding) return null;

  if (sourceType === "path") {
    const path = await promptPath(prompts, `${name} response field`);
    return path ? { path, encoding } : null;
  }

  const literal = requiredText(
    await prompts.text({
      message: `${name} fixed value`,
      placeholder: encoding === "iso-8601" ? "2026-07-23T12:00:00Z" : "1784808000",
    }),
    prompts,
  );
  if (literal === null) return null;
  return {
    literal: encoding === "iso-8601" ? literal : Number(literal),
    encoding,
  };
}

async function promptOptionalTimestamp(
  prompts: JsonV1QuestionnairePrompts,
  name: string,
): Promise<JsonV1TimestampSource | undefined | null> {
  const include = await confirmChoice(prompts, `Add ${name}?`, false);
  if (include === null) return null;
  if (!include) return undefined;
  return promptTimestampSource(prompts, name);
}

function metricOptions(
  resultType: JsonV1Mapping["resultType"],
): Array<PromptOption<string>> | undefined {
  if (resultType === "quota" || resultType === "rate_limit") {
    return [
      { label: "Percentage", value: "percentage" },
      { label: "Used and limit", value: "used-limit" },
      { label: "Remaining and limit", value: "remaining-limit" },
      { label: "Used value", value: "value-used" },
      { label: "Limit value", value: "value-limit" },
      { label: "Remaining value", value: "value-remaining" },
    ];
  }
  if (resultType === "budget") {
    return [
      { label: "Percentage", value: "percentage" },
      { label: "Spend and budget", value: "spend-budget" },
      { label: "Remaining and budget", value: "remaining-budget" },
      { label: "Budget value", value: "value-budget" },
    ];
  }
  return undefined;
}

async function promptMetric(
  prompts: JsonV1QuestionnairePrompts,
  resultType: JsonV1Mapping["resultType"],
): Promise<JsonV1Metric | null> {
  let metricType: string;
  const options = metricOptions(resultType);
  if (options) {
    const selected = await selectChoice(prompts, {
      message: "How should this result be calculated?",
      options,
      initialValue: options[0]!.value,
    });
    if (!selected) return null;
    metricType = selected;
  } else {
    metricType =
      resultType === "usage"
        ? "value-used"
        : resultType === "spend"
          ? "value-spend"
          : resultType === "balance"
            ? "value-balance"
            : "status";
  }

  if (metricType === "percentage") {
    const meaning = await selectChoice(prompts, {
      message: "What does the percentage mean?",
      options: [
        { label: "Remaining", value: "remaining" },
        { label: "Used", value: "used" },
      ],
      initialValue: "remaining",
    });
    if (!meaning) return null;
    const percentage = await promptNumberSource(prompts, "Percentage");
    return percentage ? { type: "percentage", percentage, meaning } : null;
  }
  if (metricType === "used-limit") {
    const used = await promptNumberSource(prompts, "Used");
    if (!used) return null;
    const limit = await promptNumberSource(prompts, "Limit");
    return limit ? { type: "used-limit", used, limit } : null;
  }
  if (metricType === "remaining-limit") {
    const remaining = await promptNumberSource(prompts, "Remaining");
    if (!remaining) return null;
    const limit = await promptNumberSource(prompts, "Limit");
    return limit ? { type: "remaining-limit", remaining, limit } : null;
  }
  if (metricType === "spend-budget") {
    const spend = await promptNumberSource(prompts, "Spend");
    if (!spend) return null;
    const budget = await promptNumberSource(prompts, "Budget");
    return budget ? { type: "spend-budget", spend, budget } : null;
  }
  if (metricType === "remaining-budget") {
    const remaining = await promptNumberSource(prompts, "Remaining");
    if (!remaining) return null;
    const budget = await promptNumberSource(prompts, "Budget");
    return budget ? { type: "remaining-budget", remaining, budget } : null;
  }
  if (metricType === "status") {
    const value = await promptTextSource(prompts, "Status");
    return value ? { type: "status", value } : null;
  }

  const valueType = metricType.slice("value-".length) as
    | "used"
    | "limit"
    | "remaining"
    | "balance"
    | "spend"
    | "budget";
  const value = await promptNumberSource(prompts, "Value");
  return value ? { type: "value", valueType, value } : null;
}

async function promptMapping(
  prompts: JsonV1QuestionnairePrompts,
  ordinal: number,
): Promise<JsonV1Mapping | null> {
  const resultType = await selectChoice(prompts, {
    message: `Mapping ${ordinal} result type`,
    options: RESULT_TYPE_OPTIONS,
    initialValue: "quota",
  });
  if (!resultType) return null;

  const name = requiredText(
    await prompts.text({ message: `Mapping ${ordinal} name`, placeholder: "Requests" }),
    prompts,
  );
  if (!name) return null;
  const label = optionalText(
    await prompts.text({ message: `Mapping ${ordinal} display label (optional)` }),
    prompts,
  );
  if (label === null) return null;

  const metric = await promptMetric(prompts, resultType);
  if (!metric) return null;

  let unit: string | undefined;
  let unitPosition: "prefix" | "suffix" | undefined;
  if (metric.type !== "percentage" && metric.type !== "status") {
    const unitAnswer = optionalText(
      await prompts.text({
        message: `Mapping ${ordinal} unit (optional; saved in config)`,
        placeholder: "requests",
      }),
      prompts,
    );
    if (unitAnswer === null) return null;
    unit = unitAnswer;
    if (unit) {
      const position = await selectChoice(prompts, {
        message: `Mapping ${ordinal} unit position`,
        options: [
          { label: "Before the value", value: "prefix" },
          { label: "After the value", value: "suffix" },
        ],
        initialValue: "suffix",
      });
      if (!position) return null;
      unitPosition = position;
    }
  }

  const resetTime = await promptOptionalTimestamp(prompts, "reset time");
  if (resetTime === null) return null;
  const observedTime = await promptOptionalTimestamp(prompts, "observed time");
  if (observedTime === null) return null;

  return {
    resultType,
    name,
    ...(label ? { label } : {}),
    ...(unit ? { unit, unitPosition } : {}),
    ...(resetTime ? { resetTime } : {}),
    ...(observedTime ? { observedTime } : {}),
    metric,
  };
}

export async function promptJsonV1Adapter(
  prompts: JsonV1QuestionnairePrompts,
): Promise<JsonV1QuestionnaireResult> {
  const nestedRows = await confirmChoice(
    prompts,
    "Are response rows inside a nested property?",
    false,
  );
  if (nestedRows === null) return { state: "cancelled" };

  const rowsPath = nestedRows ? await promptPath(prompts, "Rows path") : undefined;
  if (rowsPath === null) return { state: "cancelled" };

  const mappings: JsonV1Mapping[] = [];
  while (mappings.length < JSON_V1_MAX_MAPPINGS) {
    const mapping = await promptMapping(prompts, mappings.length + 1);
    if (!mapping) return { state: "cancelled" };
    mappings.push(mapping);

    if (mappings.length === JSON_V1_MAX_MAPPINGS) break;
    const addAnother = await confirmChoice(prompts, "Add another response mapping?", false);
    if (addAnother === null) return { state: "cancelled" };
    if (!addAnother) break;
  }

  return {
    state: "complete",
    adapter: {
      ...(rowsPath ? { rowsPath } : {}),
      mappings,
    },
  };
}
