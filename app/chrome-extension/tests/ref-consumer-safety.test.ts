import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { inPageWaitForDOMSettle } from '../utils/action-watchdog';
import { fileUploadTool } from '../entrypoints/background/tools/browser/file-upload';
import { cdpSessionManager } from '../utils/cdp-session-manager';

describe('Ref Consumer Safety & Fail-Closed Guardrails', () => {
  const ISOLATED_MAP_KEY = Symbol.for('__browser_use_isolated_index_map__');

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as any)[ISOLATED_MAP_KEY] = new Map<number, any>();
    (globalThis as any).chrome = {
      scripting: {
        executeScript: vi.fn(async ({ func, args }: any) => {
          const result = func(...args);
          return [{ result }];
        }),
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    delete (globalThis as any)[ISOLATED_MAP_KEY];
  });

  describe('action-watchdog: inPageWaitForDOMSettle', () => {
    beforeEach(() => {
      vi.useFakeTimers({
        toFake: [
          'setTimeout',
          'clearTimeout',
          'requestAnimationFrame',
          'cancelAnimationFrame',
          'performance',
        ],
      });
    });
    afterEach(() => vi.useRealTimers());

    async function settle(options: Parameters<typeof inPageWaitForDOMSettle>[0]) {
      const pending = inPageWaitForDOMSettle(options);
      await vi.runAllTimersAsync();
      return pending;
    }

    it('dereferences WeakRef without throwing TypeError and identifies combobox options', async () => {
      const input = document.createElement('input');
      input.setAttribute('role', 'combobox');
      input.setAttribute('aria-autocomplete', 'list');
      input.setAttribute('aria-controls', 'test-options');
      document.body.appendChild(input);

      const listbox = document.createElement('div');
      listbox.id = 'test-options';
      listbox.setAttribute('role', 'listbox');
      document.body.appendChild(listbox);

      const option = document.createElement('div');
      option.setAttribute('role', 'option');
      option.getBoundingClientRect = () =>
        ({
          x: 10,
          y: 50,
          width: 100,
          height: 30,
          top: 50,
          left: 10,
          right: 110,
          bottom: 80,
        }) as DOMRect;
      (option as any).checkVisibility = () => true;
      listbox.appendChild(option);

      const map: Map<number, any> = (globalThis as any)[ISOLATED_MAP_KEY];
      map.set(10, new WeakRef(input));

      // In legacy code, isolatedMap.get(10) was treated as Element directly, throwing
      // TypeError: field.getAttribute is not a function when invoking getAttribute on WeakRef.
      // Here it must safely deref, read attributes, and complete autocomplete settling.
      const result = await settle({
        timeoutMs: 150,
        quietPeriodMs: 30,
        action: {
          kind: 'fill',
          node: 10,
        },
      });

      expect(result.settled).toBe(true);
      expect(result.autocompleteSettled).toBe(true);
    });

    it('resolves numeric, eN, and ref_N node formats through isolatedMap WeakRef', async () => {
      const map: Map<number, any> = (globalThis as any)[ISOLATED_MAP_KEY];

      const btn1 = document.createElement('button');
      document.body.appendChild(btn1);
      map.set(1, new WeakRef(btn1));

      const btn2 = document.createElement('button');
      document.body.appendChild(btn2);
      map.set(2, new WeakRef(btn2));

      const btn3 = document.createElement('button');
      document.body.appendChild(btn3);
      map.set(3, new WeakRef(btn3));

      const probes = [btn1, btn2, btn3].map((button) => vi.spyOn(button, 'getAttribute'));

      const res1 = await settle({
        timeoutMs: 50,
        quietPeriodMs: 10,
        action: { kind: 'click', node: 1 },
      });
      expect(res1.settled).toBe(true);

      const res2 = await settle({
        timeoutMs: 50,
        quietPeriodMs: 10,
        action: { kind: 'click', node: 'e2' },
      });
      expect(res2.settled).toBe(true);

      const res3 = await settle({
        timeoutMs: 50,
        quietPeriodMs: 10,
        action: { kind: 'click', node: 'ref_3' },
      });
      expect(res3.settled).toBe(true);
      for (const probe of probes) expect(probe).toHaveBeenCalledWith('role');
    });

    it('rejects fake data-mcp-idx attribute and does not resolve forged element', async () => {
      // Host DOM has an element attempting to forge index 42 via attribute
      const forged = document.createElement('input');
      forged.setAttribute('data-mcp-idx', '42');
      forged.setAttribute('role', 'combobox');
      document.body.appendChild(forged);

      // isolatedMap DOES NOT have 42
      const map: Map<number, any> = (globalThis as any)[ISOLATED_MAP_KEY];
      expect(map.has(42)).toBe(false);

      // Watchdog must not pick up forged element (field remains null)
      const result = await settle({
        timeoutMs: 50,
        quietPeriodMs: 10,
        action: { kind: 'click', node: 42 },
      });

      expect(result.settled).toBe(true);
      expect(result.autocompleteSettled).toBe(false);
    });

    it('rejects stale / detached element in WeakRef and treats field as null', async () => {
      const detached = document.createElement('input');
      detached.setAttribute('role', 'combobox');
      // NOT added to document.body (isConnected is false)

      const map: Map<number, any> = (globalThis as any)[ISOLATED_MAP_KEY];
      map.set(5, new WeakRef(detached));

      const result = await settle({
        timeoutMs: 50,
        quietPeriodMs: 10,
        action: { kind: 'click', node: 5 },
      });

      expect(result.settled).toBe(true);
      expect(result.autocompleteSettled).toBe(false);
    });
  });

  describe('file-upload: uploadViaDataTransfer fail-closed behavior', () => {
    it('resolves valid WeakRef from isolatedMap and sets files on targeted input', async () => {
      const targetInput = document.createElement('input');
      targetInput.type = 'file';
      targetInput.id = 'target-input';
      document.body.appendChild(targetInput);

      let changeFired = false;
      targetInput.addEventListener('change', () => {
        changeFired = true;
      });

      const map: Map<number, any> = (globalThis as any)[ISOLATED_MAP_KEY];
      map.set(7, new WeakRef(targetInput));

      const res = await fileUploadTool.uploadViaDataTransfer(1, {
        index: 7,
        files: [{ name: 'invoice.pdf', content: 'test-invoice-data' }],
      });

      expect(res.success).toBe(true);
      expect(res.fileCount).toBe(1);
      expect(changeFired).toBe(true);
      expect(targetInput.files?.length).toBe(1);
      expect(targetInput.files?.[0].name).toBe('invoice.pdf');
    });

    it('supports string ref formats eN and ref_N when resolving WeakRef', async () => {
      const inputA = document.createElement('input');
      inputA.type = 'file';
      document.body.appendChild(inputA);

      const inputB = document.createElement('input');
      inputB.type = 'file';
      document.body.appendChild(inputB);

      const map: Map<number, any> = (globalThis as any)[ISOLATED_MAP_KEY];
      map.set(8, new WeakRef(inputA));
      map.set(9, new WeakRef(inputB));

      const resA = await fileUploadTool.uploadViaDataTransfer(1, {
        index: 'e8',
        files: [{ name: 'a.txt', content: 'a' }],
      });
      expect(resA.success).toBe(true);
      expect(inputA.files?.[0].name).toBe('a.txt');

      const resB = await fileUploadTool.uploadViaDataTransfer(1, {
        index: 'ref_9',
        files: [{ name: 'b.txt', content: 'b' }],
      });
      expect(resB.success).toBe(true);
      expect(inputB.files?.[0].name).toBe('b.txt');
    });

    it('refuses fake data-mcp-idx attribute and NEVER uploads to other page inputs', async () => {
      // Fake element on page with fake attribute
      const fakeInput = document.createElement('input');
      fakeInput.type = 'file';
      fakeInput.id = 'fake-attribute-input';
      fakeInput.setAttribute('data-mcp-idx', '77');
      document.body.appendChild(fakeInput);

      // Innocent file input that existed previously
      const innocentInput = document.createElement('input');
      innocentInput.type = 'file';
      innocentInput.id = 'innocent-input';
      document.body.appendChild(innocentInput);

      // Index 77 is NOT in isolatedMap
      const res = await fileUploadTool.uploadViaDataTransfer(1, {
        index: 77,
        files: [{ name: 'sensitive.txt', content: 'secret' }],
      });

      // Must fail closed
      expect(res.success).toBe(false);
      expect(res.error).toContain('Element with index [77] not found or expired');

      // NEITHER input should have files attached
      expect(fakeInput.files?.length || 0).toBe(0);
      expect(innocentInput.files?.length || 0).toBe(0);
    });

    it('refuses stale / detached WeakRef and NEVER uploads to other page inputs', async () => {
      const detachedInput = document.createElement('input');
      detachedInput.type = 'file';
      detachedInput.id = 'detached-input';
      // Not connected to DOM

      const map: Map<number, any> = (globalThis as any)[ISOLATED_MAP_KEY];
      map.set(88, new WeakRef(detachedInput));

      const pageInput = document.createElement('input');
      pageInput.type = 'file';
      pageInput.id = 'first-page-input';
      document.body.appendChild(pageInput);

      const res = await fileUploadTool.uploadViaDataTransfer(1, {
        index: 88,
        files: [{ name: 'payload.bin', content: 'binary' }],
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain('Element with index [88] not found or expired');
      // Must not fall back to first input on page
      expect(pageInput.files?.length || 0).toBe(0);
    });

    it('refuses unknown selector and NEVER uploads to existing file inputs', async () => {
      const existingInput = document.createElement('input');
      existingInput.type = 'file';
      existingInput.id = 'existing-file-input';
      document.body.appendChild(existingInput);

      const res = await fileUploadTool.uploadViaDataTransfer(1, {
        selector: '#non-existent-selector',
        files: [{ name: 'file.txt', content: 'test' }],
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain('Element with selector "#non-existent-selector" not found');
      expect(existingInput.files?.length || 0).toBe(0);
    });

    it('allows discovering default file input ONLY when NO target was specified', async () => {
      const defaultInput = document.createElement('input');
      defaultInput.type = 'file';
      defaultInput.id = 'default-page-input';
      document.body.appendChild(defaultInput);

      const res = await fileUploadTool.uploadViaDataTransfer(1, {
        files: [{ name: 'default.txt', content: 'hello' }],
      });

      expect(res.success).toBe(true);
      expect(res.fileCount).toBe(1);
      expect(defaultInput.files?.length).toBe(1);
      expect(defaultInput.files?.[0].name).toBe('default.txt');
    });

    it('refuses wrapper element that contains no file input without leaking to other inputs', async () => {
      const emptyContainer = document.createElement('div');
      emptyContainer.id = 'not-an-upload-container';
      document.body.appendChild(emptyContainer);

      const unrelatedInput = document.createElement('input');
      unrelatedInput.type = 'file';
      unrelatedInput.id = 'unrelated-input';
      document.body.appendChild(unrelatedInput);

      const map: Map<number, any> = (globalThis as any)[ISOLATED_MAP_KEY];
      map.set(12, new WeakRef(emptyContainer));

      const res = await fileUploadTool.uploadViaDataTransfer(1, {
        index: 12,
        files: [{ name: 'fail.txt', content: 'data' }],
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain('Target element <DIV> is not an input[type="file"]');
      expect(unrelatedInput.files?.length || 0).toBe(0);
    });

    it('refuses input element whose type is not file', async () => {
      const textInput = document.createElement('input');
      textInput.type = 'text';
      textInput.id = 'text-input';
      document.body.appendChild(textInput);

      const res = await fileUploadTool.uploadViaDataTransfer(1, {
        selector: '#text-input',
        files: [{ name: 'payload.txt', content: 'test content' }],
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain('Target element <INPUT> is not an input[type="file"]');
      expect(textInput.files?.length || 0).toBe(0);
    });

    it('refuses synthesizing files without base64 or content bytes', async () => {
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      document.body.appendChild(fileInput);

      const res = await fileUploadTool.uploadViaDataTransfer(1, {
        files: [{ name: 'empty-fallback.bin' }],
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain('Cannot synthesize file without base64 or content bytes');
      expect(fileInput.files?.length || 0).toBe(0);
    });
  });

  describe('fileUploadTool.execute end-to-end fail-closed flow', () => {
    it('fails closed when explicit index resolution fails in CDP and DataTransfer fallback', async () => {
      const pageFileInput = document.createElement('input');
      pageFileInput.type = 'file';
      document.body.appendChild(pageFileInput);

      vi.spyOn(fileUploadTool as any, 'resolveAffinityTab').mockResolvedValue({ id: 10 });
      vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tab, _owner, fn) => {
        return fn();
      });
      vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(async (_tab, method) => {
        if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
        if (method === 'DOM.querySelector') return { nodeId: 0 };
        return {};
      });

      // safeExecuteScript fails to find index 999 in isolatedMap
      vi.spyOn(fileUploadTool as any, 'safeExecuteScript').mockResolvedValue([{ result: false }]);

      const res = await fileUploadTool.execute({
        tabId: 10,
        index: 999,
        filePath: 'test-file.txt',
      });

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Element with index [999] not found or expired');
      // page file input must remain untouched
      expect(pageFileInput.files?.length || 0).toBe(0);
    });

    it('fails closed when explicit selector resolution fails without matching first input', async () => {
      const pageFileInput = document.createElement('input');
      pageFileInput.type = 'file';
      document.body.appendChild(pageFileInput);

      vi.spyOn(fileUploadTool as any, 'resolveAffinityTab').mockResolvedValue({ id: 10 });
      vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tab, _owner, fn) => {
        return fn();
      });
      vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(async (_tab, method) => {
        if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
        if (method === 'DOM.querySelector') return { nodeId: 0 };
        return {};
      });

      const res = await fileUploadTool.execute({
        tabId: 10,
        selector: '#non-existent-form-upload',
        filePath: 'test-file.txt',
      });

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain(
        'Element with selector "#non-existent-form-upload" not found',
      );
      expect(pageFileInput.files?.length || 0).toBe(0);
    });

    it('rejects fallback to empty DataTransfer files when CDP fails for filePath', async () => {
      const realFileInput = document.createElement('input');
      realFileInput.type = 'file';
      realFileInput.id = 'real-file-input';
      document.body.appendChild(realFileInput);

      vi.spyOn(fileUploadTool as any, 'resolveAffinityTab').mockResolvedValue({ id: 10 });
      vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async () => {
        throw new Error('CDP session crashed during upload');
      });
      const dtSpy = vi.spyOn(fileUploadTool, 'uploadViaDataTransfer');

      const res = await fileUploadTool.execute({
        tabId: 10,
        selector: '#real-file-input',
        filePath: '/workspace/important-document.pdf',
      });

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('CDP session crashed during upload');
      expect(dtSpy).not.toHaveBeenCalled();
      expect(realFileInput.files?.length || 0).toBe(0);
    });

    it('rejects target INPUT when type is not file under CDP mode', async () => {
      const textInput = document.createElement('input');
      textInput.type = 'text';
      textInput.id = 'username-field';
      document.body.appendChild(textInput);

      vi.spyOn(fileUploadTool as any, 'resolveAffinityTab').mockResolvedValue({ id: 10 });
      vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tab, _owner, fn) => {
        return fn();
      });
      vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(async (_tab, method) => {
        if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
        if (method === 'DOM.querySelector') return { nodeId: 2 };
        if (method === 'DOM.describeNode') {
          return {
            node: {
              nodeName: 'INPUT',
              attributes: ['type', 'text', 'id', 'username-field'],
            },
          };
        }
        return {};
      });

      const res = await fileUploadTool.execute({
        tabId: 10,
        selector: '#username-field',
        filePath: '/workspace/doc.pdf',
      });

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Target element <INPUT> is not an input[type="file"]');
      expect(textInput.files?.length || 0).toBe(0);
    });

    it('does not replay upload via DataTransfer when event dispatch fails after file is set', async () => {
      vi.spyOn(fileUploadTool as any, 'resolveAffinityTab').mockResolvedValue({ id: 10 });
      vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tab, _owner, fn) => {
        return fn();
      });

      let setFileInputFilesCalled = false;
      vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(async (_tab, method) => {
        if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
        if (method === 'DOM.querySelector') return { nodeId: 2 };
        if (method === 'DOM.describeNode') {
          return {
            node: {
              nodeName: 'INPUT',
              attributes: ['type', 'file', 'id', 'valid-input'],
            },
          };
        }
        if (method === 'DOM.setFileInputFiles') {
          setFileInputFilesCalled = true;
          return {};
        }
        if (method === 'DOM.resolveNode') {
          throw new Error('resolveNode failed: node disconnected');
        }
        return {};
      });

      const dtSpy = vi.spyOn(fileUploadTool, 'uploadViaDataTransfer');

      const res = await fileUploadTool.execute({
        tabId: 10,
        selector: '#valid-input',
        filePath: '/workspace/doc.pdf',
      });

      expect(setFileInputFilesCalled).toBe(true);
      expect(res.isError).toBe(false);
      expect(dtSpy).not.toHaveBeenCalled();
    });
  });
});
