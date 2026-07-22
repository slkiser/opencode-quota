import { beforeEach, describe, expect, it, vi } from "vitest";

import { runProviderAddCommand } from "../src/lib/provider-add-command.js";
import { applyProviderAddPlan, planProviderAdd } from "../src/lib/provider-add.js";

vi.mock("../src/lib/provider-add.js", () => ({
  applyProviderAddPlan: vi.fn(),
  planProviderAdd: vi.fn(),
}));

const mockedPlanProviderAdd = vi.mocked(planProviderAdd);
const mockedApplyProviderAddPlan = vi.mocked(applyProviderAddPlan);

function createPrompts(params: {
  selects: unknown[];
  texts: unknown[];
  confirms?: unknown[];
  cancel?: unknown;
}) {
  const select = vi.fn();
  for (const value of params.selects) select.mockResolvedValueOnce(value);
  const text = vi.fn();
  for (const value of params.texts) text.mockResolvedValueOnce(value);
  const confirm = vi.fn();
  for (const value of params.confirms ?? []) confirm.mockResolvedValueOnce(value);
  const cancel = params.cancel ?? Symbol("cancel");

  return {
    cancel,
    prompts: {
      intro: vi.fn(),
      outro: vi.fn(),
      select,
      text,
      confirm,
      isCancel: (value: unknown) => value === cancel,
      log: {
        info: vi.fn(),
        success: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
      },
    },
  };
}

describe("guided provider add command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("offers only canonical formats, validates one strict JSON adapter, previews, then writes that plan", async () => {
    const adapter = {
      mappings: [
        {
          resultType: "quota",
          name: "Requests",
          metric: {
            type: "percentage",
            percentage: { path: ["remaining"] },
            meaning: "remaining",
          },
        },
      ],
    };
    const plan = {
      path: "/trusted/opencode.jsonc",
      format: "jsonc" as const,
      definition: {
        id: "private-gateway",
        providerId: "private-gateway",
        label: "Private Gateway",
        mode: "remote-api" as const,
        url: "https://gateway.example/quota",
        format: "json-v1" as const,
        adapter,
      },
      updated:
        '{"experimental":{"quotaToast":{"quotaProviders":[{"id":"existing"},{"id":"private-gateway","format":"json-v1"}]}}}\n',
      changed: true,
      ordinaryProviderRequired: false,
      documentEdit: {} as never,
      additionalDocumentEdits: [],
    };
    mockedPlanProviderAdd.mockResolvedValue(plan);
    mockedApplyProviderAddPlan.mockResolvedValue();
    const { prompts } = createPrompts({
      selects: ["remote-api", "json-v1"],
      texts: [
        "private-gateway",
        "",
        "Private Gateway",
        "",
        "https://gateway.example/quota",
        JSON.stringify(adapter),
        "",
      ],
      confirms: [true],
    });

    const code = await runProviderAddCommand({ prompts: prompts as never });

    expect(code).toBe(0);
    expect(
      prompts.select.mock.calls[1]?.[0].options.map((option: { value: string }) => option.value),
    ).toEqual(["quota-v1", "json-v1", "openrouter-key-v1"]);
    expect(mockedPlanProviderAdd).toHaveBeenCalledWith({
      definition: {
        id: "private-gateway",
        label: "Private Gateway",
        mode: "remote-api",
        url: "https://gateway.example/quota",
        format: "json-v1",
        adapter,
      },
    });
    expect(prompts.log.info).toHaveBeenCalledWith(
      "Preview: /trusted/opencode.jsonc\n\n" + plan.updated,
    );
    expect(mockedApplyProviderAddPlan).toHaveBeenCalledWith(plan);
  });

  it("returns the same constant redacted error when the adapter prompt is cancelled", async () => {
    const cancel = Symbol("cancel");
    const { prompts } = createPrompts({
      cancel,
      selects: ["remote-api", "json-v1"],
      texts: ["private-gateway", "", "", "", "https://gateway.example/quota", cancel],
    });

    const code = await runProviderAddCommand({ prompts: prompts as never });

    expect(code).toBe(1);
    expect(prompts.log.error).toHaveBeenCalledWith("Invalid json-v1 adapter JSON.");
    expect(mockedPlanProviderAdd).not.toHaveBeenCalled();
    expect(mockedApplyProviderAddPlan).not.toHaveBeenCalled();
  });

  it("returns a constant redacted error when strict adapter JSON cannot be parsed", async () => {
    const sensitiveInput = '{"mappings":[{"literal":"do-not-echo"}]';
    const { prompts } = createPrompts({
      selects: ["remote-api", "json-v1"],
      texts: ["private-gateway", "", "", "", "https://gateway.example/quota", sensitiveInput],
    });

    const code = await runProviderAddCommand({ prompts: prompts as never });

    expect(code).toBe(1);
    expect(prompts.log.error).toHaveBeenCalledWith("Invalid json-v1 adapter JSON.");
    expect(JSON.stringify(prompts.log.error.mock.calls)).not.toContain("do-not-echo");
    expect(mockedPlanProviderAdd).not.toHaveBeenCalled();
    expect(mockedApplyProviderAddPlan).not.toHaveBeenCalled();
  });
});
