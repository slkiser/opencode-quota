export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = Array.from<R>({ length: values.length });
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await map(values[index]!, index);
    }
  }

  const workerCount = Math.min(values.length, Math.max(1, Math.trunc(concurrency) || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
