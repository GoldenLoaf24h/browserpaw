import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { batchActionsTool } from '../entrypoints/background/tools/browser/batch-actions';
import * as locator from '../entrypoints/background/tools/browser/unified-locator';
import * as engine from '../entrypoints/background/tools/browser/in-page-engine';
import * as fillCore from '../entrypoints/background/tools/browser/fill-core';

describe('getBy locator execution contract', () => {
  beforeEach(() => {
    (globalThis as any).chrome = {
      runtime: {
        getPlatformInfo: vi.fn(async () => ({ os: 'win' })),
      },
      tabs: {
        get: vi.fn(async () => ({ id: 20, url: 'https://example.com/' })),
        onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      webNavigation: {
        onCreatedNavigationTarget: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    };
    vi.spyOn(batchActionsTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: 20,
      url: 'https://example.com/',
    });
    vi.spyOn(engine, 'executeInPage').mockImplementation(async (_target, fnName) => {
      if (fnName === 'inPageDetectPerceptiveSignature') return [{ result: null }] as any;
      return [{ result: { success: true } }] as any;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('polls the real target locator for locator.waitFor and keeps frame semantics', async () => {
    let observations = 0;
    const resolve = vi.spyOn(locator, 'resolveTargetLocation').mockImplementation(async () => {
      observations++;
      if (observations === 1) {
        return {
          success: false,
          x: 0,
          y: 0,
          resolutionPath: 'text',
          notFound: true,
          error: 'not found yet',
        };
      }
      return {
        success: true,
        x: 10,
        y: 20,
        resolutionPath: 'text',
        index: 9,
        text: 'Later',
        tagName: 'button',
        frameId: 7,
      };
    });

    const result = await batchActionsTool.execute({
      tabId: 20,
      actions: [
        {
          type: 'assert',
          targetText: 'Later',
          condition: 'visible',
          timeoutMs: 150,
          abortOnFailure: true,
          frameId: 7,
        } as any,
      ],
    });

    expect(result.isError).toBe(false);
    expect(observations).toBeGreaterThan(1);
    expect(resolve).toHaveBeenCalledWith(
      20,
      expect.objectContaining({ targetText: 'Later', frameId: 7 }),
    );
  });

  it('fails immediately on strict ambiguity instead of treating it as hidden', async () => {
    const resolve = vi.spyOn(locator, 'resolveTargetLocation').mockResolvedValue({
      success: false,
      x: 0,
      y: 0,
      resolutionPath: 'role',
      error: 'Strict mode violation: role "button" resolved to 2 visible elements',
    });

    const result = await batchActionsTool.execute({
      tabId: 20,
      actions: [
        {
          type: 'assert',
          role: 'button',
          text: 'Save',
          condition: 'not_visible',
          timeoutMs: 1000,
          abortOnFailure: true,
        } as any,
      ],
    });

    expect(result.isError).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain('Strict mode violation');
  });

  it('resolves semantic fill targets to the existing physical fill engine', async () => {
    vi.spyOn(locator, 'resolveTargetLocation').mockResolvedValue({
      success: true,
      x: 12,
      y: 18,
      resolutionPath: 'label',
      index: 33,
      tagName: 'input',
      text: 'Email address',
      frameId: 7,
    });
    const fill = vi.spyOn(fillCore, 'performPhysicalFill').mockResolvedValue({
      success: true,
      committed: true,
      filledText: 'person@example.com',
      isTrusted: true,
      method: 'cdp_native',
    });

    const result = await batchActionsTool.execute({
      tabId: 20,
      actions: [
        {
          type: 'fill',
          label: 'Email address',
          value: 'person@example.com',
          frameId: 7,
        } as any,
      ],
    });

    expect(result.isError).toBe(false);
    expect(fill).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 20,
        target: 33,
        text: 'person@example.com',
        frameId: 7,
      }),
    );
  });
});
