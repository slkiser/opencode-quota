import { promptJsonV1Adapter } from "./provider-add-json-v1-questionnaire.js";
import { applyProviderAddPlan, planProviderAdd } from "./provider-add.js";

const INVALID_JSON_V1_ADAPTER_MESSAGE = "Invalid json-v1 adapter JSON.";

type PromptAdapter = {
  intro: (message: string) => void;
  outro: (message: string) => void;
  select: (options: {
    message: string;
    options: Array<{ label: string; value: string; hint?: string }>;
    initialValue?: string;
  }) => Promise<unknown>;
  text: (options: {
    message: string;
    placeholder?: string;
    initialValue?: string;
  }) => Promise<unknown>;
  confirm: (options: { message: string; initialValue?: boolean }) => Promise<unknown>;
  isCancel: (value: unknown) => boolean;
  log: {
    info: (message: string) => void;
    success: (message: string) => void;
    error: (message: string) => void;
    warn?: (message: string) => void;
  };
};

function requiredText(value: unknown, prompts: PromptAdapter): string | null {
  if (prompts.isCancel(value)) return null;
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function optionalText(value: unknown, prompts: PromptAdapter): string | undefined | null {
  if (prompts.isCancel(value)) return null;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value.trim();
}

async function promptWindows(prompts: PromptAdapter): Promise<unknown[] | null> {
  const windows: unknown[] = [];
  while (true) {
    const ordinal = windows.length + 1;
    const id = requiredText(
      await prompts.text({
        message: "Window " + ordinal + " stable id",
        placeholder: "daily",
      }),
      prompts,
    );
    if (!id) return null;
    const label = optionalText(
      await prompts.text({ message: "Window " + ordinal + " display label (optional)" }),
      prompts,
    );
    if (label === null) return null;
    const type = await prompts.select({
      message: "Window " + ordinal + " type",
      options: [
        { label: "UTC day", value: "utc-day" },
        { label: "Rolling", value: "rolling" },
      ],
      initialValue: "utc-day",
    });
    if (prompts.isCancel(type)) return null;
    const duration =
      type === "rolling"
        ? requiredText(
            await prompts.text({
              message: "Window " + ordinal + " rolling duration in minutes",
              placeholder: "300",
            }),
            prompts,
          )
        : undefined;
    if (type === "rolling" && !duration) return null;
    const requestLimit = requiredText(
      await prompts.text({
        message: "Window " + ordinal + " request limit",
        placeholder: "1000",
      }),
      prompts,
    );
    if (!requestLimit) return null;
    const usdBudget = optionalText(
      await prompts.text({
        message: "Window " + ordinal + " USD budget (optional)",
        placeholder: "25",
      }),
      prompts,
    );
    if (usdBudget === null) return null;

    windows.push({
      id,
      ...(label ? { label } : {}),
      type,
      ...(duration ? { durationMinutes: Number(duration) } : {}),
      requestLimit: Number(requestLimit),
      ...(usdBudget ? { usdBudget: Number(usdBudget) } : {}),
    });

    const addAnother = await prompts.confirm({
      message: "Add another accounting window?",
      initialValue: false,
    });
    if (prompts.isCancel(addAnother)) return null;
    if (!addAnother) return windows;
  }
}

export async function runProviderAddCommand(
  params: {
    argv?: string[];
    prompts?: PromptAdapter;
  } = {},
): Promise<number> {
  const argv = params.argv ?? [];
  if (argv.some((arg) => arg !== "--dry-run")) return 1;
  const prompts = params.prompts ?? ((await import("@clack/prompts")) as unknown as PromptAdapter);
  prompts.intro("Add a global OpenCode Quota provider");

  const mode = await prompts.select({
    message: "Accounting mode",
    options: [
      { label: "Remote API", value: "remote-api" },
      { label: "Local estimate", value: "local-estimate" },
    ],
  });
  if (prompts.isCancel(mode)) return 1;
  const id = requiredText(
    await prompts.text({ message: "Stable quota provider id", placeholder: "my-provider" }),
    prompts,
  );
  if (!id) return 1;
  const providerId = optionalText(
    await prompts.text({
      message: "Different OpenCode provider id (blank when it matches)",
    }),
    prompts,
  );
  if (providerId === null) return 1;
  const label = optionalText(
    await prompts.text({ message: "Display label (optional)", placeholder: "My Provider" }),
    prompts,
  );
  if (label === null) return 1;
  const modelIdsText = optionalText(
    await prompts.text({
      message: "Exact model ids, comma-separated (optional)",
      placeholder: "model-a,model-b",
    }),
    prompts,
  );
  if (modelIdsText === null) return 1;

  const base = {
    id,
    ...(providerId ? { providerId } : {}),
    ...(label ? { label } : {}),
    ...(modelIdsText
      ? {
          modelIds: modelIdsText
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
        }
      : {}),
  };

  let definition: unknown;
  if (mode === "remote-api") {
    const url = requiredText(
      await prompts.text({
        message: "Accounting endpoint URL",
        placeholder: "https://api.example.com/v1/accounting",
      }),
      prompts,
    );
    if (!url) return 1;
    const format = await prompts.select({
      message: "Safe response format",
      options: [
        { label: "quota-v1", value: "quota-v1" },
        { label: "json-v1", value: "json-v1" },
        { label: "openrouter-key-v1", value: "openrouter-key-v1" },
      ],
    });
    if (prompts.isCancel(format)) return 1;
    let adapter: unknown;
    if (format === "json-v1") {
      const result = await promptJsonV1Adapter(prompts);
      if (result.state === "cancelled") {
        prompts.log.error(INVALID_JSON_V1_ADAPTER_MESSAGE);
        return 1;
      }
      adapter = result.adapter;
    }
    const apiKeyEnv = optionalText(
      await prompts.text({
        message: "API key environment variable name (optional; never the secret)",
      }),
      prompts,
    );
    if (apiKeyEnv === null) return 1;
    definition = {
      ...base,
      mode,
      url,
      format,
      ...(format === "json-v1" ? { adapter } : {}),
      ...(apiKeyEnv ? { apiKeyEnv } : {}),
    };
  } else {
    const windows = await promptWindows(prompts);
    if (!windows) return 1;
    definition = { ...base, mode, windows };
  }

  try {
    const plan = await planProviderAdd({ definition });
    prompts.log.info("Preview: " + plan.path + "\n\n" + plan.updated);
    for (const edit of plan.additionalDocumentEdits) {
      prompts.log.info("Preview: " + edit.path + "\n\n" + edit.updated);
    }
    if (plan.ordinaryProviderRequired) {
      prompts.log.warn?.(
        'OpenCode provider "' +
          plan.definition.providerId +
          '" is not declared globally. Add its ordinary provider/model block separately; ' +
          "/connect -> Other stores only the credential.",
      );
    }
    if (argv.includes("--dry-run")) {
      prompts.outro("Preview complete; no files were written.");
      return 0;
    }
    const confirmed = await prompts.confirm({
      message: plan.changed
        ? "Write this exact global config change?"
        : "Config is unchanged. Finish?",
      initialValue: true,
    });
    if (prompts.isCancel(confirmed) || !confirmed) return 1;
    await applyProviderAddPlan(plan);
    prompts.log.success(
      plan.changed ? "Updated " + plan.path : "Already configured in " + plan.path,
    );
    prompts.outro("Quota provider configuration complete.");
    return 0;
  } catch (error) {
    prompts.log.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
