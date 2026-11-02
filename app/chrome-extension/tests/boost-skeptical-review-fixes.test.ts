import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  cleanPageTitle,
  extractBrandFromUrl,
  deriveSmartGroupTitle,
  TabGroupManager,
  tabGroupManager,
} from '../entrypoints/background/tools/browser/tab-group-manager';
import {
  scoreCandidate,
  matchSemantically,
  heuristicSemanticMatch,
  tokenizeText,
} from '../utils/form-semantic-matcher';
import * as fillCore from '../entrypoints/background/tools/browser/fill-core';
import { fillIndexTool } from '../entrypoints/background/tools/browser/fill-index';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import * as nativeHost from '../entrypoints/background/native-host';
import * as frameCoordinates from '../utils/frame-coordinates';

describe('Boost Skeptical Review Hardening: Tab Titles, Form Semantic Matcher & Physical Fill', () => {
  beforeEach(() => {
    tabGroupManager.resetForTest();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Tab Title Cleaning & Universal Brand Extraction
  // =========================================================================
  describe('1. Tab Title Cleaning & Universal Brand Extraction', () => {
    it('preserves hyphens in English terms and words without premature truncation', () => {
      // Must NOT truncate at hyphens within words
      expect(cleanPageTitle('COVID-19 Dashboard')).toBe('COVID-19 Dashboard');
      expect(cleanPageTitle('Top 10 E-Commerce Platforms - Forbes')).toBe(
        'Top 10 E-Commerce Platforms',
      );
      expect(cleanPageTitle('Wi-Fi 6 vs Wi-Fi 6E | TechRadar')).toBe('Wi-Fi 6 vs Wi-Fi 6E');
      expect(cleanPageTitle('Pre-orders now live - GameSpot')).toBe('Pre-orders now live');
    });

    it('correctly splits structural delimiters with surrounding spaces or CJK markers', () => {
      expect(cleanPageTitle('京东(JD.COM)-正品低价、品质保障')).toBe('京东(JD.COM)');
      expect(cleanPageTitle('汽车之家-懂车更懂你')).toBe('汽车之家');
      expect(cleanPageTitle('商品详情_淘宝网')).toBe('商品详情');
      expect(cleanPageTitle('新闻头条 · 新华网')).toBe('新闻头条');
      expect(cleanPageTitle('Google Docs — Spreadsheet')).toBe('Google Docs');
      expect(cleanPageTitle('Dashboard // Internal Tools')).toBe('Dashboard');
    });

    it('rejects raw URLs and dummy titles, deferring to brand extraction', () => {
      expect(cleanPageTitle('https://github.com/foo/bar')).toBe('');
      expect(cleanPageTitle('http://localhost:3000/app')).toBe('');
      expect(cleanPageTitle('New Tab')).toBe('');
      expect(cleanPageTitle('新标签页')).toBe('');
      expect(cleanPageTitle('about:blank')).toBe('');
      expect(cleanPageTitle('Untitled')).toBe('');
    });

    it('extracts clean capitalized brand names from hostnames without single-digit IP leaks', () => {
      // Domain brands
      expect(extractBrandFromUrl('https://github.com/microsoft/vscode')).toBe('Github');
      expect(extractBrandFromUrl('https://item.jd.com/10001234.html')).toBe('Jd');
      expect(extractBrandFromUrl('https://docs.aws.amazon.com/s3/')).toBe('Amazon');
      expect(extractBrandFromUrl('https://www.bbc.co.uk/news')).toBe('Bbc');
      expect(extractBrandFromUrl('https://news.ycombinator.com/')).toBe('Ycombinator');

      // Localhost & IPs (must NOT return "1" for 192.168.1.1)
      expect(extractBrandFromUrl('http://192.168.1.1:8080/admin')).toBe('192.168.1.1');
      expect(extractBrandFromUrl('http://10.0.0.5/api')).toBe('10.0.0.5');
      expect(extractBrandFromUrl('http://localhost:5173/')).toBe('Localhost');
      expect(extractBrandFromUrl('http://127.0.0.1:8000/')).toBe('Localhost');
    });

    it('derives smart group titles dynamically with fallback hierarchy', () => {
      // Step 1: Meaningful title
      expect(
        deriveSmartGroupTitle({
          title: 'React 19 Release Notes - React Blog',
          url: 'https://react.dev',
        }),
      ).toBe('React 19 Release Notes');

      // Step 2: URL hostname brand when title is raw URL or blank
      expect(
        deriveSmartGroupTitle({
          title: 'https://github.com/microsoft/typescript',
          url: 'https://github.com/microsoft/typescript',
        }),
      ).toBe('Github');

      // Step 3: Default title when no informative title or domain
      expect(deriveSmartGroupTitle({ title: 'about:blank', url: 'about:blank' })).toBe(
        TabGroupManager.DEFAULT_TITLE,
      );
    });

    it('rehydrates managed groups from chrome.storage.session in MV3 service worker', async () => {
      const mockStorageData = {
        tab_group_manager_managed_groups: [42, 99],
        tab_group_manager_explicit_titles: [
          [42, 'Taobao Search'],
          [99, 'Github PRs'],
        ],
      };

      (globalThis as any).chrome = {
        storage: {
          session: {
            get: vi.fn().mockResolvedValue(mockStorageData),
            set: vi.fn().mockResolvedValue(undefined),
          },
        },
        tabGroups: {
          get: vi.fn().mockImplementation(async (gid: number) => ({
            id: gid,
            title: gid === 42 ? 'Taobao Search' : 'Github PRs',
            windowId: 1,
          })),
        },
      };

      const mgr = new TabGroupManager();
      const isManaged42 = await mgr.isManagedGroup(42);
      const isManaged99 = await mgr.isManagedGroup(99);
      const isManaged100 = await mgr.isManagedGroup(100);

      expect(isManaged42).toBe(true);
      expect(isManaged99).toBe(true);
      expect(isManaged100).toBe(false);
      expect(mgr.getManagedGroupIds()).toEqual([42, 99]);
    });
  });

  // =========================================================================
  // 2. Form Semantic Matcher: Zero Substring Collisions
  // =========================================================================
  describe('2. Form Semantic Matcher: Zero Substring Collisions', () => {
    it('does NOT collide on substring matches in scoreCandidate', () => {
      // "no" must not match "Phone Number"
      expect(scoreCandidate('no', 'Phone Number')).toBe(0);

      // "male" must not match "Female"
      expect(scoreCandidate('male', 'Female')).toBe(0);

      // "city" must not match "Electricity"
      expect(scoreCandidate('city', 'Electricity')).toBe(0);

      // "man" must not match "Command Center"
      expect(scoreCandidate('man', 'Command Center')).toBe(0);
    });

    it('scores exact token matches and synonyms with high confidence', () => {
      // Whole-token match
      expect(scoreCandidate('phone', 'Mobile Phone')).toBe(0.95);
      expect(scoreCandidate('no', 'Please select: No')).toBe(0.95);

      // Synonym category match
      expect(scoreCandidate('手机号', 'phone')).toBe(0.9);
      expect(scoreCandidate('确认', 'yes')).toBe(0.9);
      expect(scoreCandidate('男', 'male')).toBe(0.9);
      expect(scoreCandidate('女', 'female')).toBe(0.9);
    });

    it('matchSemantically selects exact match even when another candidate contains query as substring', async () => {
      const candidates = [
        { id: 'phone', text: 'Phone Number' },
        { id: 'no', text: 'No' },
      ];

      const res = await matchSemantically('choice', 'no', candidates, 'no');
      expect(res).not.toBeNull();
      expect(res?.matchedId).toBe('no');
      expect(res?.confidence).toBe(1.0);
    });

    it('matchSemantically strictly distinguishes "male" and "female"', async () => {
      const candidates = [
        { id: 'female', text: 'Female' },
        { id: 'male', text: 'Male' },
      ];

      const res = await matchSemantically('choice', 'male', candidates, 'male');
      expect(res).not.toBeNull();
      expect(res?.matchedId).toBe('male');
      expect(res?.confidence).toBe(1.0);

      const resFemale = await matchSemantically('choice', 'female', candidates, 'female');
      expect(resFemale?.matchedId).toBe('female');
    });

    it('does not falsely match unrelated candidates in Tier 1 literal matcher', async () => {
      const candidates = [{ id: 'electricity', text: 'Electricity Billing Details' }];

      // Query "city" should NOT match Electricity Billing Details
      const res = await matchSemantically('field', 'city', candidates);
      expect(res).toBeNull();
    });
  });

  // =========================================================================
  // 3. Physical Fill & Auto-Submit Subframe Target Passing
  // =========================================================================
  describe('3. Physical Fill & Auto-Submit Subframe Target Passing', () => {
    it('passes targetFrameId to subframe execution in performPhysicalFill', async () => {
      const projection = vi
        .spyOn(frameCoordinates, 'projectFramePoint')
        .mockResolvedValue({ x: 220, y: 170 });
      const executeInPageSpy = vi
        .spyOn(inPageEngine, 'executeInPage')
        .mockImplementation(async (target: any, fnName: string, args: any[]) => {
          if (fnName === 'inPageGetElementCoordinates') {
            if (target.allFrames) {
              return [
                {
                  frameId: 105,
                  result: {
                    success: true,
                    x: 200,
                    y: 150,
                    tagName: 'input',
                    inputType: 'text',
                  },
                },
              ];
            }
            return [{ frameId: 0, result: { success: false } }];
          }
          if (fnName === 'inPageVerifyInputCommitment') {
            return [
              { frameId: target.frameIds?.[0] || 0, result: { success: true, committed: true } },
            ];
          }
          return [{ frameId: 0, result: { success: true } }];
        });

      (globalThis as any).chrome = {
        scripting: {
          executeScript: vi.fn().mockResolvedValue([{ result: { offsetX: 0, offsetY: 0 } }]),
        },
        debugger: {
          sendCommand: vi.fn().mockResolvedValue({}),
        },
      };

      vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, _tag, fn) =>
        fn(),
      );
      vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({});

      const res = await fillCore.performPhysicalFill({
        tabId: 50,
        target: 7,
        text: 'test in subframe',
        clear: true,
      });

      expect(res.success).toBe(true);
      expect(res.committed).toBe(true);
      expect(projection).toHaveBeenCalledWith(50, 105, { x: 200, y: 150 });

      // Verify that inPageVerifyInputCommitment received frameIds: [105]
      const subframeCalls = executeInPageSpy.mock.calls.filter(
        (c) => c[0].frameIds && c[0].frameIds.includes(105),
      );
      expect(subframeCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('prevents double auto-submit click when performPhysicalFill already handled submission', async () => {
      (globalThis as any).chrome = {
        tabs: {
          get: vi.fn().mockResolvedValue({ id: 80, url: 'https://example.com' }),
        },
      };

      vi.spyOn(fillIndexTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 80,
        url: 'https://example.com',
      });

      vi.spyOn(fillCore, 'performPhysicalFill').mockResolvedValue({
        success: true,
        committed: true,
        filledText: 'query text',
        isTrusted: true,
        method: 'cdp_native',
        submitted: true,
        submitMethod: 'click',
        autoSubmitHandled: true,
        submitButtonState: { found: true, index: 9 },
      });

      const res = await fillIndexTool.execute({
        tabId: 80,
        index: 5,
        text: 'query text',
        submit: true,
        submitTarget: { index: 9 },
      });

      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.submitted).toBe(true);
      // autoSubmitFallbackApplied should NOT be set because performPhysicalFill already handled submission
      expect(parsed.autoSubmitFallbackApplied).toBeUndefined();
    });
  });
});
