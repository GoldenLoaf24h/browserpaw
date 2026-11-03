import { describe, it, expect } from 'vitest';
import { DEFAULT_STACK_FRAMES, formatErrorForAgent, MAX_STACK_LINE_CHARS } from 'chrome-mcp-shared';

/**
 * Unexpected tool failures used to reach the agent as a bare message string —
 * three layers each kept only `error.message`, so the stack was gone and a bug
 * could only be located by reproducing it under a debugger. The helper keeps a
 * bounded stack: enough to locate the throw site, capped so it cannot dominate
 * the response.
 */
function makeError(message = 'boom'): Error {
  const err = new Error(message);
  err.stack = [
    'Error: ' + message,
    '    at alpha (/src/a.ts:1:1)',
    '    at beta (/src/b.ts:2:2)',
    '    at gamma (/src/c.ts:3:3)',
    '    at delta (/src/d.ts:4:4)',
    '    at epsilon (/src/e.ts:5:5)',
    '    at zeta (/src/f.ts:6:6)',
    '    at eta (/src/g.ts:7:7)',
  ].join('\n');
  return err;
}

describe('formatErrorForAgent', () => {
  it('keeps the message and a bounded number of stack frames', () => {
    const text = formatErrorForAgent(makeError('kaboom'));

    expect(text).toContain('kaboom');
    expect(text).toContain('at alpha');
    // Default cap is 5 frames; the 6th and 7th must be dropped.
    expect(text).toContain('at epsilon');
    expect(text).not.toContain('at zeta');
    expect(text).toContain('2 more frame(s) omitted');
  });

  it('honours an explicit frame cap and can disable the stack', () => {
    expect(formatErrorForAgent(makeError(), { maxFrames: 2 })).toContain('at beta');
    expect(formatErrorForAgent(makeError(), { maxFrames: 2 })).not.toContain('at gamma');

    const noStack = formatErrorForAgent(makeError('plain'), { maxFrames: 0 });
    expect(noStack).toBe('plain');
    expect(noStack).not.toContain('at alpha');
  });

  it('prefixes context and preserves a non-default error name', () => {
    const err = makeError('timeout');
    err.name = 'TimeoutError';

    const text = formatErrorForAgent(err, { context: 'Tool chrome_smart_scroll failed' });

    expect(text.startsWith('Tool chrome_smart_scroll failed: TimeoutError: timeout')).toBe(true);
  });

  it('omits the redundant "Error:" name and survives a missing stack', () => {
    const err = new Error('no stack here');
    delete err.stack;

    expect(formatErrorForAgent(err)).toBe('no stack here');
  });

  it('stringifies non-Error throwables instead of printing [object Object]', () => {
    expect(formatErrorForAgent('raw string')).toBe('raw string');
    expect(formatErrorForAgent(undefined)).toBe('undefined');
    expect(formatErrorForAgent({ code: 42 })).not.toContain('[object Object]');
    expect(formatErrorForAgent({ code: 42 })).toContain('42');
  });

  it('truncates pathologically long frames', () => {
    const err = new Error('long');
    err.stack = ['Error: long', '    at ' + 'x'.repeat(500)].join('\n');

    const text = formatErrorForAgent(err);
    const frame = text.split('\n')[1];

    expect(frame.length).toBeLessThanOrEqual(MAX_STACK_LINE_CHARS + 1);
    expect(frame.endsWith('…')).toBe(true);
  });

  it('preserves cross-world diagnostic fields without serializing user payloads', () => {
    const error: any = {
      name: 'ProtocolError',
      message: 'Frame detached',
      code: -32000,
      body: 'private draft',
    };
    error.self = error;
    const text = formatErrorForAgent(error);
    expect(text).toContain('ProtocolError: Frame detached');
    expect(text).toContain('-32000');
    expect(text).not.toContain('private draft');
    expect(text).not.toContain('[object Object]');
  });

  it('handles nested protocol errors and circular error wrappers', () => {
    expect(formatErrorForAgent({ error: { message: 'Nested failure', code: 5 } })).toContain(
      'Nested failure',
    );
    const cyclic: any = {};
    cyclic.error = cyclic;
    expect(formatErrorForAgent(cyclic)).toBe('[Circular error]');
  });

  it('defaults are documented constants, not magic numbers', () => {
    expect(DEFAULT_STACK_FRAMES).toBe(5);
    expect(MAX_STACK_LINE_CHARS).toBe(200);
  });
});
