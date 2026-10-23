export type TokenBuckets = {
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
};

type TokenCarrier = {
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: {
      read?: number;
      write?: number;
    };
  } | null;
};

export function emptyTokenBuckets(): TokenBuckets {
  return { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 };
}

export function addTokenBuckets(a: TokenBuckets, b: TokenBuckets): TokenBuckets {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cache_read: a.cache_read + b.cache_read,
    cache_write: a.cache_write + b.cache_write,
  };
}

export function tokenBucketsFromMessage(message: TokenCarrier): TokenBuckets {
  const tokens = message.tokens;
  if (!tokens) return emptyTokenBuckets();

  return {
    input: typeof tokens.input === "number" ? tokens.input : 0,
    output: typeof tokens.output === "number" ? tokens.output : 0,
    reasoning: typeof tokens.reasoning === "number" ? tokens.reasoning : 0,
    cache_read: typeof tokens.cache?.read === "number" ? tokens.cache.read : 0,
    cache_write: typeof tokens.cache?.write === "number" ? tokens.cache.write : 0,
  };
}
