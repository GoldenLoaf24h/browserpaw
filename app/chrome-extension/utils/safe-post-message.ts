export const MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024; // 1MB physical Native Messaging ceiling
export const CHUNK_THRESHOLD_BYTES = 950 * 1024; // 950KB threshold for transparent chunking
export const CHUNK_SIZE = 850 * 1024; // 850KB per chunk safe slice

export interface ChunkedMessageEnvelope {
  __chunked__: true;
  chunkId: string;
  index: number;
  total: number;
  chunk: string;
  responseToRequestId?: string;
  requestId?: string;
}

/**
 * Native Messaging transparent chunking & 1MB physical ceiling defense:
 * If message is >= 950KB, chunks it transparently into slices comfortably under 1MB.
 */
export function safePostMessage(
  port: chrome.runtime.Port | null | undefined,
  msg: any,
  fallbackRequestId?: string,
): boolean {
  if (!port) return false;
  try {
    const serialized = JSON.stringify(msg);
    const encoder = new TextEncoder();
    const byteLength = encoder.encode(serialized).length;

    if (byteLength >= CHUNK_THRESHOLD_BYTES) {
      const chunkId =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `chunk_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

      // Slice serialized string such that each chunk's UTF-8 byte length is strictly <= CHUNK_SIZE
      const slices = [];
      let start = 0;
      const len = serialized.length;
      while (start < len) {
        let guess = Math.min(len, start + Math.floor(CHUNK_SIZE / 2));
        while (
          guess < len &&
          encoder.encode(serialized.slice(start, Math.min(len, guess + 4096))).length <= CHUNK_SIZE
        ) {
          guess = Math.min(len, guess + 4096);
        }
        while (
          encoder.encode(serialized.slice(start, guess)).length > CHUNK_SIZE &&
          guess > start
        ) {
          guess -= 100;
        }
        while (
          guess < len &&
          encoder.encode(serialized.slice(start, guess + 1)).length <= CHUNK_SIZE
        ) {
          guess++;
        }
        if (guess > start && guess < len) {
          const code = serialized.charCodeAt(guess - 1);
          if (code >= 0xd800 && code <= 0xdbff) {
            guess--;
          }
        }
        slices.push(serialized.slice(start, guess));
        start = guess;
      }

      const total = slices.length;
      for (let i = 0; i < total; i++) {
        const slice = slices[i];
        const chunkEnvelope: ChunkedMessageEnvelope = {
          __chunked__: true,
          chunkId,
          index: i,
          total,
          chunk: slice,
          responseToRequestId: msg?.responseToRequestId || fallbackRequestId,
          requestId: msg?.requestId,
        };
        port.postMessage(chunkEnvelope);
      }
      return true;
    }

    port.postMessage(msg);
    return true;
  } catch (err) {
    console.error('[NativeHost] Failed in safePostMessage:', err);
    return false;
  }
}

/**
 * Reassembles incoming chunked messages sent from Native Host or Extension.
 */
export class ChunkReassembler {
  private incoming = new Map<
    string,
    { total: number; received: Map<number, string>; timer: any }
  >();

  public processMessage(message: any, onComplete: (fullMessage: any) => void): boolean {
    if (!message || !message.__chunked__) return false;
    const { chunkId, index, total, chunk } = message;
    let record = this.incoming.get(chunkId);
    if (!record) {
      record = {
        total,
        received: new Map(),
        timer: setTimeout(() => {
          this.incoming.delete(chunkId);
        }, 30000),
      };
      this.incoming.set(chunkId, record);
    }
    record.received.set(index, chunk);
    if (record.received.size === total) {
      clearTimeout(record.timer);
      this.incoming.delete(chunkId);
      const pieces: string[] = [];
      for (let i = 0; i < total; i++) {
        pieces.push(record.received.get(i) || '');
      }
      try {
        const full = JSON.parse(pieces.join(''));
        onComplete(full);
      } catch (e) {
        console.error('[ChunkReassembler] JSON parse failed on assembled message:', e);
      }
    }
    return true;
  }

  public clear(): void {
    for (const record of this.incoming.values()) {
      clearTimeout(record.timer);
    }
    this.incoming.clear();
  }
}
