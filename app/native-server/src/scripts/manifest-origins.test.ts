import { describe, expect, test, afterEach } from '@jest/globals';
import { createManifestContent } from './utils';
import * as doctorModule from './doctor';
import { DEFAULT_EXTENSION_ID, getAllowedExtensionIds } from '../constant';

const ENV_KEYS = ['CHROME_EXTENSION_ID', 'EXTENSION_ID'] as const;

// The validator is consumed through an untyped handle so the suite still runs (and
// fails behaviourally) before the helper exists.
function missingOrigins(allowedOrigins: unknown, expectedOrigins: string[]): string[] {
  const helper = (doctorModule as Record<string, unknown>).findMissingManifestOrigins as
    ((allowed: unknown, expected: string[]) => string[]) | undefined;
  expect(typeof helper).toBe('function');
  return (helper as (allowed: unknown, expected: string[]) => string[])(
    allowedOrigins,
    expectedOrigins,
  );
}

describe('Native messaging manifest allowed_origins (B-09)', () => {
  const originalEnv = new Map<string, string | undefined>();

  ENV_KEYS.forEach((key) => originalEnv.set(key, process.env[key]));

  afterEach(() => {
    ENV_KEYS.forEach((key) => {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  });

  test('1. createManifestContent maps every id returned by getAllowedExtensionIds()', async () => {
    process.env.CHROME_EXTENSION_ID = 'ext1,ext2';

    const manifest = await createManifestContent();
    const origins = manifest.allowed_origins as string[];

    expect(origins).toContain('chrome-extension://ext1/');
    expect(origins).toContain('chrome-extension://ext2/');
    expect(origins).toContain(`chrome-extension://${DEFAULT_EXTENSION_ID}/`);
    expect(new Set(origins).size).toBe(origins.length);
    expect(origins).toEqual(getAllowedExtensionIds().map((id) => `chrome-extension://${id}/`));
  });

  test('2. createManifestContent falls back to the default id when no override is set', async () => {
    delete process.env.CHROME_EXTENSION_ID;
    delete process.env.EXTENSION_ID;

    const manifest = await createManifestContent();

    expect(manifest.allowed_origins).toEqual([`chrome-extension://${DEFAULT_EXTENSION_ID}/`]);
  });

  test('3. doctor validator flags every origin missing from a manifest', () => {
    process.env.CHROME_EXTENSION_ID = 'ext1,ext2';
    const expected = getAllowedExtensionIds().map((id) => `chrome-extension://${id}/`);

    expect(missingOrigins(expected, expected)).toEqual([]);

    // A manifest carrying only the default + ext1 must be reported as missing ext2.
    const partial = [`chrome-extension://${DEFAULT_EXTENSION_ID}/`, 'chrome-extension://ext1/'];
    expect(missingOrigins(partial, expected)).toEqual(['chrome-extension://ext2/']);

    // Non-array / malformed manifests must report every expected origin as missing.
    expect(missingOrigins(undefined, expected)).toEqual(expected);
    expect(missingOrigins([42, 'chrome-extension://ext1/'], expected)).toEqual([
      `chrome-extension://${DEFAULT_EXTENSION_ID}/`,
      'chrome-extension://ext2/',
    ]);
  });
});
