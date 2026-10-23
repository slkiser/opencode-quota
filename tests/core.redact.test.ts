import { describe, expect, it } from "vite-plus/test";

import {
  looksSecret,
  publicDebugValue,
  publicDetail,
  safeDetail,
  safeErrorText,
  secretValuesRedactor,
} from "../src/core/redact.js";

/**
 * Every known key shape: hidden in text (`text`) and agent answers (`answer`, "[redacted]" when
 * not given), and refused in agent tool input.
 */
const KEY_SHAPES = [
  { name: "an OpenAI key", secret: "sk-proj-abcdefghijklmnop1234" },
  { name: "a Stripe test key", secret: "pk_test_Zx9QmT4vLr8K" },
  { name: "a GitHub token", secret: "ghp_0123456789abcdefABCDEF0123456789abcd" },
  { name: "a Google API key", secret: "AIzaFAKE-0123456789abcdefghijklmnopqr" },
  { name: "an xAI key", secret: "xai-Zx9QmT4vLr8K" },
  { name: "a JWT", secret: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXBhcnQx" },
  { name: "a Slack token", secret: "xoxb-1234567890-abcdefghij" },
  { name: "an AWS key id", secret: "AKIAIOSFODNN7EXAMPLE" },
  { name: "a Google OAuth token", secret: "ya29.a0AfH6SMBx3kQ9vR2pT7nW4cY8zD1eF5gH" },
  { name: "a Google refresh token", secret: "1//0gLm3QvR8sT2uV5wX7yZ9aB1cD3eF5gH" },
  { name: "a PEM key", secret: "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----" },
  { name: "a bearer token", secret: "Bearer abcdefghijklmnop", text: "Bearer [redacted]" },
  {
    name: "a Basic credential",
    secret: "Basic dXNlcjpwYXNzd29yZA==",
    text: "Basic [redacted]",
    answer: "Basic [redacted]",
  },
];

/**
 * Text on the edge between a key and a name: what status text shows, whether the agent tools
 * refuse it (in a name too), and what their answers show. Status text hides any word after an
 * auth scheme and any key prefix; the agent tools, whose inputs hold names and row labels, count
 * those only when they look like a key, and hide everything after "Bearer" up to the next space.
 */
const EDGE_CASES = [
  { input: "Basic ajpqampq", text: "Basic [redacted]", refused: false },
  { input: "Basic requests: 58/100", text: "Basic [redacted]: 58/100", refused: false },
  { input: "Bearer a!b2c3d4", text: "Bearer a!b2c3d4", refused: true, answer: "[redacted]" },
  {
    input: "Bearer abcdefgh!ijklmnop",
    text: "Bearer [redacted]!ijklmnop",
    refused: true,
    answer: "[redacted]",
  },
  { input: "pk-gateway-quota", text: "[redacted]", refused: false },
  { input: "rk-gateway-quota", text: "[redacted]", refused: false },
  { input: "sk-gateway-quota", text: "[redacted]", refused: false },
  {
    input: "https://pk-gateway-quota.example/v1/quota",
    text: "https://[redacted].example/v1/quota",
    refused: false,
  },
  { input: "monkeyJsonPaths", text: "monkeyJsonPaths", refused: false },
];

/** No secret in these: text shows them as they are, and the agent tools take them. */
const NOT_SECRETS = [
  "claude-opus-4-5-20251101",
  "gpt-5.1-codex-max",
  "accounts/fireworks/models/llama-v3p1-405b-instruct",
  "unpriced: Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8 and deepseek-ai/DeepSeek-R1-Distill-Qwen-32B-Preview",
  "google/gemini-2.0-flash-preview-image-generation",
  "custom_production-gateway-us_check outcome=success",
  "xai-quota for xai/grok-4-fast-reasoning",
  "https://gateway.example/v1/quota?plan=pro",
  "v2.14.0-rc.1+build.20261010",
  "resets 2026-11-01T00:00:00.000Z",
];

describe("key shapes", () => {
  it.each(KEY_SHAPES)(
    "hides $name in text and agent answers, and refuses it in a name",
    ({ secret, text = "[redacted]", answer = "[redacted]" }) => {
      expect(safeDetail(`key ${secret} end`, 300)).toBe(`key ${text} end`);
      expect(secretValuesRedactor([])(`key ${secret} end`)).toBe(`key ${answer} end`);
      expect(looksSecret(secret, { isName: true })).toBe(true);
    },
  );

  it.each(EDGE_CASES)(
    "$input: text, agent refusal and answer",
    ({ input, text, refused, answer = input }) => {
      expect(safeDetail(input, 300)).toBe(text);
      expect(looksSecret(input, { isName: false })).toBe(refused);
      expect(looksSecret(input, { isName: true })).toBe(refused);
      expect(secretValuesRedactor([])(input)).toBe(answer);
    },
  );

  it.each(NOT_SECRETS)("shows and takes %s", (text) => {
    expect(safeDetail(text, 300)).toBe(text);
    expect(secretValuesRedactor([])(text)).toBe(text);
    expect(looksSecret(text, { isName: false })).toBe(false);
  });

  it.each([
    ["9f86d081884c7d659a2feaa0c55ad015", true],
    ["Zx9QmT4vLr8KpW2sNb7YhC3dFg6JkA1e", true],
    ["k3j9x2m8q7w1z5n4b6v0c8x2a7", true],
    ["qvkjmznxwtyslrfpdhcbagqvkjmznxwt", false],
  ])("refuses the long run %s outside a name; in a name too: %s", (run, inName) => {
    expect(looksSecret(run, { isName: false })).toBe(true);
    expect(looksSecret(run, { isName: true })).toBe(inName);
  });

  it("hides each known value, a short one only as a whole token", () => {
    const redact = secretValuesRedactor(["abc1234", "long-key-value", "long-key-value-2"]);

    expect(redact("abc1234, not abc12345; long-key-value-2 and xlong-key-valuex")).toBe(
      "[redacted], not abc12345; [redacted] and x[redacted]x",
    );
  });

  it("shows an error as one short line, redacted before it is cut", () => {
    expect(safeErrorText(new Error("a\nb\tc\u0007"))).toBe("a b c");
    expect(safeErrorText(`${"x ".repeat(55)}${"t".repeat(40)}`)).toBe(
      `${"x ".repeat(55)}[redacted]`.slice(0, 120),
    );
  });
});

describe("credential redaction", () => {
  it.each([
    ["a quoted cookie and the pairs after it", `HTTP 401 Cookie: session="CANARY"; xsrf=CANARY`],
    ["a whole Set-Cookie header", `"set-cookie": "a=1; Path=/", "x": "token=CANARY"`],
    ["an Authorization header with a comma", `Authorization: Digest a="b", response=CANARY`],
    ["escaped quotes in a JSON password", String.raw`{"password":"a\"b CANARY","user":"bob"}`],
    ["JSON inside JSON", String.raw`{\"client_secret\":\"a b CANARY\"}`],
    ["an escaped single quote", String.raw`password='it\'s CANARY'`],
    ["a secret pair inside another value", `{"error":"bad request: api_key=CANARY"}`],
    ["a session name", "session=CANARY&page=2"],
    ["a compound secret name", "x-session-id: CANARY"],
  ])("redacts %s", (_, text) => {
    expect(safeDetail(text, 300)).not.toContain("CANARY");
    expect(safeDetail(text, 300)).toContain("[redacted]");
  });

  it("keeps what follows a quoted secret and values of plain names", () => {
    expect(safeDetail(String.raw`{"password":"a\"b CANARY","user":"bob"}`, 300)).toBe(
      String.raw`{"password":[redacted],"user":"bob"}`,
    );
    expect(safeDetail("error: invalid_grant, keys: 3", 300)).toBe("error: invalid_grant, keys: 3");
  });

  it.each([
    // A private id key hides the whole value, as any secret word in the key does.
    ["session_id", "abc", "[id]"],
    ["sessionId", "abc", "[id]"],
    ["XSRFToken", "abc", "[redacted]"],
    ["x-api-key", "abc", "[redacted]"],
    ["api_key", "abc", "[redacted]"],
    ["apikey", "abc", "[redacted]"],
    ["Authorization", "abc", "[redacted]"],
    ["client-secret-hint", "abc", "[redacted]"],
    ["passwd", "abc", "[redacted]"],
    ["has_token", "true", "[redacted]"],
    // A fact about a secret stays, with secrets inside it still redacted.
    ["api_key_source", "env", "env"],
    ["token_expires_at", "2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"],
    ["apiKeyEnv", "DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY"],
    ["token_present", "true", "true"],
    ["cookie_configured", "yes", "yes"],
    ["token_source", "Bearer sk-live-CANARY0123456789", "Bearer [redacted]"],
    // No secret word: kept.
    ["keys", "3", "3"],
    ["monkey", "plain", "plain"],
    ["sessions_in_db", "12", "12"],
    ["console_auth_state", "configured", "configured"],
    ["tokens_used", "500", "500"],
  ])("debug key %s with %j shows %j", (key, value, shown) => {
    expect(publicDebugValue(key, value, 300)).toBe(shown);
  });
});

const HOME = "/Users/alice";
const WINDOWS_HOME = "C:\\Users\\Alice Smith";

describe("publicDetail", () => {
  it.each([
    {
      name: "a cookie header with spaces around a pair",
      text: "HTTP 401 Cookie: sid = CANARYsid; theme=dark",
      shown: "HTTP 401 Cookie: [redacted]",
    },
    {
      name: "a cookie header with a quoted pair",
      text: 'Cookie: theme=dark; sid="CANARY sid" | next',
      shown: "Cookie: [redacted] | next",
    },
    {
      name: "a cookie header with a bare pipe or brace in a value",
      text: "Cookie: sid=a|CANARY; b=a}CANARY",
      shown: "Cookie: [redacted]",
    },
    {
      name: "an escaped quote in a JSON password",
      text: String.raw`{"password":"a\"CANARY"}`,
      shown: '{"password":[redacted]}',
    },
    {
      name: "a bracket inside an array of account ids",
      text: '{"accountIds":["id]CANARY","id2"],"plan":"pro"}',
      shown: '{"accountIds":[id],"plan":"pro"}',
    },
    {
      name: "names written with JSON unicode escapes",
      text: String.raw`{"account\u0049d":"CANARY1","\u0070assword":"CANARY2"}`,
      shown: '{"accountId":[id],"password":[redacted]}',
    },
    {
      name: "a JSON-escaped terminal escape inside the home dir",
      text: String.raw`path=/Users/al\u001b[0mice/.config/x`,
      shown: "path=~/.config/x",
      hidden: ["alice"],
    },
    {
      name: "a raw terminal escape inside the home dir",
      text: "path=/Users/al\u001b[31mice/.config/x",
      shown: "path=~/.config/x",
      hidden: ["alice"],
    },
    {
      name: "a long text cut inside the home dir",
      text: `${"x".repeat(20)} /Users/alice/.config`,
      max: 32,
      shown: `${"x".repeat(20)} ~/.config`,
      hidden: ["/Users"],
    },
    {
      name: "a Windows device path to the home dir",
      home: WINDOWS_HOME,
      text: "bin=\\\\?\\C:\\Users\\Alice Smith\\x and \\\\.\\C:\\Users\\Alice Smith\\y",
      shown: "bin=~\\x and ~\\y",
      hidden: ["Alice"],
    },
    {
      name: "a cookie in JSON, the other fields kept",
      text: '{"cookie":"a=CANARY; b=2","status":401}',
      shown: '{"cookie":[redacted],"status":401}',
    },
    {
      name: "an API key in escaped JSON",
      text: '{\\"api_key\\":\\"CANARYkey\\",\\"plan\\":\\"pro\\"}',
      shown: '{\\"api_key\\":[redacted],\\"plan\\":\\"pro\\"}',
    },
    {
      name: "a user id in escaped JSON",
      text: '{\\"user_id\\":\\"CANARYuser\\"}',
      shown: '{\\"user_id\\":[id]}',
    },
    {
      name: "a whole array of user ids",
      text: '"user_ids": ["CANARY1", "CANARY2"], "plan": "pro"',
      shown: '"user_ids": [id], "plan": "pro"',
    },
    {
      name: "a percent-encoded email address in a query",
      text: "GET /v1/usage?email=alice.CANARY%40example.com&plan=pro",
      shown: "GET /v1/usage?email=[email]&plan=pro",
    },
    {
      name: "an email address and short account ids",
      text: "alice.CANARY@example.co.uk account_id=CANARY1 teamId: CANARY2",
      shown: "[email] account_id=[id] teamId: [id]",
    },
    {
      name: "a long opaque token and a UUID",
      text: "token CANARY0abcdefghijklmnopqrstuvwxyz0123 / 123e4567-e89b-12d3-a456-426614174000",
      shown: "token [redacted] / [redacted]",
      hidden: ["426614174000"],
    },
    {
      name: "a Windows home with forward slashes",
      home: WINDOWS_HOME,
      text: "binary=C:/Users/Alice Smith/.local/bin/claude.exe",
      shown: "binary=~/.local/bin/claude.exe",
      hidden: ["Alice"],
    },
    {
      name: "a Windows home in another letter case with mixed slashes",
      home: WINDOWS_HOME,
      text: "path=c:\\users/alice smith\\bin",
      shown: "path=~\\bin",
      hidden: ["alice"],
    },
    {
      name: "a JSON-escaped Windows home",
      home: WINDOWS_HOME,
      text: JSON.stringify("C:\\Users\\Alice Smith\\bin"),
      shown: '"~\\\\bin"',
      hidden: ["Alice"],
    },
    {
      name: "a Windows home with repeated spaces",
      home: "C:\\Users\\Alice  Smith",
      text: "path=C:\\Users\\Alice  Smith\\bin",
      shown: "path=~\\bin",
      hidden: ["Alice"],
    },
    {
      name: "a folder that only starts like the Windows home",
      home: WINDOWS_HOME,
      text: "path=C:\\Users\\Alice Smithson\\bin",
      shown: "path=C:\\Users\\Alice Smithson\\bin",
    },
  ] as Array<{
    name: string;
    text: string;
    home?: string;
    max?: number;
    shown: string;
    hidden?: string[];
  }>)(
    "hides what a public issue must not show: $name",
    ({ text, home = HOME, max = Infinity, shown, hidden = [] }) => {
      const result = publicDetail(text, max, home);

      expect(result).toBe(shown);
      for (const part of ["CANARY", ...hidden]) expect(result).not.toContain(part);
    },
  );
});
