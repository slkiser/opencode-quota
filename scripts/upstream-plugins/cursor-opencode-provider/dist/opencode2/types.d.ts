/**
 * Runtime duck-type boundary for the OpenCode 2.0 plugin — not host conformance.
 *
 * Only the methods and fields this plugin calls or publishes. Extra host
 * fields are ignored at runtime. Do not import `@opencode/plugin`: it is not a
 * standalone types surface we can pin next to `@opencode-ai/plugin`, and a host
 * dependency would force a plugin bump on every OpenCode release.
 *
 * Compile-time checks that our *calls and payloads* still fit the fuller host
 * editor live in `test/opencode2-conformance.types.ts` against
 * `test/opencode2-host-contract.ts`.
 *
 * Effect `Schema` brands (Provider.ID, Model.ID, …) are modelled as plain
 * `string`; brands are compile-time only and erase at runtime.
 */
export type Registration = {
    readonly dispose: () => Promise<void>;
};
export type Hooks<Spec> = <Name extends keyof Spec>(name: Name, callback: (input: Spec[Name]) => Promise<void> | void) => Promise<Registration>;
export type ModelHookOptions = {
    /** Limits the hook to one provider; the host skips events for any other. */
    readonly providerID?: string;
};
export type ModelHooks<Spec> = <Name extends keyof Spec>(name: Name, callback: (input: Spec[Name]) => Promise<void> | void, options?: Spec[Name] extends {
    readonly model: unknown;
} ? ModelHookOptions : never) => Promise<Registration>;
export type Transform<Input> = (callback: (input: Input) => void) => Promise<Registration>;
export type ProviderInfo = {
    id: string;
    name: string;
    /** `"aisdk:<pkg>"` selects the AI SDK path; a bare specifier selects native. */
    package: string;
    activation: "auto" | "enabled" | "disabled";
    integrationID?: string;
};
export type ModelVariantInfo = {
    id: string;
    settings?: Record<string, any>;
};
export type ModelInfo2 = {
    id: string;
    /** Wire id sent to the provider. Lets one Cursor model back several entries. */
    modelID: string;
    providerID: string;
    name: string;
    family?: string;
    capabilities: {
        tools: boolean;
        input: readonly string[];
        output: readonly string[];
    };
    variants: readonly ModelVariantInfo[];
    time: {
        released: number;
    };
    /** OpenCode 2.0 tiered $/1M rates; empty when Cursor does not publish a price. */
    cost: readonly {
        tier?: {
            type: "context";
            size: number;
        };
        input: number;
        output: number;
        cache: {
            read: number;
            write: number;
        };
    }[];
    status: "active";
    enabled: boolean;
    limit: {
        context: number;
        input?: number;
        output: number;
    };
    settings?: Record<string, any>;
};
export type CredentialOAuth = {
    type: "oauth";
    methodID: string;
    refresh: string;
    access: string;
    expires: number;
    metadata?: Record<string, unknown>;
};
export type CredentialKey = {
    type: "key";
    key: string;
    metadata?: Record<string, unknown>;
};
export type CredentialValue = CredentialOAuth | CredentialKey;
export type ConnectionInfo = {
    type: "credential";
    id: string;
    label: string;
} | {
    type: "env";
    name: string;
};
/**
 * Inventory writer this plugin uses (`editor.add` only).
 * The host editor is a superset; unused methods are not part of this boundary.
 */
