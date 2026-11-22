import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { isCloudMetadataUrl } from '../utils/restricted-url';
import { navigateTool } from '../entrypoints/background/tools/browser/common';
import { networkRequestTool } from '../entrypoints/background/tools/browser/network-request';
import { batchActionsTool } from '../entrypoints/background/tools/browser/batch-actions';
import { CdpExecuteTool } from '../entrypoints/background/tools/browser/cdp-execute';
import { screenshotContextManager } from '../utils/screenshot-context';
import {
  clearScreenshotValidity,
  createScreenshotCapture,
  ensureScreenshotValidityHydrated,
  validateScreenshotCoordinateBinding,
} from '../utils/screenshot-validity';
import { cdpSessionManager, CDP_IDLE_DETACH_TIMEOUT_MS } from '../utils/cdp-session-manager';

function createMemorySessionStorage(initial: Record<string, any> = {}) {
  const store: Record<string, any> = structuredClone(initial);
  return {
    store,
    api: {
      get: vi.fn(async (keys?: string | string[] | Record<string, any>) => {
        if (!keys) return structuredClone(store);
        if (typeof keys === 'string') {
          return keys in store ? { [keys]: structuredClone(store[keys]) } : {};
        }
        if (Array.isArray(keys)) {
          const out: Record<string, any> = {};
          for (const key of keys) {
            if (key in store) out[key] = structuredClone(store[key]);
          }
          return out;
        }
        return structuredClone(store);
      }),
      set: vi.fn(async (items: Record<string, any>) => {
        for (const [key, value] of Object.entries(items)) {
          store[key] = structuredClone(value);
        }
      }),
      remove: vi.fn(async (keys: string | string[]) => {
        const list = Array.isArray(keys) ? keys : [keys];
        for (const key of list) delete store[key];
      }),
    },
  };
}

