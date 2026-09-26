import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  querySelectorAllDeep,
  querySelectorDeep,
  splitSelectorSafely,
  splitByCharacterUnlessQuoted,
  parentElementOrShadowHost,
} from '../entrypoints/background/tools/browser/dom-indexer';
import { BaseBrowserToolExecutor } from '../entrypoints/background/tools/base-browser';
import {
  isShowingErrorPageError,
  executeInPage,
} from '../entrypoints/background/tools/browser/in-page-engine';
import { ReadDOMTool } from '../entrypoints/background/tools/browser/read-dom';

// Concrete subclass of BaseBrowserToolExecutor for testing protected methods
class TestBrowserTool extends BaseBrowserToolExecutor {
  name = 'test_browser_tool';
  async execute() {
    return { content: [], isError: false };
  }
  public async testGetActiveTabOrThrow() {
    return this.getActiveTabOrThrow();
  }
  public async testGetActiveTabInWindow(windowId?: number) {
    return this.getActiveTabInWindow(windowId);
  }
}

describe('BrowserPaw Shadow DOM & Core Resilience Architectural Upgrade (Plan 2)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  describe('Module 1: Shadow DOM Cross-Root Composite Selector Engine', () => {
    it('preserves spaces inside attribute selectors with single and double quotes', () => {
      const doubleQuoted = splitSelectorSafely('textarea[placeholder="Body text*"]');
      expect(doubleQuoted).toEqual(['textarea[placeholder="Body text*"]']);

      const singleQuoted = splitSelectorSafely("textarea[placeholder='Body text*']");
      expect(singleQuoted).toEqual(["textarea[placeholder='Body text*']"]);

      const complexAttr = splitSelectorSafely('input[data-msg="Hello world, how are you?"]');
      expect(complexAttr).toEqual(['input[data-msg="Hello world, how are you?"]']);
    });

    it('protects spaces around operator inside attribute brackets without breaking into fragments', () => {
      expect(splitSelectorSafely('textarea[placeholder = "Body text*"]')).toEqual([
        'textarea[placeholder = "Body text*"]',
      ]);
      expect(splitSelectorSafely('input[name = "username"]')).toEqual(['input[name = "username"]']);
      expect(splitSelectorSafely('input[data-val = 123]')).toEqual(['input[data-val = 123]']);
    });

    it('protects spaces and commas inside functional pseudo-classes like :is, :not, :has', () => {
      expect(splitSelectorSafely(':is(div, span) textarea')).toEqual([
        ':is(div, span)',
        'textarea',
      ]);
      expect(splitSelectorSafely(':not(.btn, .link) textarea')).toEqual([
        ':not(.btn, .link)',
        'textarea',
      ]);
      expect(
        splitSelectorSafely(
          ':not([data-open]) shreddit-markdown-composer >> textarea[placeholder="Body text*"]',
        ),
      ).toEqual([
        ':not([data-open])',
        'shreddit-markdown-composer',
        'textarea[placeholder="Body text*"]',
      ]);
    });

    it('treats newlines and tabs as whitespace descendant combinators outside quotes', () => {
      expect(splitSelectorSafely('shreddit-markdown-composer\n  textarea')).toEqual([
        'shreddit-markdown-composer',
        'textarea',
      ]);
      expect(splitSelectorSafely('custom-host\t#inner-btn')).toEqual(['custom-host', '#inner-btn']);
    });

    it('folds whitespace around standard CSS combinators >, +, ~', () => {
      expect(splitSelectorSafely('div > span')).toEqual(['div>span']);
      expect(splitSelectorSafely('div + span')).toEqual(['div+span']);
      expect(splitSelectorSafely('div ~ span')).toEqual(['div~span']);
      expect(splitSelectorSafely('form > div.row + div.row textarea')).toEqual([
        'form>div.row+div.row',
        'textarea',
      ]);
    });

    it('supports Playwright >>, shadow >>>, and /deep/ explicit piercing combinators', () => {
      expect(splitSelectorSafely('custom-host >> #inner-btn')).toEqual([
        'custom-host',
        '#inner-btn',
      ]);
      expect(splitSelectorSafely('custom-host >>> #inner-btn')).toEqual([
        'custom-host',
        '#inner-btn',
      ]);
      expect(splitSelectorSafely('custom-host /deep/ #inner-btn')).toEqual([
        'custom-host',
        '#inner-btn',
      ]);
    });

    it('matches composite descendant selector across Shadow DOM boundaries (shreddit-markdown-composer textarea)', () => {
      const composer = document.createElement('shreddit-markdown-composer');
      document.body.appendChild(composer);

      const shadow = composer.attachShadow({ mode: 'open' });
      const container = document.createElement('div');
      container.className = 'editor-wrapper';
      const textarea = document.createElement('textarea');
      textarea.setAttribute('placeholder', 'Body text*');
      container.appendChild(textarea);
      shadow.appendChild(container);

      // Space descendant piercing
      const matched = querySelectorDeep('shreddit-markdown-composer textarea', document);
      expect(matched).toBe(textarea);

      // Explicit Playwright piercing
      const matchedPlaywright = querySelectorDeep(
        'shreddit-markdown-composer >> textarea',
        document,
      );
      expect(matchedPlaywright).toBe(textarea);

      // Precision attribute match with quotes and space
      const matchedAttr = querySelectorDeep('textarea[placeholder="Body text*"]', document);
      expect(matchedAttr).toBe(textarea);

      // Attribute match with spaces around =
      const matchedAttrSpaced = querySelectorDeep('textarea[placeholder = "Body text*"]', document);
      expect(matchedAttrSpaced).toBe(textarea);
    });

    it('correctly splits comma-separated selectors containing pseudo-classes with internal commas', () => {
      const composer = document.createElement('shreddit-markdown-composer');
      document.body.appendChild(composer);
      const shadow = composer.attachShadow({ mode: 'open' });
      const textarea = document.createElement('textarea');
      shadow.appendChild(textarea);

      const btn = document.createElement('button');
      document.body.appendChild(btn);

      const results = querySelectorAllDeep(
        ':is(shreddit-markdown-composer) textarea, button',
        document,
      );
      expect(results).toContain(textarea);
      expect(results).toContain(btn);
    });

    it('walks upward across shadow boundaries using parentElementOrShadowHost', () => {
      const host = document.createElement('custom-container');
      document.body.appendChild(host);

      const shadow = host.attachShadow({ mode: 'open' });
      const child = document.createElement('button');
      shadow.appendChild(child);

      expect(parentElementOrShadowHost(child)).toBe(host);
      expect(parentElementOrShadowHost(host)).toBe(document.body);
    });
  });

  describe('Module 2-B: Three-Tier Tab Fallback in getActiveTabOrThrow and getActiveTabInWindow', () => {
    it('picks lastFocusedWindow active tab when available', async () => {
      const mockTab = { id: 101, windowId: 1, active: true };
      const queryMock = vi.fn().mockImplementation(async (queryInfo: any) => {
        if (queryInfo.lastFocusedWindow && queryInfo.active) {
          return [mockTab];
        }
        return [];
      });
      (globalThis as any).chrome = {
        tabs: { query: queryMock },
      };

      const tool = new TestBrowserTool();
      const tab = await tool.testGetActiveTabOrThrow();
      expect(tab).toEqual(mockTab);
      expect(queryMock).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
    });

    it('falls back to currentWindow when lastFocusedWindow returns empty', async () => {
      const mockTab = { id: 102, windowId: 2, active: true };
      const queryMock = vi.fn().mockImplementation(async (queryInfo: any) => {
        if (queryInfo.lastFocusedWindow && queryInfo.active) {
          return [];
        }
        if (queryInfo.currentWindow && queryInfo.active) {
          return [mockTab];
        }
        return [];
      });
      (globalThis as any).chrome = {
        tabs: { query: queryMock },
      };

      const tool = new TestBrowserTool();
      const tab = await tool.testGetActiveTabOrThrow();
      expect(tab).toEqual(mockTab);
      expect(queryMock).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
      expect(queryMock).toHaveBeenCalledWith({ active: true, currentWindow: true });
    });

    it('falls back to any active tab when both lastFocusedWindow and currentWindow return empty (background silent)', async () => {
      const mockTab = { id: 103, windowId: 3, active: true };
      const queryMock = vi.fn().mockImplementation(async (queryInfo: any) => {
        if (queryInfo.lastFocusedWindow || queryInfo.currentWindow) {
          return [];
        }
        if (queryInfo.active && Object.keys(queryInfo).length === 1) {
          return [mockTab];
        }
        return [];
      });
      (globalThis as any).chrome = {
        tabs: { query: queryMock },
      };

      const tool = new TestBrowserTool();
      const tab = await tool.testGetActiveTabOrThrow();
      expect(tab).toEqual(mockTab);

      // Also verify getActiveTabInWindow() has the same 3-tier fallback for resolveAffinityTab tools
      const tabInWindow = await tool.testGetActiveTabInWindow();
      expect(tabInWindow).toEqual(mockTab);
    });

    it('throws Active tab not found when all tiers return empty', async () => {
      const queryMock = vi.fn().mockResolvedValue([]);
      (globalThis as any).chrome = {
        tabs: { query: queryMock },
      };

      const tool = new TestBrowserTool();
      await expect(tool.testGetActiveTabOrThrow()).rejects.toThrow('Active tab not found');
    });
  });

  describe('Module 3: Native Error Page Interception & Degradation', () => {
    it('identifies Chrome error page exceptions accurately', () => {
      expect(isShowingErrorPageError(new Error('Frame with ID 0 is showing error page'))).toBe(
        true,
      );
      expect(isShowingErrorPageError('Error: frame is showing error page')).toBe(true);
      expect(isShowingErrorPageError(new Error('Cannot access a chrome:// URL'))).toBe(false);
      expect(isShowingErrorPageError(new Error('Element not found'))).toBe(false);
    });

    it('returns structured degraded result from executeInPage without throwing when on error page', async () => {
      (globalThis as any).chrome = {
        tabs: {
          get: vi.fn().mockResolvedValue({ id: 1, url: 'chrome-error://chromewebdata/' }),
        },
        scripting: {
          executeScript: vi
            .fn()
            .mockRejectedValue(new Error('Frame with ID 0 is showing error page')),
        },
      };

      const res = await executeInPage({ tabId: 1 }, 'inPageDOMPruner', []);
      expect(res).toBeDefined();
      expect(Array.isArray(res)).toBe(true);
      expect(res.length).toBe(1);
      const first = res[0];
      expect((first.result as any).isErrorPage).toBe(true);
      expect((first.result as any).success).toBe(false);
      expect((first.result as any).error).toContain('Frame with ID 0 is showing error page');
    });

    it('read-dom surfaces friendly network error card and does not crash agent pipeline', async () => {
      (globalThis as any).chrome = {
        tabs: {
          get: vi.fn().mockResolvedValue({ id: 99, url: 'chrome-error://chromewebdata/' }),
          query: vi
            .fn()
            .mockResolvedValue([{ id: 99, url: 'chrome-error://chromewebdata/', active: true }]),
        },
        scripting: {
          executeScript: vi
            .fn()
            .mockRejectedValue(new Error('Frame with ID 0 is showing error page')),
        },
      };

      const tool = new ReadDOMTool();
      const res = await tool.execute({ tabId: 99 });
      expect(res.isError).toBe(false);
      expect(res.content).toBeDefined();
      const text = res.content[0].text;
      expect(text).toContain('Browser Navigation / Network Error');
      expect(text).toContain('chrome-error://chromewebdata/');
      expect(text).toContain('browserpaw_navigate');
    });
  });
});