export type ProviderEditor = {
    add(input: {
        info: ProviderInfo;
        models: readonly ModelInfo2[];
        sourceConnection?: ConnectionInfo;
    }): void;
};
export type ProviderDomain = {
    readonly transform: Transform<ProviderEditor>;
    readonly reload: () => Promise<void>;
};
export type IntegrationTextPrompt = {
    type: "text";
    key: string;
    message: string;
    placeholder?: string;
};
export type IntegrationOAuthMethod = {
    id: string;
    type: "oauth";
    label: string;
    form?: unknown;
    prompts?: IntegrationTextPrompt[];
};
export type IntegrationKeyMethod = {
    type: "key";
    label?: string;
};
export type IntegrationEnvMethod = {
    type: "env";
    names: string[];
};
export type IntegrationMethod = IntegrationOAuthMethod | IntegrationKeyMethod | IntegrationEnvMethod;
export type IntegrationOAuthAuthorization = {
    readonly url: string;
    readonly instructions: string;
    readonly expiresAt?: number;
} & ({
    readonly mode: "auto";
    readonly callback: Promise<CredentialOAuth>;
} | {
    readonly mode: "code";
    readonly callback: (code: string) => Promise<CredentialOAuth>;
});
export type IntegrationOAuthMethodRegistration = {
    readonly integrationID: string;
    readonly method: IntegrationOAuthMethod;
    readonly authorize: (answer: any) => Promise<IntegrationOAuthAuthorization>;
    readonly refresh?: (credential: CredentialOAuth) => Promise<CredentialOAuth>;
    readonly label?: (credential: CredentialOAuth) => string | undefined;
};
export type IntegrationMethodRegistration = IntegrationOAuthMethodRegistration | {
    readonly integrationID: string;
    readonly method: IntegrationKeyMethod;
} | {
    readonly integrationID: string;
    readonly method: IntegrationEnvMethod;
};
export type IntegrationRef = {
    id: string;
    name: string;
};
export type IntegrationDraft = {
    update(id: string, update: (integration: IntegrationRef) => void): void;
    readonly method: {
        update(input: IntegrationMethodRegistration): void;
    };
};
export type IntegrationDomain = {
    readonly transform: Transform<IntegrationDraft>;
    readonly reload: () => Promise<void>;
    readonly connection: {
        readonly active: (integrationID: string) => Promise<ConnectionInfo | undefined>;
        readonly resolve: (connection: ConnectionInfo) => Promise<CredentialValue | undefined>;
    };
};
/** Fields this plugin reads from the host model object. */
export type HostModelRef = {
    readonly id: string;
    readonly modelID: string;
    readonly providerID: string;
};
export type AISDKHooks = {
    sdk: {
        readonly model: HostModelRef;
        readonly package: string;
        readonly options: Record<string, any>;
        sdk?: any;
    };
    language: {
        readonly model: HostModelRef;
        readonly sdk: any;
        readonly options: Record<string, any>;
        language?: unknown;
    };
};
export type AISDKDomain = {
    readonly hook: Hooks<AISDKHooks>;
};
export type ToolOptions = {
    readonly namespace?: string;
    readonly permission?: string;
    readonly codemode?: boolean;
    readonly pinned?: boolean;
};
/** Public OpenCode 2 tool context. It deliberately has no permission `ask`. */
export type ToolExecutionContext = {
    readonly sessionID: string;
    readonly agent: string;
    readonly messageID: string;
    readonly id: string;
    readonly progress: (update: Record<string, unknown>) => Promise<void>;
};
export type ToolDefinition = {
    readonly name: string;
    readonly description: string;
    readonly input: unknown;
    readonly output?: unknown;
    readonly options?: ToolOptions;
    readonly execute: (input: any, context: ToolExecutionContext) => Promise<any>;
};
export type ToolDraft = {
    add(tool: ToolDefinition): void;
    /** Host ToolEditor.get — used to skip registering tools the host already owns. */
    get?(id: string): (ToolDefinition & {
        readonly id?: string;
    }) | undefined;
    list?(): readonly (ToolDefinition & {
        readonly id: string;
    })[];
    /** Host ToolEditor.update — missing ids are ignored. */
    update?(id: string, update: (tool: {
        options?: {
            namespace?: string;
            permission?: string;
            codemode?: boolean;
            pinned?: boolean;
        };
    }) => void): void;
};
export type ToolHookBaseFields = {
    readonly tool: string;
    readonly sessionID: string;
    readonly agent: string;
    readonly messageID: string;
};
export type ToolHookBase = ToolHookBaseFields & ({
    readonly id: string;
    readonly callID?: string;
} | {
    readonly id?: string;
    readonly callID: string;
});
export type ToolHooks = {
    readonly "execute.before": ToolHookBase & {
        input: unknown;
    };
    readonly "execute.after": ToolHookBase & {
        readonly input: unknown;
    } & ({
        readonly status: "completed";
        result: any;
    } | {
        readonly status: "error";
        error: any;
    });
};
export type ToolDomain = {
    readonly transform: Transform<ToolDraft>;
    readonly reload: () => Promise<void>;
    readonly hook: Hooks<ToolHooks>;
};
export type SessionContext = {
    readonly sessionID: string;
    readonly agent: string;
    readonly model: {
        providerID: string;
        id: string;
        variant?: string;
    };
    system: Array<any>;
    messages: Array<any>;
    tools: Record<string, {
        description: string;
        input: unknown;
    }>;
    /** Mutable generation / provider options. OpenCode 2.0 SessionRequest.options. */
    options?: Record<string, unknown>;
};
export type SessionCompactionResult = {
    summary: string;
    providerState?: unknown;
    metadata?: Record<string, unknown>;
    tokens?: unknown;
};
export type SessionCompaction = SessionContext & {
    result?: SessionCompactionResult;
};
export type SessionGenerate = SessionContext;
export type SessionTitle = {
    readonly sessionID: string;
    readonly model: {
        providerID: string;
        id: string;
        variant?: string;
    };
    system: Array<any>;
    messages: Array<any>;
    options?: Record<string, unknown>;
    result?: string;
};
/**
 * Outbound request headers / route overrides for one model call.
 * Headers reach the AI SDK as `callOptions.headers`.
 */
