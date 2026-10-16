import type { CostBuckets } from "./modelsdev-pricing.js";

interface TokenBucketLike {
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
}

function perToken(usdPer1M?: number): number {
  return typeof usdPer1M === "number" ? usdPer1M / 1_000_000 : 0;
}

export function calculateUsdFromTokenBuckets(rates: CostBuckets, tokens: TokenBucketLike): number {
  const inputRate = perToken(rates.input);
  const outputRate = perToken(rates.output);
  const cacheReadRate = perToken(rates.cache_read ?? rates.input);
  const cacheWriteRate = perToken(rates.cache_write ?? rates.input);
  const reasoningRate = perToken(rates.reasoning ?? rates.output);

  return (
    tokens.input * inputRate +
    tokens.output * outputRate +
    tokens.cache_read * cacheReadRate +
    tokens.cache_write * cacheWriteRate +
    tokens.reasoning * reasoningRate
  );
}
