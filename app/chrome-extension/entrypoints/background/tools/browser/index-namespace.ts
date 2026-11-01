const STORAGE_KEY = 'domIndexNextNamespace';
const NAMESPACE_SIZE = 2 ** 24;
let allocation = Promise.resolve();

/** Reserve before publishing so a service-worker restart cannot reuse old references. */
export async function reserveIndexNamespaces(count: number): Promise<number[]> {
  const previous = allocation;
  let release!: () => void;
  allocation = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const next = stored[STORAGE_KEY] ?? 1;
    if (
      !Number.isSafeInteger(next) ||
      next < 1 ||
      !Number.isSafeInteger(count) ||
      count < 1 ||
      (next + count) * NAMESPACE_SIZE > Number.MAX_SAFE_INTEGER
    ) {
      throw new Error('DOM index namespace exhausted or corrupt; refusing to reuse references');
    }
    await chrome.storage.local.set({ [STORAGE_KEY]: next + count });
    return Array.from({ length: count }, (_, i) => (next + i) * NAMESPACE_SIZE);
  } finally {
    release();
  }
}