export type SessionModelRequest = {
    readonly sessionID: string;
    readonly agent: string;
    readonly model: {
        providerID: string;
        id: string;
        variant?: string;
    };
    readonly kind: "primary" | "compaction" | "title" | "generate";
    baseURL?: string;
    headers: Record<string, string>;
};
export type SessionHooks = {
    readonly context: SessionContext;
    readonly compaction: SessionCompaction;
    readonly generate: SessionGenerate;
    readonly title: SessionTitle;
    readonly "model.request": SessionModelRequest;
};
/** Only the `location.directory` field we actually read. */
export type SessionInfo = {
    readonly id: string;
    readonly location: {
        readonly directory: string;
    };
};
export type SessionDomain = {
    readonly hook: ModelHooks<SessionHooks>;
    readonly get: (input: {
        sessionID: string;
    }) => Promise<SessionInfo>;
    readonly switchAgent?: (input: {
        sessionID: string;
        agent: string;
    }) => Promise<void>;
    readonly synthetic?: (input: {
        sessionID: string;
        text: string;
        description?: string;
        metadata?: Record<string, unknown>;
        delivery?: "steer" | "queue";
        resume?: boolean;
    }) => Promise<unknown>;
    readonly prompt?: (input: {
        sessionID: string;
        text: string;
    }) => Promise<unknown>;
};
export type EventDomain = {
    readonly subscribe: (...args: any[]) => any;
};
export type ShellCreateBefore = {
    command: string;
    cwd: string;
    timeout: number;
    shell: string;
    env: Record<string, string | undefined>;
};
export type ShellDomain = {
    readonly hook: Hooks<{
        readonly "create.before": ShellCreateBefore;
    }>;
};
export type WebSearchResult = {
    url: string;
    title?: string;
    content?: string;
    time: {
        published?: number;
    };
};
export type WebSearchEditor = {
    add(definition: {
        readonly id: string;
        readonly name: string;
        readonly execute: (input: {
            query: string;
        }, context: {
            readonly signal: AbortSignal;
        }) => Promise<readonly WebSearchResult[]>;
    }): void;
};
export type WebSearchDomain = {
    readonly transform: Transform<WebSearchEditor>;
    readonly reload: () => Promise<void>;
};
/**
 * MCP config reader this plugin uses. Server `codemode` is observed and not
 * written: writing it also changes the remote raw-tool URL. The host
 * `MCPEditor` is a superset.
 */
export type McpServerConfig = {
    readonly codemode?: boolean;
};
export type McpEditor = {
    list(): readonly (readonly [string, McpServerConfig])[];
};
export type McpDomain = {
    readonly transform: Transform<McpEditor>;
};
/** Only the fields this plugin reads from a registered skill. */
export type SkillInfo = {
    readonly id: string;
    readonly path: string;
};
export type SkillDomain = {
    readonly list: () => Promise<{
        readonly location: {
            readonly directory: string;
        };
        readonly data: readonly SkillInfo[];
    }>;
};
export type PluginLocation = {
    readonly directory: string;
};
export type PluginContext = {
    readonly aisdk: AISDKDomain;
    readonly event: EventDomain;
    readonly integration: IntegrationDomain;
    readonly provider: ProviderDomain;
    readonly session: SessionDomain;
    readonly tool: ToolDomain;
    readonly location?: PluginLocation;
    readonly shell?: ShellDomain;
    readonly websearch?: WebSearchDomain;
    readonly mcp?: McpDomain;
    readonly skill?: SkillDomain;
};
export type Cleanup = () => Promise<void> | void;
export type Plugin2 = {
    readonly id: string;
    readonly setup: (context: PluginContext) => Promise<Cleanup | void> | Cleanup | void;
};
