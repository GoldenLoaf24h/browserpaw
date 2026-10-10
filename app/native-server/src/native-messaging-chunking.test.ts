import { describe, expect, test, jest } from '@jest/globals';
import os from 'os';
import path from 'path';
if (!process.env.BROWSERPAW_HOME) {
  process.env.BROWSERPAW_HOME = path.join(os.tmpdir(), '.browserpaw-chunking-test');
}
import { NativeMessagingHost } from './native-messaging-host';
import { stdout } from 'process';

describe('Native Messaging Chunking Tests (Task B8)', () => {
  test('reassembles incoming chunks split into multiple messages', async () => {
    const host = new NativeMessagingHost();
    const handleMessageSpy = jest.spyOn(host as any, 'handleMessage');

    const originalPayload = {
      responseToRequestId: 'req-test-1',
      payload: { data: 'a'.repeat(2000), count: 42 },
    };
    const serialized = JSON.stringify(originalPayload);
    const chunk1 = serialized.slice(0, 1000);
    const chunk2 = serialized.slice(1000);

    const chunkId = 'test-chunk-uuid-1';
    const chunkMsg1 = {
      __chunked__: true,
      chunkId,
      index: 0,
      total: 2,
      chunk: chunk1,
    };
    const chunkMsg2 = {
      __chunked__: true,
      chunkId,
      index: 1,
      total: 2,
      chunk: chunk2,
    };

    // Process chunk 1
    await (host as any).handleMessage(chunkMsg1);
    // Should not have resolved the full payload yet
    expect(handleMessageSpy).toHaveBeenCalledTimes(1);

    // Process chunk 2
    await (host as any).handleMessage(chunkMsg2);
    // Should now have called handleMessage with the reassembled full message
    expect(handleMessageSpy).toHaveBeenCalledTimes(3);
    const reassembledCall = handleMessageSpy.mock.calls[2][0];
    expect(reassembledCall).toEqual(originalPayload);
  });

  test('chunks outgoing messages larger than threshold (950KB)', () => {
    const host = new NativeMessagingHost();
    const stdoutSpy = jest.spyOn(stdout, 'write').mockImplementation((() => true) as any);

    try {
      // Create a payload > 950KB (e.g. 1MB of text)
      const bigString = 'x'.repeat(1024 * 1000);
      const message = { type: 'big_data', payload: bigString };

      host.sendMessage(message);

      // Should have written multiple chunks
      expect(stdoutSpy).toHaveBeenCalled();
      const calls = stdoutSpy.mock.calls;
      expect(calls.length).toBeGreaterThan(1);

      // Verify each chunk is formatted with 4-byte header and __chunked__ flag
      const writtenChunks: any[] = [];
      for (const call of calls) {
        const buf = call[0] as Buffer;
        const len = buf.readUInt32LE(0);
        const json = JSON.parse(buf.slice(4, 4 + len).toString());
        expect(json.__chunked__).toBe(true);
        expect(json.chunkId).toBeDefined();
        expect(json.total).toBe(calls.length);
        writtenChunks.push(json);
      }

      // Verify order and reassembly
      writtenChunks.sort((a, b) => a.index - b.index);
      const reassembledStr = writtenChunks.map((c) => c.chunk).join('');
      const restored = JSON.parse(reassembledStr);
      expect(restored.type).toBe('big_data');
      expect(restored.payload.length).toBe(1024 * 1000);
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  test('sends normal size message directly without chunking', () => {
    const host = new NativeMessagingHost();
    const stdoutSpy = jest.spyOn(stdout, 'write').mockImplementation((() => true) as any);

    try {
      const message = { type: 'ping', payload: 'hello' };
      host.sendMessage(message);

      expect(stdoutSpy).toHaveBeenCalledTimes(1);
      const buf = stdoutSpy.mock.calls[0][0] as Buffer;
      const len = buf.readUInt32LE(0);
      const json = JSON.parse(buf.slice(4, 4 + len).toString());
      expect(json.__chunked__).toBeUndefined();
      expect(json.type).toBe('ping');
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  test('ARCH-04: envelopes for 400,000 Chinese characters must strictly never exceed 1MB UTF-8 ceiling', () => {
    const host = new NativeMessagingHost();
    const stdoutSpy = jest.spyOn(stdout, 'write').mockImplementation((() => true) as any);

    try {
      const chineseText = '汉字测试分片阈值'.repeat(50000); // 400,000 chars = ~1.2MB in UTF-8
      const message = { type: 'chinese_large', payload: chineseText, requestId: 'req-arch-04' };

      host.sendMessage(message);

      expect(stdoutSpy).toHaveBeenCalled();
      const calls = stdoutSpy.mock.calls;

      const CHROME_1MB_CEILING = 1024 * 1024;
      const chunks: any[] = [];
      for (const call of calls) {
        const buf = call[0] as Buffer;
        const len = buf.readUInt32LE(0);
        expect(len).toBeLessThan(CHROME_1MB_CEILING);
        const json = JSON.parse(buf.slice(4, 4 + len).toString('utf8'));
        expect(json.__chunked__).toBe(true);
        chunks.push(json);
      }

      expect(chunks.length).toBeGreaterThan(1);

      chunks.sort((a, b) => a.index - b.index);
      const reassembled = chunks.map((c) => c.chunk).join('');
      const parsed = JSON.parse(reassembled);
      expect(parsed.type).toBe('chinese_large');
      expect(parsed.payload).toBe(chineseText);
      expect(parsed.requestId).toBe('req-arch-04');
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  test('ARCH-04: envelopes with emojis and escaped sequences preserve surrogate pairs and boundaries', () => {
    const host = new NativeMessagingHost();
    const stdoutSpy = jest.spyOn(stdout, 'write').mockImplementation((() => true) as any);

    try {
      // High density of surrogate pairs (emojis) and JSON escapable characters
      const complexText = '🚀"\\\n\t😀🌟🎉'.repeat(60000); // multi-byte and surrogate rich (~1.4MB)
      const message = {
        type: 'emoji_escapes',
        payload: complexText,
        requestId: 'req-arch-04-emoji',
      };

      host.sendMessage(message);

      expect(stdoutSpy).toHaveBeenCalled();
      const calls = stdoutSpy.mock.calls;

      const CHROME_1MB_CEILING = 1024 * 1024;
      const chunks: any[] = [];
      for (const call of calls) {
        const buf = call[0] as Buffer;
        const len = buf.readUInt32LE(0);
        expect(len).toBeLessThan(CHROME_1MB_CEILING);
        const json = JSON.parse(buf.slice(4, 4 + len).toString('utf8'));
        expect(json.__chunked__).toBe(true);
        chunks.push(json);
      }

      expect(chunks.length).toBeGreaterThan(1);

      chunks.sort((a, b) => a.index - b.index);
      const reassembled = chunks.map((c) => c.chunk).join('');
      const parsed = JSON.parse(reassembled);
      expect(parsed.type).toBe('emoji_escapes');
      expect(parsed.payload).toBe(complexText);
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  test('ARCH-04: reassembles out-of-order chunks and isolates concurrent chunkIds', async () => {
    const host = new NativeMessagingHost();
    const handleMessageSpy = jest.spyOn(host as any, 'handleMessage');

    const msgA = { type: 'stream_A', payload: 'AAA'.repeat(1000) };
    const msgB = { type: 'stream_B', payload: 'BBB'.repeat(1000) };
    const strA = JSON.stringify(msgA);
    const strB = JSON.stringify(msgB);

    const chunkIdA = 'chunk-id-AAA';
    const chunkIdB = 'chunk-id-BBB';

    // Interleave chunks and deliver out of order
    await (host as any).handleMessage({
      __chunked__: true,
      chunkId: chunkIdA,
      index: 1,
      total: 2,
      chunk: strA.slice(1500),
    });
    await (host as any).handleMessage({
      __chunked__: true,
      chunkId: chunkIdB,
      index: 0,
      total: 2,
      chunk: strB.slice(0, 1500),
    });
    await (host as any).handleMessage({
      __chunked__: true,
      chunkId: chunkIdA,
      index: 0,
      total: 2,
      chunk: strA.slice(0, 1500),
    });
    await (host as any).handleMessage({
      __chunked__: true,
      chunkId: chunkIdB,
      index: 1,
      total: 2,
      chunk: strB.slice(1500),
    });

    // Both should have reassembled correctly without cross-contamination
    const calls = handleMessageSpy.mock.calls;
    const reassembledA = calls.find((c: any) => c[0]?.type === 'stream_A');
    const reassembledB = calls.find((c: any) => c[0]?.type === 'stream_B');
    expect(reassembledA).toBeDefined();
    expect(reassembledB).toBeDefined();
    expect(reassembledA![0]).toEqual(msgA);
    expect(reassembledB![0]).toEqual(msgB);
  });

  test('ARCH-04: handles duplicate chunks idempotently and cleans up on chunk timeout', async () => {
    jest.useFakeTimers();
    const host = new NativeMessagingHost();
    const handleMessageSpy = jest.spyOn(host as any, 'handleMessage');

    const fullPayload = { type: 'dup_test', data: 'content' };
    const serialized = JSON.stringify(fullPayload);
    const chunkId = 'test-dup-uuid';

    // Send chunk 0 twice (duplicate)
    await (host as any).handleMessage({
      __chunked__: true,
      chunkId,
      index: 0,
      total: 2,
      chunk: serialized.slice(0, 10),
    });
    await (host as any).handleMessage({
      __chunked__: true,
      chunkId,
      index: 0,
      total: 2,
      chunk: serialized.slice(0, 10),
    });

    // Should not resolve early
    expect(handleMessageSpy).toHaveBeenCalledTimes(2);

    // Now send chunk 1 to complete
    await (host as any).handleMessage({
      __chunked__: true,
      chunkId,
      index: 1,
      total: 2,
      chunk: serialized.slice(10),
    });

    // Must resolve correctly with original payload despite duplicate chunk 0
    const calls = handleMessageSpy.mock.calls;
    const resolvedCall = calls.find((c: any) => c[0]?.type === 'dup_test');
    expect(resolvedCall).toBeDefined();
    expect(resolvedCall![0]).toEqual(fullPayload);

    // Test timeout cleanup of incomplete chunks
    await (host as any).handleMessage({
      __chunked__: true,
      chunkId: 'timeout-uuid',
      index: 0,
      total: 2,
      chunk: 'partial',
    });
    expect((host as any).incomingChunks.has('timeout-uuid')).toBe(true);

    // Advance timers by 35 seconds
    jest.advanceTimersByTime(35000);
    expect((host as any).incomingChunks.has('timeout-uuid')).toBe(false);
    jest.useRealTimers();
  });
});
