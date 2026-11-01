export class TaskCancelledError extends Error {
  readonly status = 'cancelled';
  readonly retry = false;

  constructor(phase = 'before the next action') {
    super(`Task cancelled ${phase}; already-issued browser actions were not rolled back`);
    this.name = 'TaskCancelledError';
  }
}

export function throwIfAborted(signal?: AbortSignal, phase?: string): void {
  if (signal?.aborted) throw new TaskCancelledError(phase);
}

export function waitWithAbort(ms: number, signal?: AbortSignal, phase?: string): Promise<void> {
  if (ms <= 0) {
    throwIfAborted(signal, phase);
    return Promise.resolve();
  }
  throwIfAborted(signal, phase);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new TaskCancelledError(phase));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
