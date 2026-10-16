/**
 * Result returned to the caller after constructing an OAuth authorization URL.
 */
interface GeminiAuthorization {
    url: string;
    verifier: string;
    state: string;
}
interface GeminiTokenExchangeSuccess {
    type: "success";
    refresh: string;
    access: string;
    expires: number;
    email?: string;
}
interface GeminiTokenExchangeFailure {
    type: "failed";
    error: string;
}
type GeminiTokenExchangeResult = GeminiTokenExchangeSuccess | GeminiTokenExchangeFailure;
/**
 * Build the Gemini OAuth authorization URL including PKCE.
 */
declare function authorizeGemini(): Promise<GeminiAuthorization>;
/**
 * Exchange an authorization code using a known PKCE verifier.
 */
declare function exchangeGeminiWithVerifier(code: string, verifier: string): Promise<GeminiTokenExchangeResult>;

interface PluginConfig {
    provider?: Record<string, {
        options?: Record<string, unknown>;
    }>;
    command?: Record<string, {
        description: string;
        template: string;
    }>;
    [key: string]: unknown;
}
interface ToolDefinition {
    description: string;
    args: Record<string, unknown>;
    execute(args: unknown, context: unknown): Promise<string>;
}
interface OAuthAuthDetails {
    type: "oauth";
    refresh: string;
    access?: string;
    expires?: number;
}
interface NonOAuthAuthDetails {
    type: string;
    [key: string]: unknown;
}
type AuthDetails = OAuthAuthDetails | NonOAuthAuthDetails;
type GetAuth = () => Promise<AuthDetails>;
interface ProviderModel {
    cost?: {
        input: number;
        output: number;
        cache?: {
            read: number;
            write: number;
        };
    };
    [key: string]: unknown;
}
interface Provider {
    models?: Record<string, ProviderModel>;
    options?: Record<string, unknown>;
}
interface LoaderResult {
    apiKey: string;
    fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}
interface AuthMethod {
    provider?: string;
    label: string;
    type: "oauth" | "api";
    authorize?: () => Promise<{
        url: string;
        instructions: string;
        method: string;
        callback: (() => Promise<GeminiTokenExchangeResult>) | ((callbackUrl: string) => Promise<GeminiTokenExchangeResult>);
    }>;
}
interface PluginClient {
    auth: {
        set(input: {
            path: {
                id: string;
            };
            body: OAuthAuthDetails;
        }): Promise<void>;
    };
    config?: {
        get(options?: unknown): Promise<{
            data?: PluginConfig;
        } | undefined>;
    };
    tui?: {
        showToast(input: {
            body: {
                title?: string;
                message: string;
                variant: "info" | "success" | "warning" | "error";
                duration?: number;
            };
        }): Promise<unknown>;
    };
}
interface PluginContext {
    client: PluginClient;
}
interface PluginResult {
    config?: (config: PluginConfig) => Promise<void>;
    tool?: Record<string, ToolDefinition>;
    auth: {
        provider: string;
        loader: (getAuth: GetAuth, provider: Provider) => Promise<LoaderResult | null>;
        methods: AuthMethod[];
    };
}

/**
 * Registers the Gemini OAuth provider for Opencode, handling auth, request rewriting,
 * debug logging, and response normalization for Gemini Code Assist endpoints.
 */
declare const GeminiCLIOAuthPlugin: ({ client }: PluginContext) => Promise<PluginResult>;
declare const GoogleOAuthPlugin: ({ client }: PluginContext) => Promise<PluginResult>;

export { type GeminiAuthorization, GeminiCLIOAuthPlugin, type GeminiTokenExchangeResult, GoogleOAuthPlugin, authorizeGemini, exchangeGeminiWithVerifier };
