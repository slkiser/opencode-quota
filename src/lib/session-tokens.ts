/**
 * The tokens a session used so far, for the quota snapshot: its own messages, or with
 * `scope: "tree"` its subagent sessions' messages too.
 */
import type { SessionModelInput, Words } from "../core/types.js";
import {
  iterAssistantMessagesForSession,
  iterAssistantMessagesForSessions,
  type OpenCodeMessage,
  resolveSessionTree,
} from "./opencode-storage.js";

/**
 * A session's new input, cache-read input and output tokens, and each model's input tokens by
 * kind (one entry per provider and model, like the Usage tab's model rows).
 */
interface SessionTokensData {
  totalInput: number;
  totalCachedInput: number;
  totalOutput: number;
  models: SessionModelInput[];
}

/**
 * The token totals of the messages that used a token, or undefined unless some model's own
 * input (new plus cached) or output adds up to more than zero.
 */
function sumSessionTokens(messages: readonly OpenCodeMessage[]): SessionTokensData | undefined {
  let totalInput = 0;
  let totalCachedInput = 0;
  let totalOutput = 0;
  const byModel = new Map<string, { input: number; output: number }>();
  const inputByModel = new Map<string, SessionModelInput>();

  for (const message of messages) {
    const { tokens } = message;
    if (!tokens) continue;
    const input = typeof tokens.input === "number" ? tokens.input : 0;
    const cachedInput = typeof tokens.cache?.read === "number" ? tokens.cache.read : 0;
    const cacheWrite = typeof tokens.cache?.write === "number" ? tokens.cache.write : 0;
    const output = typeof tokens.output === "number" ? tokens.output : 0;
    if (input + cachedInput === 0 && output === 0) continue;

    totalInput += input;
    totalCachedInput += cachedInput;
    totalOutput += output;
    const modelID = message.modelID ?? "unknown";
    const model = byModel.get(modelID) ?? { input: 0, output: 0 };
    model.input += input + cachedInput;
    model.output += output;
    byModel.set(modelID, model);

    if (input + cachedInput + cacheWrite <= 0) continue;
    const inputKey = `${message.providerID ?? "unknown"}\n${modelID}`;
    const modelInput = inputByModel.get(inputKey) ?? {
      modelID,
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
    modelInput.input += input;
    modelInput.cacheRead += cachedInput;
    modelInput.cacheWrite += cacheWrite;
    inputByModel.set(inputKey, modelInput);
  }

  const used = [...byModel.values()].some((model) => model.input > 0 || model.output > 0);
  return used
    ? { totalInput, totalCachedInput, totalOutput, models: [...inputByModel.values()] }
    : undefined;
}

/**
 * The session's token totals. `sessionTokens` is undefined without a session, when no message
 * used a token, and when the session or OpenCode's database can't be read.
 */
export async function fetchSessionTokensForDisplay(params: {
  sessionID?: string;
  scope: Words["sessionTokens"];
}): Promise<{ sessionTokens?: SessionTokensData }> {
  const { sessionID } = params;
  if (!sessionID) return {};

  try {
    const messages =
      params.scope === "tree"
        ? await iterAssistantMessagesForSessions({
            sessionIDs: await resolveSessionTree(sessionID),
          })
        : await iterAssistantMessagesForSession({ sessionID });
    return { sessionTokens: sumSessionTokens(messages) };
  } catch {
    return {};
  }
}
