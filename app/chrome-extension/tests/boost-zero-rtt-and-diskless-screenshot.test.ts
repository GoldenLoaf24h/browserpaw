import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  inPageVerifyInputCommitment,
  getIsolatedIndexMap,
} from '../entrypoints/background/tools/browser/dom-indexer';
import { TOOL_SCHEMAS } from 'chrome-mcp-shared';

describe('Zero-RTT Submission & Diskless Screenshot Hardening', () => {
  describe('1. True Input Commitment & Submit Button Index Detection', () => {
    beforeEach(() => {
      document.body.innerHTML = '';
      getIsolatedIndexMap().clear();
    });

    it('resolves nearby submit button index and returns it in submitButtonState', () => {
      const form = document.createElement('form');
      const input = document.createElement('input');
      input.type = 'text';
      input.name = 'phone';
      input.value = '13800138000';

      const submitBtn = document.createElement('button');
      submitBtn.type = 'submit';
      submitBtn.textContent = '查询';
      submitBtn.disabled = false;

      form.appendChild(input);
      form.appendChild(submitBtn);
      document.body.appendChild(form);

      getIsolatedIndexMap().set(15, input);
      getIsolatedIndexMap().set(18, submitBtn);

      const verified = inPageVerifyInputCommitment(15, '13800138000');
      expect(verified.committed).toBe(true);
      expect(verified.submitButtonState?.found).toBe(true);
      expect(verified.submitButtonState?.text).toBe('查询');
      expect(verified.submitButtonState?.index).toBe(18);
    });

    it('detects search buttons with query-related labels (search, 搜索, 查询)', () => {
      const form = document.createElement('form');
      const input = document.createElement('input');
      input.value = 'keyword';
      const btn = document.createElement('button');
      btn.textContent = '搜索';

      form.appendChild(input);
      form.appendChild(btn);
      document.body.appendChild(form);

      getIsolatedIndexMap().set(10, input);
      getIsolatedIndexMap().set(12, btn);

      const verified = inPageVerifyInputCommitment(10, 'keyword');
      expect(verified.committed).toBe(true);
      expect(verified.submitButtonState?.found).toBe(true);
      expect(verified.submitButtonState?.index).toBe(12);
      expect(verified.submitButtonState?.text).toBe('搜索');
    });

    it('detects prefixed buttons (立即查询, 🔍 搜索, Search Now) and ASP.NET doPostBack buttons', () => {
      const form = document.createElement('form');
      const input = document.createElement('input');
      input.value = '13800138000';

      const prefixedBtn = document.createElement('button');
      prefixedBtn.textContent = '立即查询';

      form.appendChild(input);
      form.appendChild(prefixedBtn);
      document.body.appendChild(form);

      getIsolatedIndexMap().set(21, input);
      getIsolatedIndexMap().set(22, prefixedBtn);

      const verified = inPageVerifyInputCommitment(21, '13800138000');
      expect(verified.committed).toBe(true);
      expect(verified.submitButtonState?.found).toBe(true);
      expect(verified.submitButtonState?.index).toBe(22);
      expect(verified.submitButtonState?.text).toBe('立即查询');
    });

    it('detects buttons in non-form search wrappers and input-groups', () => {
      const searchBox = document.createElement('div');
      searchBox.className = 'search-box input-group';

      const inputWrap = document.createElement('div');
      inputWrap.className = 'input-wrapper';
      const input = document.createElement('input');
      input.value = 'query';
      inputWrap.appendChild(input);

      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = 'Search';

      searchBox.appendChild(inputWrap);
      searchBox.appendChild(btn);
      document.body.appendChild(searchBox);

      getIsolatedIndexMap().set(30, input);
      getIsolatedIndexMap().set(31, btn);

      const verified = inPageVerifyInputCommitment(30, 'query');
      expect(verified.committed).toBe(true);
      expect(verified.submitButtonState?.found).toBe(true);
      expect(verified.submitButtonState?.index).toBe(31);
      expect(verified.submitButtonState?.text).toBe('Search');
    });

    it('detects external submit button associated via HTML5 form="formId" attribute', () => {
      const form = document.createElement('form');
      form.id = 'aspnetForm';
      const input = document.createElement('input');
      input.value = '18888888888';
      form.appendChild(input);
      document.body.appendChild(form);

      const externalBtn = document.createElement('button');
      externalBtn.setAttribute('form', 'aspnetForm');
      externalBtn.textContent = 'Submit';
      document.body.appendChild(externalBtn);

      getIsolatedIndexMap().set(40, input);
      getIsolatedIndexMap().set(41, externalBtn);

      const verified = inPageVerifyInputCommitment(40, '18888888888');
      expect(verified.committed).toBe(true);
      expect(verified.submitButtonState?.found).toBe(true);
      expect(verified.submitButtonState?.index).toBe(41);
    });
  });

  describe('2. chrome_read_dom pipelineHint', () => {
    it('provides pipelineHint in payload to advertise 1-turn execution', async () => {
      const mod = await import('../entrypoints/background/tools/browser/read-dom');
      const engine = await import('../entrypoints/background/tools/browser/in-page-engine');
      const spy = vi.spyOn(engine, 'executeInPage');
      spy.mockResolvedValue([
        {
          frameId: 0,
          result: {
            treeString: '[15] <input id="phone">\n[18] <button>Submit</button>',
            elementCount: 2,
            interactiveCount: 2,
            indexedElements: [
              { index: 15, tagName: 'input', attributes: { id: 'phone' }, isInteractive: true },
              { index: 18, tagName: 'button', text: 'Submit', attributes: {}, isInteractive: true },
            ],
            pages_up: 0,
            pages_down: 0,
          },
        },
      ] as any);

      (mod.readDOMTool as any).resolveAffinityTab = async () => ({
        id: 101,
        url: 'https://example.com',
        title: 'Example',
      });

      const res = await mod.readDOMTool.execute({} as any);
      spy.mockRestore();

      expect(res.isError).toBe(false);
      const parsed = JSON.parse(res.content[0].text as string);
      expect(parsed.pipelineHint).toBeDefined();
      expect(parsed.pipelineHint).toContain('1-Turn Optimal Paradigm');
      expect(parsed.pipelineHint).toMatch(/(browserpaw|browserclaw|chrome)_batch_actions/);
      expect(parsed.pipelineHint).toContain('pressEnter: true');
    });
  });

  describe('3. chrome_screenshot Diskless In-Memory Contract', () => {
    beforeEach(async () => {
      (chrome.tabs.get as any) = vi.fn(async (id: number) => ({
        id,
        windowId: 1,
        url: 'https://example.com',
      }));
      (chrome.tabs.query as any) = vi.fn(async () => [
        { id: 1, active: true, windowId: 1, url: 'https://example.com' },
      ]);
      (chrome as any).downloads = {
        download: vi.fn(async () => 123),
        search: vi.fn(async () => [{ id: 123, filename: 'D:\\Downloads\\download.png' }]),
      };
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('screenshot remains purely in-memory by default when name is provided (fileSaved: false, zero downloads)', async () => {
      const { screenshotTool } = await import('../entrypoints/background/tools/browser/screenshot');
      (screenshotTool as any).resolveAffinityTab = async () => ({
        id: 1,
        url: 'https://example.com',
        title: 'Example',
      });

      const cdpMod = await import('@/utils/cdp-session-manager');
      const withSessionSpy = vi
        .spyOn(cdpMod.cdpSessionManager, 'withSession')
        .mockImplementation(async (_tabId: any, _owner: any, fn: any) => {
          return await fn();
        });
      const sendCommandSpy = vi.spyOn(cdpMod.cdpSessionManager, 'sendCommand').mockResolvedValue({
        data: 'UklGRkAAAABXRUJQVlA4IDQAAADwAQCdASoBAAEAAkA4JaQAA3AA/vsGAAA=',
        mimeType: 'image/webp',
      });

      const res = await screenshotTool.execute({ name: 'phone_results' });
      expect(res.isError).toBe(false);

      const payload = JSON.parse(res.content[0].text as string);
      expect(payload.success).toBe(true);
      expect(payload.name).toBe('phone_results');
      expect(payload.fileSaved).toBe(false);
      expect(payload.downloadId).toBeUndefined();
      expect(payload.fullPath).toBeUndefined();

      // Ensure chrome.downloads.download was NEVER called
      expect((chrome as any).downloads.download).not.toHaveBeenCalled();

      // Ensure MCP image content block is returned directly in-memory
      expect(res.content.some((c: any) => c.type === 'image')).toBe(true);

      withSessionSpy.mockRestore();
      sendCommandSpy.mockRestore();
    });

    it('routes disk save to system temporary directory via native host when savePng is true', async () => {
      const { screenshotTool } = await import('../entrypoints/background/tools/browser/screenshot');
      (screenshotTool as any).resolveAffinityTab = async () => ({
        id: 1,
        url: 'https://example.com',
        title: 'Example',
      });

      const cdpMod = await import('@/utils/cdp-session-manager');
      const withSessionSpy = vi
        .spyOn(cdpMod.cdpSessionManager, 'withSession')
        .mockImplementation(async (_tabId: any, _owner: any, fn: any) => {
          return await fn();
        });
      const sendCommandSpy = vi.spyOn(cdpMod.cdpSessionManager, 'sendCommand').mockResolvedValue({
        data: 'UklGRkAAAABXRUJQVlA4IDQAAADwAQCdASoBAAEAAkA4JaQAA3AA/vsGAAA=',
        mimeType: 'image/webp',
      });

      const nativeHostMod = await import('../entrypoints/background/native-host');
      const ensureSpy = vi.spyOn(nativeHostMod, 'ensureNativeConnected').mockResolvedValue(true);
      const sendSpy = vi.spyOn(nativeHostMod, 'sendFileOperationToNative');
      sendSpy.mockImplementation((msg: any, cb?: any) => {
        if (msg.type === 'file_operation' && msg.payload.action === 'prepareFile') {
          setTimeout(() => {
            cb?.({
              payload: {
                success: true,
                filePath:
                  'C:\\Users\\User\\AppData\\Local\\Temp\\chrome-mcp-uploads\\phone_results_test.webp',
              },
            });
          }, 5);
          return true;
        }
        return false;
      });

      const res = await screenshotTool.execute({ name: 'phone_results', savePng: true });
      expect(res.isError).toBe(false);

      const payload = JSON.parse(res.content[0].text as string);
      expect(payload.fileSaved).toBe(true);
      expect(payload.savedTo).toBe('system_temp');
      expect(payload.fullPath).toContain('chrome-mcp-uploads');
      // Verify downloads.download was NOT invoked because native host handled temp storage
      expect((chrome as any).downloads.download).not.toHaveBeenCalled();

      withSessionSpy.mockRestore();
      sendCommandSpy.mockRestore();
      sendSpy.mockRestore();
      ensureSpy.mockRestore();
    }, 15000);

    it('safely handles large screenshot payloads by ensuring size under Native Messaging ceiling before sending', async () => {
      const { screenshotTool } = await import('../entrypoints/background/tools/browser/screenshot');
      (screenshotTool as any).resolveAffinityTab = async () => ({
        id: 1,
        url: 'https://example.com',
        title: 'Example',
      });

      const cdpMod = await import('@/utils/cdp-session-manager');
      const withSessionSpy = vi
        .spyOn(cdpMod.cdpSessionManager, 'withSession')
        .mockImplementation(async (_tabId: any, _owner: any, fn: any) => {
          return await fn();
        });
      // 800KB mock base64 data to test ceiling protection
      const largeBase64 = 'A'.repeat(800 * 1024);
      const sendCommandSpy = vi.spyOn(cdpMod.cdpSessionManager, 'sendCommand').mockResolvedValue({
        data: largeBase64,
        mimeType: 'image/png',
      });

      const nativeHostMod = await import('../entrypoints/background/native-host');
      const ensureSpy = vi.spyOn(nativeHostMod, 'ensureNativeConnected').mockResolvedValue(true);
      let capturedPayloadSize = 0;
      const sendSpy = vi
        .spyOn(nativeHostMod, 'sendFileOperationToNative')
        .mockImplementation((msg: any, cb?: any) => {
          if (msg.type === 'file_operation' && msg.payload.action === 'prepareFile') {
            capturedPayloadSize = (msg.payload.base64Data || '').length;
            setTimeout(() => {
              cb?.({
                payload: {
                  success: true,
                  filePath:
                    'C:\\Users\\User\\AppData\\Local\\Temp\\chrome-mcp-uploads\\phone_results_large.webp',
                },
              });
            }, 5);
            return true;
          }
          return false;
        });

      const res = await screenshotTool.execute({ name: 'phone_results_large', savePng: true });
      expect(res.isError).toBe(false);

      const payload = JSON.parse(res.content[0].text as string);
      expect(payload.fileSaved).toBe(true);
      expect(payload.savedTo).toBe('system_temp');
      expect((chrome as any).downloads.download).not.toHaveBeenCalled();

      withSessionSpy.mockRestore();
      sendCommandSpy.mockRestore();
      sendSpy.mockRestore();
      ensureSpy.mockRestore();
    });
  });

  describe('4. chrome_fill_index 1-Turn Auto-Submit', () => {
    it('executes submit click in the same turn when submit: true is requested and submit button is found', async () => {
      const fillMod = await import('../entrypoints/background/tools/browser/fill-index');
      (fillMod.fillIndexTool as any).resolveAffinityTab = async () => ({
        id: 1,
        url: 'https://example.com/search',
        title: 'Search Page',
      });

      const engineMod = await import('../entrypoints/background/tools/browser/in-page-engine');
      vi.spyOn(engineMod, 'executeInPage').mockResolvedValue([
        {
          frameId: 0,
          result: {
            success: true,
            committed: true,
            submitButtonState: {
              found: true,
              text: '查询',
              index: 18,
            },
          },
        },
      ] as any);

      const interactMod = await import('../entrypoints/background/tools/browser/interact-index');
      const interactSpy = vi.spyOn(interactMod.interactIndexTool, 'execute').mockResolvedValue({
        content: [
          { type: 'text', text: JSON.stringify({ success: true, action: 'click', index: 18 }) },
        ],
        isError: false,
      });

      const res = await fillMod.fillIndexTool.execute({
        index: 15,
        text: '13800138000',
        submit: true,
      });

      expect(res.isError).toBe(false);
      const parsed = JSON.parse(res.content[0].text as string);
      expect(parsed.submitted).toBe(true);
      expect(parsed.submitMethod).toBe('click');
      expect(parsed.submittedButtonIndex).toBe(18);
      expect(interactSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          index: 18,
          action: 'click',
        }),
      );

      vi.restoreAllMocks();
    });
  });
});
