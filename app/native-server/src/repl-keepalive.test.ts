import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { startReplKeepalive } from './repl';

describe('REPL MCP session keepalive', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('pings before the server idle timeout and stops on close', async () => {
    jest.useFakeTimers();
    const ping = jest.fn<() => Promise<any>>(async () => ({}));
    const timer = startReplKeepalive({ ping }, 1000);

    await jest.advanceTimersByTimeAsync(3000);
    expect(ping).toHaveBeenCalledTimes(3);

    clearInterval(timer);
    await jest.advanceTimersByTimeAsync(3000);
    expect(ping).toHaveBeenCalledTimes(3);
  });
});