describe('Phase 2: Extension security hardening & MV3 SW resilience', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    screenshotContextManager.clear();
    clearScreenshotValidity();
  });

  describe('isCloudMetadataUrl normalization & IPv6 bypass defenses', () => {
    it.each([
      'http://169.254.169.254/latest/meta-data/',
      'http://169.254.170.2/v2/credentials',
      'http://169.254.170.23/v1/credentials',
      'http://[::ffff:169.254.169.254]/latest/meta-data/',
      'http://[::ffff:a9fe:a9fe]/latest/meta-data/',
      'http://[0:0:0:0:0:ffff:169.254.170.2]/v2/credentials',
      'http://[::ffff:100.100.100.200]/latest/meta-data/',
      'http://[64:ff9b::169.254.169.254]/',
      'http://[2002:a9fe:a9fe::1]/',
      'http://[fd00:ec2::254]/latest/meta-data/',
      'http://[fd00:ec2:0:0::254]/latest/meta-data/',
      'http://[fd00:0ec2:0000:0000:0000:0000:0000:0254]/latest/meta-data/',
      'http://metadata.google.internal./computeMetadata/v1/',
      'http://metadata.goog./computeMetadata/v1/',
      'http://sub.metadata.internal./',
      'http://instance-data.ec2.internal./latest/meta-data/',
      'http://0xa9fea9fe/latest/meta-data/',
      'http://2852039166/latest/meta-data/',
    ])('blocks cloud metadata URL %s', (targetUrl) => {
      expect(isCloudMetadataUrl(targetUrl)).toBe(true);
    });

    it.each([
      'https://example.com/',
      'http://[::1]:3000/',
      'https://[2606:4700::1]/',
      'https://127.0.0.1:8080/health',
      'https://metadata.example.com/',
    ])('allows non-metadata URL %s', (targetUrl) => {
      expect(isCloudMetadataUrl(targetUrl)).toBe(false);
    });
  });

  describe('chrome_navigate URL and scheme guards', () => {
    beforeEach(() => {
      (globalThis as any).chrome = {
        runtime: { id: 'test-ext-id' },
        tabs: {
          query: vi.fn().mockResolvedValue([]),
          create: vi.fn(),
          update: vi.fn(),
        },
      };
    });

    it.each([
      'http://169.254.169.254/latest/meta-data',
      'http://[::ffff:169.254.169.254]/latest/meta-data',
      'http://metadata.google.internal./computeMetadata/v1/',
      'chrome://settings',
      'edge://flags',
      'chrome-extension://abcdef/options.html',
      'view-source:https://example.com',
      'data:text/html,<h1>x</h1>',
      'blob:https://example.com/1234',
      '  javascript:alert(1)',
    ])('blocks navigation to %s before touching tabs API', async (blockedUrl) => {
      const res = await navigateTool.execute({ url: blockedUrl });
      expect(res.isError).toBe(true);
      expect(chrome.tabs.create).not.toHaveBeenCalled();
      expect(chrome.tabs.update).not.toHaveBeenCalled();
    });

    it('preserves specific popup.html denial message', async () => {
      const res = await navigateTool.execute({
        url: 'chrome-extension://abcdef/popup.html',
      });
      expect(res.isError).toBe(true);
      expect((res.content[0] as any).text).toContain('popup.html');
    });
  });

  describe('networkRequestTool and network-helper redirect/formData guards', () => {
    it('blocks metadata URLs in formData url: / fileUrl and post-redirect response.url', async () => {
      vi.spyOn(networkRequestTool as any, 'resolveAffinityTab').mockResolvedValue({ id: 55 });
      vi.spyOn(networkRequestTool as any, 'injectContentScript').mockResolvedValue(undefined);
      const sendSpy = vi.spyOn(networkRequestTool as any, 'sendMessageToTab');

      const formArrayRes = await networkRequestTool.execute({
        url: 'https://api.example.com/upload',
        method: 'POST',
        formData: [['file', 'url:http://[::ffff:169.254.169.254]/latest/meta-data']],
      });
      expect(formArrayRes.isError).toBe(true);
      expect(sendSpy).not.toHaveBeenCalled();

      const formObjRes = await networkRequestTool.execute({
        url: 'https://api.example.com/upload',
        method: 'POST',
        formData: { files: [{ name: 'doc', fileUrl: 'http://metadata.google.internal./v1' }] },
      });
      expect(formObjRes.isError).toBe(true);
      expect(sendSpy).not.toHaveBeenCalled();

      sendSpy.mockResolvedValueOnce({
        success: true,
        response: {
          status: 200,
          statusText: 'OK',
          url: 'http://169.254.169.254/latest/meta-data/iam/',
          headers: { 'content-type': 'text/plain' },
          body: 'secret-token',
        },
      });

      const redirectRes = await networkRequestTool.execute({
        url: 'https://redirector.example.com/hop',
      });
      expect(redirectRes.isError).toBe(true);
      expect((redirectRes.content[0] as any).text).not.toContain('secret-token');
    });

    it('network-helper rejects responses redirected to metadata endpoints before reading body', async () => {
      const helperPath = path.resolve(__dirname, '../inject-scripts/network-helper.js');
      const helperSource = fs.readFileSync(helperPath, 'utf8');
      let messageHandler: any;
      const textSpy = vi.fn(async () => 'should-not-be-read');

      const sandbox: any = {
        window: {},
        URL,
        AbortController,
        FormData,
        Blob,
        atob,
        setTimeout,
        clearTimeout,
        console,
        fetch: vi.fn(async () => ({
          status: 200,
          statusText: 'OK',
          url: 'http://[::ffff:169.254.169.254]/latest/meta-data',
          headers: new Headers({ 'content-type': 'text/plain' }),
          text: textSpy,
        })),
        chrome: {
          runtime: {
            onMessage: {
              addListener: (fn: any) => {
                messageHandler = fn;
              },
            },
          },
        },
      };
      vm.runInNewContext(helperSource, sandbox);

      const response = await new Promise<any>((resolve) => {
        messageHandler(
          {
            action: 'sendPureNetworkRequest',
            url: 'https://public.example.com/redirect',
            method: 'GET',
          },
          {},
          resolve,
        );
      });

      expect(response.success).toBe(false);
      expect(response.error).toContain('Security Restriction');
      expect(textSpy).not.toHaveBeenCalled();
    });
  });

  describe('batchActionsTool screenshot coordinate binding & origin violation guards', () => {
    const tabId = 712;

    beforeEach(() => {
      const mem = createMemorySessionStorage();
      (globalThis as any).chrome = {
        runtime: { id: 'test-ext-id' },
        storage: { session: mem.api, local: createMemorySessionStorage().api },
        tabs: {
          get: vi.fn(async () => ({
            id: tabId,
            windowId: 1,
            url: 'https://evil.example.com/page',
          })),
          query: vi.fn(async () => [
            { id: tabId, active: true, windowId: 1, url: 'https://evil.example.com/page' },
          ]),
        },
        scripting: {
          executeScript: vi.fn(async () => [{ result: { success: true } }]),
        },
      };
      vi.spyOn(batchActionsTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: tabId,
        windowId: 1,
        url: 'https://evil.example.com/page',
      });
      vi.spyOn(batchActionsTool as any, 'ensureFocus').mockResolvedValue(undefined);
    });

    it('rejects screenshot-space click without captureId', async () => {
      const cdpSpy = vi.spyOn(cdpSessionManager, 'sendCommand');
      const res = await batchActionsTool.execute({
        tabId,
        actions: [
          {
            type: 'click',
            coordinate: { x: 100, y: 120 },
            coordinateSpace: 'screenshot',
          },
        ],
      });
      expect(res.isError).toBe(true);
      expect((res.content[0] as any).text).toContain('captureId');
      expect(cdpSpy).not.toHaveBeenCalled();
    });

    it('blocks viewport coordinate click and scroll when domain changed since last screenshot', async () => {
      screenshotContextManager.setContext(tabId, {
        screenshotWidth: 1000,
        screenshotHeight: 800,
        viewportWidth: 1000,
        viewportHeight: 800,
        hostname: 'trusted.example.com',
        url: 'https://trusted.example.com/dashboard',
      });
      const cdpSpy = vi.spyOn(cdpSessionManager, 'sendCommand');

      const clickRes = await batchActionsTool.execute({
        tabId,
        actions: [{ type: 'click', coordinate: { x: 50, y: 60 } }],
      });
      expect(clickRes.isError).toBe(true);
      expect((clickRes.content[0] as any).text).toContain('Domain changed since last screenshot');
      expect(cdpSpy).not.toHaveBeenCalled();

      const scrollRes = await batchActionsTool.execute({
        tabId,
        actions: [{ type: 'scroll', direction: 'down', coordinate: { x: 50, y: 60 } }],
      });
      expect(scrollRes.isError).toBe(true);
      expect((scrollRes.content[0] as any).text).toContain('Domain changed since last screenshot');
      expect(cdpSpy).not.toHaveBeenCalled();
    });
  });

  describe('CdpExecuteTool dangerous method blocklist & specificTargetId timeout lease', () => {
    it.each([
      'Browser.setDownloadBehavior',
      'Page.setDownloadBehavior',
      'Target.disposeBrowserContext',
    ])('blocks dangerous CDP method %s', async (method) => {
      const tool = new CdpExecuteTool();
      const res = await tool.execute({ method, tabId: 1 });
      expect(res.isError).toBe(true);
      expect((res.content[0] as any).text).toContain('Security restriction');
    });

    it('does not detach specificTargetId on timeout when target was already attached externally', async () => {
      const tool = new CdpExecuteTool();
      const detachMock = vi.fn().mockResolvedValue(undefined);
      (globalThis as any).chrome = {
        debugger: {
          attach: vi.fn().mockRejectedValue(new Error('Another client is already attached')),
          detach: detachMock,
          getTargets: vi.fn().mockResolvedValue([]),
          sendCommand: vi.fn(() => new Promise(() => {})),
        },
      };

      const res = await tool.execute({
        target: { targetId: 'ext-attached-target' },
        method: 'Runtime.evaluate',
        params: { expression: '1+1' },
        timeoutMs: 30,
      });

      expect(res.isError).toBe(true);
      expect((res.content[0] as any).text).toContain('Timed out after 30ms');
      expect(detachMock).not.toHaveBeenCalled();
    });

    it('detaches specificTargetId on timeout only when attached by this call and no sibling lease remains', async () => {
      const tool = new CdpExecuteTool();
      const detachMock = vi.fn().mockResolvedValue(undefined);
      (globalThis as any).chrome = {
        debugger: {
          attach: vi.fn().mockResolvedValue(undefined),
          detach: detachMock,
          getTargets: vi.fn().mockResolvedValue([]),
          sendCommand: vi.fn(() => new Promise(() => {})),
        },
      };

      const res = await tool.execute({
        target: { targetId: 'self-attached-target' },
        method: 'Runtime.evaluate',
        params: { expression: '1+1' },
        timeoutMs: 30,
      });

      expect(res.isError).toBe(true);
      expect(detachMock).toHaveBeenCalledWith({ targetId: 'self-attached-target' });
    });
  });

  describe('MV3 Service Worker storage.session & chrome.alarms resilience', () => {
    it('rehydrates screenshot context and capture validity from chrome.storage.session across SW restart', async () => {
      const tabId = 808;
      const mem = createMemorySessionStorage();
      (globalThis as any).chrome = {
        runtime: { id: 'test-ext-id' },
        storage: { session: mem.api },
        scripting: {
          executeScript: vi.fn(async () => [
            {
              result: {
                documentId: 'doc-sw-1',
                documentURL: 'https://example.com',
                width: 1280,
                height: 800,
                dpr: 2,
                scrollX: 0,
                scrollY: 120,
                domRevision: 4,
                observerInitializedNow: false,
              },
            },
          ]),
        },
      };

      screenshotContextManager.setContext(tabId, {
        screenshotWidth: 1280,
        screenshotHeight: 800,
        viewportWidth: 1280,
        viewportHeight: 800,
        hostname: 'example.com',
        url: 'https://example.com',
      });
      const savedCtx = screenshotContextManager.getContext(tabId)!;
      const capture = createScreenshotCapture({
        tabId,
        state: {
          documentId: 'doc-sw-1',
          documentURL: 'https://example.com',
          width: 1280,
          height: 800,
          dpr: 2,
          scrollX: 0,
          scrollY: 120,
        },
        contextTimestamp: savedCtx.timestamp,
        domRevision: 4,
        coordinateValidationSupported: true,
      });

      // Snapshot persisted storage, clear memory, restore persisted storage to simulate cold SW wake
      const persistedSnapshot = structuredClone(mem.store);
      screenshotContextManager.clear();
      clearScreenshotValidity();
      expect(screenshotContextManager.getContext(tabId)).toBeUndefined();
      Object.assign(mem.store, persistedSnapshot);

      await screenshotContextManager.ensureHydrated(true);
      await ensureScreenshotValidityHydrated(true);

      const binding = await validateScreenshotCoordinateBinding({
        tabId,
        captureId: capture.captureId,
        coordinateSpace: 'screenshot',
      });
      expect(binding.error).toBeUndefined();
      expect(binding.captureId).toBe(capture.captureId);
      expect(screenshotContextManager.getContext(tabId)?.hostname).toBe('example.com');
    });

    it('persists CDP idle alarm + domains and detaches orphaned extension session when alarm fires post-SW restart', async () => {
      const tabId = 909;
      const mem = createMemorySessionStorage();
      const alarmCreate = vi.fn().mockResolvedValue(undefined);
      const alarmClear = vi.fn().mockResolvedValue(true);
      const detachMock = vi.fn().mockResolvedValue(undefined);
      const sendCommandMock = vi.fn(async (_target: any, method: string) => {
        if (method === 'Page.getLayoutMetrics') return { layoutViewport: { pageX: 0, pageY: 0 } };
        return {};
      });

      (globalThis as any).chrome = {
        runtime: { id: 'real-like-ext-id' },
        storage: { session: mem.api },
        alarms: {
          create: alarmCreate,
          clear: alarmClear,
          onAlarm: { addListener: vi.fn() },
        },
        debugger: {
          attach: vi.fn().mockResolvedValue(undefined),
          detach: detachMock,
          sendCommand: sendCommandMock,
          getTargets: vi.fn().mockResolvedValue([]),
        },
      };

      await cdpSessionManager.attach(tabId, 'owner-a');
      await cdpSessionManager.enableDomain(tabId, 'CSS');
      await cdpSessionManager.detach(tabId, 'owner-a');
      await (cdpSessionManager as any).storageWriteQueue;

      expect(alarmCreate).toHaveBeenCalledWith(
        `browserpaw-cdp-idle-detach:${tabId}`,
        expect.objectContaining({ when: expect.any(Number) }),
      );
      expect(mem.store.browserpaw_cdp_sessions_v1?.[String(tabId)]?.domains).toContain('CSS');

      // Simulate SW restart: wipe in-memory manager maps while preserving storage.session + attached target
      const savedSessionMap = structuredClone(mem.store.browserpaw_cdp_sessions_v1);
      savedSessionMap[String(tabId)].idleDetachAt = Date.now() - 1000;
      await cdpSessionManager.detachDebugger(tabId);
      await (cdpSessionManager as any).storageWriteQueue;
      detachMock.mockClear();
      sendCommandMock.mockClear();
      mem.store.browserpaw_cdp_sessions_v1 = savedSessionMap;
      (chrome.debugger.getTargets as any).mockResolvedValue([
        { tabId, attached: true, type: 'page' },
      ]);

      // Re-adoption restores persisted CSS domain too
      await cdpSessionManager.attach(tabId, 'owner-after-wake');
      expect(sendCommandMock).toHaveBeenCalledWith({ tabId }, 'CSS.enable', {});

      // Now simulate another cold wake where the idle alarm fires after deadline
      await cdpSessionManager.detachDebugger(tabId);
      await (cdpSessionManager as any).storageWriteQueue;
      detachMock.mockClear();
      mem.store.browserpaw_cdp_sessions_v1 = {
        [String(tabId)]: {
          tabId,
          attachedByUs: true,
          idleDetachAt: Date.now() - CDP_IDLE_DETACH_TIMEOUT_MS,
          domains: ['Page', 'Network'],
        },
      };

      await cdpSessionManager.handleIdleDetachAlarm(tabId);
      await (cdpSessionManager as any).storageWriteQueue;
      expect(detachMock).toHaveBeenCalledWith({ tabId });
      expect(mem.store.browserpaw_cdp_sessions_v1?.[String(tabId)]).toBeUndefined();
    });
  });
});
