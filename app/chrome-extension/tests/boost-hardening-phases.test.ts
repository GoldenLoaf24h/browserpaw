import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  type BatchActionItem,
  type ReadDOMParams,
  parseUnifiedCoordinate,
} from 'chrome-mcp-shared';
import {
  inPageDOMPruner,
  inPageGetElementCoordinates,
  detectActiveModalBlocker,
  extractElementLocationDetails,
  getIsolatedIndexMap,
} from '../entrypoints/background/tools/browser/dom-indexer';
import { readDOMTool } from '../entrypoints/background/tools/browser/read-dom';
import { batchActionsTool } from '../entrypoints/background/tools/browser/batch-actions';
import { interactIndexTool } from '../entrypoints/background/tools/browser/interact-index';
import * as engine from '../entrypoints/background/tools/browser/in-page-engine';
import {
  isTelemetryUrl,
  startActionNetworkCapture,
  decodeBase64Utf8,
} from '../utils/action-network-capture';
import { cdpSessionManager } from '../utils/cdp-session-manager';

describe('Phase 1: Contract & Assertion Engine Hardening', () => {
  let prevRect: typeof Element.prototype.getBoundingClientRect;

  beforeEach(() => {
    prevRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      return {
        x: 50,
        y: 50,
        left: 50,
        top: 50,
        right: 150,
        bottom: 90,
        width: 100,
        height: 40,
        toJSON: () => ({}),
      } as DOMRect;
    };
    document.body.innerHTML = '';
    getIsolatedIndexMap().clear();
  });

  afterEach(() => {
    Element.prototype.getBoundingClientRect = prevRect;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('extracts rich element states: disabled, ariaDisabled, validity, checked, selected', () => {
    document.body.innerHTML = `
      <div id="container">
        <button id="btn-disabled" disabled>Submit</button>
        <button id="btn-aria-disabled" aria-disabled="true">Save</button>
        <input id="input-required" required value="" />
        <input id="input-checkbox" type="checkbox" checked />
        <div role="listbox">
          <div role="option" id="opt-1" aria-selected="true">One</div>
          <div role="option" id="opt-2" aria-selected="false">Two</div>
        </div>
      </div>
    `;

    // Index the elements
    inPageDOMPruner();

    const btnDisabled = inPageGetElementCoordinates('1');
    expect(btnDisabled.disabled).toBe(true);

    const btnAria = inPageGetElementCoordinates('2');
    expect(btnAria.ariaDisabled).toBe(true);

    const inputReq = inPageGetElementCoordinates('3');
    expect(inputReq.validity).toBeDefined();

    const chk = inPageGetElementCoordinates('4');
    expect(chk.checked).toBe(true);

    const opt = inPageGetElementCoordinates('5');
    expect(opt.selected).toBe(true);

    // Also test native select option via extractElementLocationDetails
    const nativeOpt = document.createElement('option');
    nativeOpt.selected = true;
    const details = extractElementLocationDetails(nativeOpt);
    expect(details.selected).toBe(true);
  });

  it('halts and aborts batch actions when element is occluded and cannot pierce', async () => {
    (batchActionsTool as any).resolveAffinityTab = vi.fn().mockResolvedValue({
      id: 1,
      url: 'https://example.com/app',
    });
    (globalThis as any).chrome = {
      tabs: {
        get: vi.fn().mockResolvedValue({ id: 1, url: 'https://example.com/app' }),
      },
      debugger: {
        sendCommand: vi.fn().mockResolvedValue({}),
        onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    };

    // Mock executeInPage for coordinates resolution and occlusion check
    vi.spyOn(engine, 'executeInPage').mockImplementation(async (_target, fnName) => {
      if (fnName === 'inPageGetElementCoordinates' || fnName === 'inPageWaitForActionable') {
        return [
          {
            result: {
              success: true,
              x: 100,
              y: 100,
              width: 50,
              height: 30,
              tagName: 'button',
            },
          } as any,
        ];
      }
      if (fnName === 'inPageCheckInterception') {
        return [
          {
            result: {
              intercepted: true,
              description: 'div.ant-modal-mask',
              canPierce: false,
            },
          } as any,
        ];
      }
      return [];
    });

    const res = await batchActionsTool.execute({
      tabId: 1,
      actions: [
        {
          type: 'click',
          index: 1,
          pierceOverlay: false,
        },
      ],
    });

    // Must halt and report error
    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text;
    expect(text).toContain('intercepted by div.ant-modal-mask');
  });

  it('supports expanded assert conditions: enabled, disabled, valid, invalid, checked, unchecked, matches', async () => {
    (batchActionsTool as any).resolveAffinityTab = vi.fn().mockResolvedValue({
      id: 1,
      url: 'https://example.com/app',
    });
    (globalThis as any).chrome = {
      tabs: {
        get: vi.fn().mockResolvedValue({ id: 1, url: 'https://example.com/app' }),
      },
    };

    (batchActionsTool as any).safeExecuteScript = vi.fn().mockImplementation(async () => {
      return [
        {
          result: {
            found: true,
            visible: true,
            text: 'ORDER-98765-CONFIRMED',
            value: 'checked-value',
            disabled: false,
            ariaDisabled: false,
            validity: { valid: true },
            invalidReason: '',
            checked: true,
            selected: true,
          },
        },
      ];
    });

    const res = await batchActionsTool.execute({
      tabId: 1,
      actions: [
        {
          type: 'assert',
          selector: '#submit-btn',
          condition: 'enabled',
          abortOnFailure: true,
        },
        {
          type: 'assert',
          selector: '#agree-terms',
          condition: 'checked',
          abortOnFailure: true,
        },
        {
          type: 'assert',
          selector: '#email-input',
          condition: 'valid',
          abortOnFailure: true,
        },
        {
          type: 'assert',
          selector: '#order-number',
          condition: 'matches',
          expectedText: '^ORDER-\\d+-CONFIRMED$',
          abortOnFailure: true,
        },
      ],
    });

    expect(res.isError).toBe(false);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.success).toBe(true);
    expect(parsed.completedActions).toBe(4);
    expect(parsed.assertions.every((a: any) => a.passed)).toBe(true);
  });

  it('recognizes aria-invalid="true" as invalid even when native validity is valid', async () => {
    document.body.innerHTML = `
      <input id="reactive-input" aria-invalid="true" value="invalid-value" />
    `;
    const snapshot = inPageDOMPruner();
    const inputRef = snapshot.indexedElements!.find(
      (el) => el.attributes?.id === 'reactive-input',
    )!.index;
    const coords = inPageGetElementCoordinates(inputRef);
    expect(coords.validity?.valid).toBe(false);
    expect(coords.invalidReason).toBe('aria-invalid');

    (batchActionsTool as any).resolveAffinityTab = vi.fn().mockResolvedValue({
      id: 1,
      url: 'https://example.com/app',
    });
    (globalThis as any).chrome = {
      tabs: {
        get: vi.fn().mockResolvedValue({ id: 1, url: 'https://example.com/app' }),
      },
    };

    (batchActionsTool as any).safeExecuteScript = vi.fn().mockImplementation(async () => {
      return [
        {
          result: {
            found: true,
            visible: true,
            text: 'invalid-value',
            value: 'invalid-value',
            disabled: false,
            ariaDisabled: false,
            validity: { valid: false },
            invalidReason: 'aria-invalid',
            checked: undefined,
            selected: undefined,
          },
        },
      ];
    });

    // Asserting invalid should pass
    const resInvalid = await batchActionsTool.execute({
      tabId: 1,
      actions: [
        {
          type: 'assert',
          selector: '#reactive-input',
          condition: 'invalid',
          abortOnFailure: true,
        },
      ],
    });
    expect(resInvalid.isError).toBe(false);
    const parsedInvalid = JSON.parse((resInvalid.content[0] as any).text);
    expect(parsedInvalid.assertions[0].passed).toBe(true);

    // Asserting valid should fail and abort
    const resValid = await batchActionsTool.execute({
      tabId: 1,
      actions: [
        {
          type: 'assert',
          selector: '#reactive-input',
          condition: 'valid',
          abortOnFailure: true,
        },
      ],
    });
    expect(resValid.isError).toBe(true);
  });
});

describe('Phase 2: Modal Isolation & Selector Hardening', () => {
  let prevRect: typeof Element.prototype.getBoundingClientRect;

  beforeEach(() => {
    prevRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      const el = this as HTMLElement;
      // Provide realistic dimensions for dialogs
      if (el.getAttribute('role') === 'dialog' || el.getAttribute('role') === 'alertdialog') {
        return {
          x: 100,
          y: 100,
          left: 100,
          top: 100,
          right: 700,
          bottom: 500,
          width: 600,
          height: 400,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return {
        x: 10,
        y: 10,
        left: 10,
        top: 10,
        right: 110,
        bottom: 50,
        width: 100,
        height: 40,
        toJSON: () => ({}),
      } as DOMRect;
    };
    document.body.innerHTML = '';
  });

  afterEach(() => {
    Element.prototype.getBoundingClientRect = prevRect;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('accepts scope as an alias for selector in chrome_read_dom', async () => {
    const mockExecuteInPage = vi.spyOn(engine, 'executeInPage').mockResolvedValue([
      {
        result: {
          elementCount: 1,
          selectorMatched: true,
          treeString: '[1] button "Checkout"',
          indexedElements: [],
          indexMap: {},
        } as any,
      } as any,
    ]);

    (readDOMTool as any).resolveAffinityTab = vi.fn().mockResolvedValue({
      id: 1,
      url: 'https://example.com/shop',
    });

    const res = await readDOMTool.execute({
      scope: '#checkout-cart',
    } as any);

    expect(res.isError).toBe(false);
    expect(mockExecuteInPage).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 1 }),
      'inPageDOMPruner',
      [
        expect.objectContaining({
          selector: '#checkout-cart',
          scope: '#checkout-cart',
        }),
      ],
    );
  });

  it('isolates modal content and protects portal dropdowns and toasts when isolateModal is true', () => {
    document.body.innerHTML = `
      <div id="background-page">
        <button id="bg-btn-1">Background Item 1</button>
        <button id="bg-btn-2">Background Item 2</button>
      </div>

      <div role="dialog" id="edit-dialog" aria-modal="true" aria-label="Edit Profile" style="position: fixed; left: 100px; top: 100px; width: 600px; height: 400px;">
        <h2>Edit Profile</h2>
        <input id="input-username" value="Alice" />
        <button id="role-trigger" aria-controls="portal-dropdown" aria-expanded="true">Choose role</button>
        <button id="btn-save">Save Changes</button>
      </div>

      <div class="ant-select-dropdown" id="portal-dropdown">
        <div role="option" id="opt-role-admin">Administrator</div>
      </div>

      <div id="toast-root">
        <div role="alert" id="toast-msg">Success alert</div>
      </div>
    `;

    const res = inPageDOMPruner({ isolateModal: true });

    expect(res.modalIsolated).toBe(true);
    expect(res.focusTrapped).toBe(true);

    const indexedIds = res.indexedElements?.map((e) => e.attributes?.id);
    // Modal buttons must be present
    expect(indexedIds).toContain('input-username');
    expect(indexedIds).toContain('btn-save');

    // A detached portal is present only when an open control inside the modal owns it.
    expect(indexedIds).toContain('opt-role-admin');
    expect(indexedIds).not.toContain('toast-msg');

    // Background elements outside modal must be pruned
    expect(indexedIds).not.toContain('bg-btn-1');
    expect(indexedIds).not.toContain('bg-btn-2');
  });

  it('ranks small confirmation traps higher than large background dialogs using stacking score', () => {
    // Custom rect function for this test to distinguish parent vs child modal
    Element.prototype.getBoundingClientRect = function () {
      const el = this as HTMLElement;
      if (el.id === 'large-background-modal') {
        return {
          x: 50,
          y: 50,
          left: 50,
          top: 50,
          right: 1200,
          bottom: 750,
          width: 1150,
          height: 700,
          toJSON: () => ({}),
        } as DOMRect;
      }
      if (el.id === 'confirmation-trap') {
        return {
          x: 300,
          y: 200,
          left: 300,
          top: 200,
          right: 700,
          bottom: 450,
          width: 400,
          height: 250,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 100,
        bottom: 30,
        width: 100,
        height: 30,
        toJSON: () => ({}),
      } as DOMRect;
    };

    document.body.innerHTML = `
      <div role="dialog" id="large-background-modal" style="position: fixed; width: 90%; height: 90%; z-index: 100;">
        <h2>Settings</h2>
        <button id="btn-save-settings">Save</button>
      </div>
      <div role="alertdialog" class="ant-modal-confirm" id="confirmation-trap" style="position: fixed; width: 30%; height: 20%; z-index: 2000;">
        <p>Discard unsaved changes?</p>
        <button id="btn-confirm-discard">Discard</button>
      </div>
    `;

    const blocker = detectActiveModalBlocker(window);
    expect(blocker).toBeDefined();
    // Must select the confirmation trap because of role="alertdialog" + ant-modal-confirm + higher z-index
    expect(blocker?.el.id).toBe('confirmation-trap');
    expect(blocker?.stackingScore).toBeGreaterThan(500);
  });

  it('preserves scope, modalIsolated, and isConfirmationTrap in chrome_read_dom response payload', async () => {
    vi.spyOn(engine, 'executeInPage').mockResolvedValue([
      {
        result: {
          elementCount: 2,
          interactiveCount: 2,
          selectorMatched: true,
          modalIsolated: true,
          isConfirmationTrap: true,
          activeModal: 'div.confirmation-dialog',
          treeString: '[1] button "Confirm"',
          indexedElements: [],
          indexMap: {},
        } as any,
      } as any,
    ]);

    (readDOMTool as any).resolveAffinityTab = vi.fn().mockResolvedValue({
      id: 1,
      url: 'https://example.com/app',
    });

    const res = await readDOMTool.execute({
      scope: '#modal-container',
      isolateModal: true,
    } as any);

    expect(res.isError).toBe(false);
    const payload = JSON.parse((res.content[0] as any).text);
    expect(payload.selector).toBe('#modal-container');
    expect(payload.scope).toBe('#modal-container');
    expect(payload.selectorMatched).toBe(true);
    expect(payload.modalIsolated).toBe(true);
    expect(payload.isConfirmationTrap).toBe(true);
  });
});

describe('Phase 3: Inline Network Capture & CDP Hardening', () => {
  it('correctly identifies and filters telemetry URLs unless explicitly requested', () => {
    expect(isTelemetryUrl('https://www.google-analytics.com/g/collect', '*/api/order*')).toBe(true);
    expect(isTelemetryUrl('https://o1234.ingest.sentry.io/api/45/envelope/', '*/api/*')).toBe(true);
    expect(isTelemetryUrl('https://ad.doubleclick.net/ddm/adj/N123', '*/api/*')).toBe(true);

    // If user explicitly asks for sentry
    expect(isTelemetryUrl('https://o1234.ingest.sentry.io/api/45/envelope/', '*sentry.io*')).toBe(
      false,
    );

    // Normal business API
    expect(isTelemetryUrl('https://example.com/api/v1/orders/submit', '*/api/*')).toBe(false);
  });

  it('captures inline network response, limits payload size, and masks credentials', async () => {
    let attachedListener: any;
    (globalThis as any).chrome = {
      debugger: {
        sendCommand: vi.fn().mockResolvedValue({}),
        getTargets: vi.fn().mockResolvedValue([{ tabId: 1, attached: true }]),
        attach: vi.fn().mockResolvedValue({}),
        detach: vi.fn().mockResolvedValue({}),
        onEvent: {
          addListener: vi.fn().mockImplementation((fn) => {
            attachedListener = fn;
          }),
          removeListener: vi.fn(),
        },
      },
    };

    const captureHelper = startActionNetworkCapture(1, {
      urlPattern: '*/api/checkout*',
      method: 'POST',
      statusCodes: [200],
      timeoutMs: 1000,
    });

    const sensitivePayload = {
      orderId: 'ORD-999',
      total: 199.99,
      password: 'MySecretPassword123',
      token: 'jwt-header.payload.signature',
      apiKey: 'sk-abcdef1234567890',
    };

    vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(async (_tabId, method) => {
      if (method === 'Network.getResponseBody') {
        return {
          body: JSON.stringify(sensitivePayload),
          base64Encoded: false,
        };
      }
      return {};
    });

    // Simulate Network.requestWillBeSent
    attachedListener({ tabId: 1 }, 'Network.requestWillBeSent', {
      requestId: 'req-order-1',
      request: { method: 'POST' },
    });

    // Simulate Network.responseReceived
    attachedListener({ tabId: 1 }, 'Network.responseReceived', {
      requestId: 'req-order-1',
      response: {
        url: 'https://example.com/api/checkout',
        status: 200,
        mimeType: 'application/json',
      },
    });

    // Simulate Network.loadingFinished
    attachedListener({ tabId: 1 }, 'Network.loadingFinished', {
      requestId: 'req-order-1',
    });

    const netResult = await captureHelper.waitForResult();
    expect(netResult).toBeDefined();
    expect(netResult?.url).toBe('https://example.com/api/checkout');
    expect(netResult?.status).toBe(200);
    expect(netResult?.data.orderId).toBe('ORD-999');

    // Sensitive credentials must be masked
    expect(netResult?.data.password).toBe('<redacted>');
    expect(netResult?.data.token).toBe('<redacted>');
    expect(netResult?.data.apiKey).toBe('<redacted>');
  });

  it('returns captured network result inline on chrome_interact_index', async () => {
    (interactIndexTool as any).resolveAffinityTab = vi.fn().mockResolvedValue({
      id: 1,
      url: 'https://example.com/form',
    });

    let attachedListener: any;
    (globalThis as any).chrome = {
      tabs: {
        get: vi.fn().mockResolvedValue({ id: 1, url: 'https://example.com/form' }),
      },
      debugger: {
        sendCommand: vi.fn().mockResolvedValue({}),
        getTargets: vi.fn().mockResolvedValue([{ tabId: 1, attached: true }]),
        attach: vi.fn().mockResolvedValue({}),
        detach: vi.fn().mockResolvedValue({}),
        onEvent: {
          addListener: vi.fn().mockImplementation((fn) => {
            attachedListener = fn;
          }),
          removeListener: vi.fn(),
        },
      },
    };

    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, _label, fn) =>
      fn(),
    );

    vi.spyOn(engine, 'executeInPage').mockImplementation(async (_target, fnName) => {
      if (fnName === 'inPageGetElementCoordinates' || fnName === 'inPageWaitForActionable') {
        return [
          {
            result: {
              success: true,
              x: 120,
              y: 60,
              width: 80,
              height: 30,
              tagName: 'button',
            },
          } as any,
        ];
      }
      if (fnName === 'inPageCheckInterception') {
        return [{ result: { intercepted: false } } as any];
      }
      return [];
    });

    vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(async (_tabId, method) => {
      if (method === 'Network.getResponseBody') {
        return {
          body: JSON.stringify({ code: 0, message: 'Saved successfully' }),
          base64Encoded: false,
        };
      }
      return {};
    });

    // Execute interact_index with captureNetwork
    const execPromise = interactIndexTool.execute({
      tabId: 1,
      index: 1,
      action: 'click',
      captureNetwork: {
        urlPattern: '*/api/save*',
        timeoutMs: 1000,
      },
    });

    // Simulate response arrival during action
    setTimeout(() => {
      if (attachedListener) {
        attachedListener({ tabId: 1 }, 'Network.responseReceived', {
          requestId: 'req-save-1',
          response: {
            url: 'https://example.com/api/save',
            status: 200,
            mimeType: 'application/json',
          },
        });
        attachedListener({ tabId: 1 }, 'Network.loadingFinished', {
          requestId: 'req-save-1',
        });
      }
    }, 20);

    const res = await execPromise;
    expect(res.isError).toBe(false);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.success).toBe(true);
    expect(parsed.networkResult).toBeDefined();
    expect(parsed.networkResult.url).toBe('https://example.com/api/save');
    expect(parsed.networkResult.data.message).toBe('Saved successfully');
  });

  it('resolves to undefined immediately when disposed without hanging or deadlocking', async () => {
    (globalThis as any).chrome = {
      debugger: {
        sendCommand: vi.fn().mockResolvedValue({}),
        onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    };

    const handle = startActionNetworkCapture(1, {
      urlPattern: '*/api/never*',
      timeoutMs: 10000,
    });

    // Immediately dispose
    handle.dispose();

    const start = Date.now();
    const res = await handle.waitForResult();
    const elapsed = Date.now() - start;

    expect(res).toBeUndefined();
    // Must resolve instantly rather than waiting 10000ms
    const maxElapsedInstantly = process.env.CI ? 1000 : 100;
    expect(elapsed).toBeLessThan(maxElapsedInstantly);
  });

  it('aborts batch actions immediately on failure with captureNetwork without waiting for network timeout', async () => {
    (batchActionsTool as any).resolveAffinityTab = vi.fn().mockResolvedValue({
      id: 1,
      url: 'https://example.com/app',
    });
    (globalThis as any).chrome = {
      tabs: {
        get: vi.fn().mockResolvedValue({ id: 1, url: 'https://example.com/app' }),
      },
      debugger: {
        sendCommand: vi.fn().mockResolvedValue({}),
        onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    };

    // Action will fail because element is not found
    vi.spyOn(engine, 'executeInPage').mockResolvedValue([
      {
        result: { success: false, error: 'Element 999 not found' },
      } as any,
    ]);

    const start = Date.now();
    const res = await batchActionsTool.execute({
      tabId: 1,
      captureNetwork: {
        urlPattern: '*/api/order-never-fires*',
        timeoutMs: 8000,
      },
      actions: [
        {
          type: 'click',
          index: 999,
        },
      ],
    });
    const elapsed = Date.now() - start;

    expect(res.isError).toBe(true);
    // Crucial: Must NOT wait 8000ms for network response when action failed!
    const maxElapsedAborted = process.env.CI ? 2000 : 500;
    expect(elapsed).toBeLessThan(maxElapsedAborted);
  });

  it('correctly scales Gemini 0~1000 per-mille coordinates to viewport', () => {
    // Gemini grounding coordinate [500, 600] on 1280x800 viewport:
    // y = 500 / 1000 * 800 = 400
    // x = 600 / 1000 * 1280 = 768
    const geminiCoord = parseUnifiedCoordinate([500, 600], {
      pointFormat: 'gemini',
      viewportWidth: 1280,
      viewportHeight: 800,
    });
    expect(geminiCoord).toEqual({ x: 768, y: 400 });

    // Explicit yx pixel coordinates [500, 600] without scale:
    const yxPixelCoord = parseUnifiedCoordinate([500, 600], {
      pointFormat: 'yx',
      scale: 'pixel',
      viewportWidth: 1280,
      viewportHeight: 800,
    });
    expect(yxPixelCoord).toEqual({ x: 600, y: 500 });
  });
});
