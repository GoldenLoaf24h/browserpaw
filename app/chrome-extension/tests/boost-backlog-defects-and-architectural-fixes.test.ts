import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  querySelectorAllDeep,
  querySelectorDeep,
  flattenCompositeCards,
  renderCompactElementLine,
  inPageScrollUntilFound,
  inPageDOMPruner,
  detectActiveModalBlocker,
  inPageEnsureModalFocus,
  inPageLocateBySelector,
  inPageVerifyInputCommitment,
  getIsolatedIndexMap,
  wrapElement,
  derefElement,
} from '../entrypoints/background/tools/browser/dom-indexer';
import { inPageCheckOcclusion } from '../entrypoints/background/tools/browser/fast-snapshot';
import { javascriptTool } from '../entrypoints/background/tools/browser/javascript';
import { TOOL_NAMES, TOOL_SCHEMAS } from 'chrome-mcp-shared';
import { scrollUntilFoundTool } from '../entrypoints/background/tools/browser/scroll-until-found';

describe('BrowserPaw Backlog Defects & Universal Architectural Fixes', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    getIsolatedIndexMap().clear();
    vi.restoreAllMocks();
  });

  describe('1. P0: Client-Side Auto-Scroll (inPageScrollUntilFound & scroll_until_found)', () => {
    it('is registered in TOOL_SCHEMAS and has valid schema definition', () => {
      const toolSchema = TOOL_SCHEMAS.find((s) => s.name === TOOL_NAMES.BROWSER.SCROLL_UNTIL_FOUND);
      expect(toolSchema).toBeDefined();
      expect(toolSchema?.name).toBe('chrome_scroll_until_found');
      expect(toolSchema?.inputSchema.properties.query).toBeDefined();
      expect(toolSchema?.inputSchema.properties.maxSteps).toBeDefined();
      expect(toolSchema?.inputSchema.properties.stepPx).toBeDefined();
      expect(scrollUntilFoundTool.name).toBe(TOOL_NAMES.BROWSER.SCROLL_UNTIL_FOUND);
    });

    it('immediately finds and centers an element that is already in viewport', async () => {
      const btn = document.createElement('button');
      btn.textContent = 'Target Action Button';
      Object.defineProperty(btn, 'getBoundingClientRect', {
        value: () => ({ left: 100, top: 200, width: 80, height: 30, right: 180, bottom: 230 }),
      });
      document.body.appendChild(btn);

      const scrollIntoViewSpy = vi.fn();
      btn.scrollIntoView = scrollIntoViewSpy;

      const result = await inPageScrollUntilFound({
        query: 'Target Action',
        maxSteps: 5,
        stepPx: 500,
        settleMs: 10,
      });

      expect(result.found).toBe(true);
      expect(result.stepsTaken).toBe(0);
      expect(result.scrolledPx).toBe(0);
      expect(result.tagName).toBe('button');
      expect(result.text).toContain('Target Action');
      expect(result.index).toBeGreaterThan(0);
      expect(result.coordinates).toEqual({ x: 140, y: 215 });
      expect(scrollIntoViewSpy).toHaveBeenCalled();
    });

    it('scrolls step-by-step and finds element that appears during scroll', async () => {
      let currentScrollY = 0;
      window.scrollY = 0;
      window.scrollBy = vi.fn((opts: any) => {
        currentScrollY += opts.top;
        (window as any).scrollY = currentScrollY;
      });

      const container = document.createElement('div');
      document.body.appendChild(container);

      // Simulate step 2: element appears after 2 scroll steps
      let checkCount = 0;
      const originalQuerySelectorAll = document.querySelectorAll.bind(document);
      vi.spyOn(document, 'querySelectorAll').mockImplementation((sel: any) => {
        if (checkCount >= 2 && !document.getElementById('lazy-tweet')) {
          const lazy = document.createElement('article');
          lazy.id = 'lazy-tweet';
          lazy.textContent = 'Dynamic Infinite Stream Tweet Content';
          Object.defineProperty(lazy, 'getBoundingClientRect', {
            value: () => ({ left: 50, top: 150, width: 300, height: 80, right: 350, bottom: 230 }),
          });
          lazy.scrollIntoView = vi.fn();
          container.appendChild(lazy);
        }
        checkCount++;
        return originalQuerySelectorAll(sel);
      });

      const result = await inPageScrollUntilFound({
        query: 'Infinite Stream Tweet',
        maxSteps: 5,
        stepPx: 600,
        settleMs: 10,
      });

      expect(result.found).toBe(true);
      expect(result.stepsTaken).toBeGreaterThanOrEqual(1);
      expect(result.scrolledPx).toBeGreaterThanOrEqual(600);
      expect(result.text).toContain('Dynamic Infinite Stream');
    });

    it('terminates gracefully when reaching bottom without matching target', async () => {
      // Simulate stalled scroll position (bottom of page)
      window.scrollY = 1200;
      window.scrollBy = vi.fn();

      const result = await inPageScrollUntilFound({
        query: 'Nonexistent Elusive Target',
        maxSteps: 4,
        stepPx: 500,
        settleMs: 10,
      });

      expect(result.found).toBe(false);
      expect(result.message).toContain('not found');
    });
  });

  describe('2. Shadow DOM Piercing (>>> and /deep/) in querySelectorAllDeep & batch_actions', () => {
    it('penetrates multi-level ShadowRoot using >>> combinator', () => {
      // Create custom element with ShadowRoot: <host-element> #shadowRoot <button class="inner-btn">
      const host = document.createElement('div');
      host.id = 'host';
      const shadow = host.attachShadow({ mode: 'open' });
      const innerBtn = document.createElement('button');
      innerBtn.className = 'inner-btn';
      innerBtn.textContent = 'Inside Shadow';
      shadow.appendChild(innerBtn);
      document.body.appendChild(host);

      // Standard querySelector fails across shadow boundary
      expect(document.querySelector('#host .inner-btn')).toBeNull();

      // querySelectorAllDeep with >>> succeeds
      const deepResults = querySelectorAllDeep('#host >>> .inner-btn', document);
      expect(deepResults).toHaveLength(1);
      expect(deepResults[0]).toBe(innerBtn);

      // querySelectorDeep returns direct element
      const firstHit = querySelectorDeep('#host >>> .inner-btn', document);
      expect(firstHit).toBe(innerBtn);
    });

    it('penetrates multi-layer nested shadow components', () => {
      // <outer-comp> #shadowRoot <inner-comp> #shadowRoot <span id="leaf">
      const outer = document.createElement('div');
      outer.id = 'outer';
      const outerShadow = outer.attachShadow({ mode: 'open' });

      const inner = document.createElement('div');
      inner.className = 'inner';
      const innerShadow = inner.attachShadow({ mode: 'open' });

      const leaf = document.createElement('span');
      leaf.id = 'leaf';
      leaf.textContent = 'Deep Nested Shadow Text';
      innerShadow.appendChild(leaf);
      outerShadow.appendChild(inner);
      document.body.appendChild(outer);

      const hit = querySelectorDeep('#outer >>> .inner >>> #leaf', document);
      expect(hit).toBe(leaf);
      expect(hit?.textContent).toBe('Deep Nested Shadow Text');
    });
  });

  describe('3. Composite Cards Action Triggers & Click Bubbling Protection', () => {
    it('detects and preserves inner action triggers (reply, retweet, like) from being collapsed', () => {
      const card = document.createElement('article');
      card.setAttribute('role', 'article');
      Object.defineProperty(card, 'getBoundingClientRect', {
        value: () => ({ left: 0, top: 0, width: 500, height: 200, right: 500, bottom: 200 }),
      });

      const titleLink = document.createElement('a');
      titleLink.href = 'https://x.com/user/status/12345';
      titleLink.innerText = 'Interesting Post Title';

      const replyBtn = document.createElement('div');
      replyBtn.setAttribute('role', 'button');
      replyBtn.setAttribute('data-testid', 'reply');
      replyBtn.setAttribute('aria-label', 'Reply');

      const likeBtn = document.createElement('button');
      likeBtn.setAttribute('data-testid', 'like');
      likeBtn.textContent = 'Like 42';

      const userLink = document.createElement('a');
      userLink.href = 'https://x.com/author_profile';
      userLink.innerText = '@author';

      card.appendChild(titleLink);
      card.appendChild(userLink);
      card.appendChild(replyBtn);
      card.appendChild(likeBtn);
      document.body.appendChild(card);

      const candidates = [
        { node: titleLink, tag: 'a', rect: {} as any, isFile: false, isInteractive: true },
        { node: userLink, tag: 'a', rect: {} as any, isFile: false, isInteractive: true },
        { node: replyBtn, tag: 'div', rect: {} as any, isFile: false, isInteractive: true },
        { node: likeBtn, tag: 'button', rect: {} as any, isFile: false, isInteractive: true },
      ];

      const flattenedCount = flattenCompositeCards(candidates, 120);
      expect(flattenedCount).toBe(1);

      // Primary candidate is card
      const prim = candidates.find((c: any) => c.isCard);
      expect(prim).toBeDefined();
      expect(prim?.node).toBe(titleLink);

      // Action triggers are NOT marked as isCardSecondary
      const replyCand = candidates.find((c) => c.node === replyBtn) as any;
      expect(replyCand.isCardSecondary).toBeFalsy();
      expect(replyCand.isActionTrigger).toBe(true);
      expect(replyCand.actionTriggerType).toBe('reply');

      const likeCand = candidates.find((c) => c.node === likeBtn) as any;
      expect(likeCand.isCardSecondary).toBeFalsy();
      expect(likeCand.isActionTrigger).toBe(true);

      // Distinct secondary author profile link is also preserved as action trigger
      const userCand = candidates.find((c) => c.node === userLink) as any;
      expect(userCand.isCardSecondary).toBeFalsy();
      expect(userCand.isActionTrigger).toBe(true);
      expect(userCand.actionTriggerType).toBe('link');
    });

    it('formats compact element lines with (action-trigger: type) badge', () => {
      const line = renderCompactElementLine({
        index: 12,
        tagName: 'button',
        text: 'Reply',
        isInteractive: true,
        attributes: {},
        rect: { x: 10, y: 20, width: 30, height: 30 },
        isActionTrigger: true,
        actionTriggerType: 'reply',
      });

      expect(line).toContain('[12]');
      expect(line).toContain('button "Reply"');
      expect(line).toContain('(action-trigger: reply)');
    });
  });

  describe('4. Modal Auto-Isolation (Modal Focus Mode) & Occlusion Deadzone Elimination', () => {
    it('automatically isolates active modal blocker by default and prunes background DOM', () => {
      // Create background element
      const bgPost = document.createElement('div');
      bgPost.id = 'bg-post-author';
      bgPost.textContent = 'Mukanyun520 User Profile Background Text';
      document.body.appendChild(bgPost);

      // Create active modal dialog
      const modal = document.createElement('div');
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-label', 'Add flair and tags');
      Object.defineProperty(modal, 'getBoundingClientRect', {
        value: () => ({ left: 200, top: 100, width: 800, height: 600, right: 1000, bottom: 700 }),
      });
      modal.style.position = 'fixed';
      modal.style.zIndex = '9999';

      const flairOption = document.createElement('button');
      flairOption.textContent = 'Discussion Flair Option';
      Object.defineProperty(flairOption, 'getBoundingClientRect', {
        value: () => ({ left: 250, top: 150, width: 200, height: 40, right: 450, bottom: 190 }),
      });
      modal.appendChild(flairOption);
      document.body.appendChild(modal);

      // Auto modal isolation runs when options.isolateModal is undefined / true
      const prunerResult = inPageDOMPruner({
        highlight: false,
      });

      expect(prunerResult.modalIsolated).toBe(true);
      expect(prunerResult.treeString).toContain('[MODAL_ACTIVE: Focus locked to active modal');
      expect(prunerResult.treeString).toContain('Add flair and tags');
      expect(prunerResult.treeString).toContain('Discussion Flair Option');

      // Background elements are pruned to prevent misclicks
      expect(prunerResult.treeString).not.toContain('Mukanyun520');
    });

    it('does not leak background static [role="combobox"] into modalRoots during modal auto-isolation', () => {
      // Global background search bar
      const bgSearch = document.createElement('input');
      bgSearch.setAttribute('role', 'combobox');
      bgSearch.id = 'bg-search-combobox';
      bgSearch.placeholder = 'Search Reddit...';
      document.body.appendChild(bgSearch);

      // Active modal dialog
      const modal = document.createElement('dialog');
      modal.open = true;
      modal.setAttribute('aria-label', 'Active Dialog');
      modal.style.position = 'fixed';
      modal.style.zIndex = '9999';
      Object.defineProperty(modal, 'getBoundingClientRect', {
        value: () => ({ left: 100, top: 100, width: 800, height: 600, right: 900, bottom: 700 }),
      });
      const innerBtn = document.createElement('button');
      innerBtn.textContent = 'Modal Confirm';
      Object.defineProperty(innerBtn, 'getBoundingClientRect', {
        value: () => ({ left: 120, top: 120, width: 150, height: 40, right: 270, bottom: 160 }),
      });
      modal.appendChild(innerBtn);
      document.body.appendChild(modal);

      const prunerResult = inPageDOMPruner({ highlight: false });
      expect(prunerResult.modalIsolated).toBe(true);
      expect(prunerResult.treeString).toContain('Modal Confirm');
      // Background search bar must not leak into modal isolated view
      expect(prunerResult.treeString).not.toContain('Search Reddit...');
    });

    it('traps and moves keyboard focus into modal via inPageEnsureModalFocus', () => {
      // Background input has current focus
      const bgInput = document.createElement('input');
      document.body.appendChild(bgInput);
      bgInput.focus();
      expect(document.activeElement).toBe(bgInput);

      // Modal is active
      const modal = document.createElement('div');
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.style.position = 'fixed';
      modal.style.zIndex = '9999';
      Object.defineProperty(modal, 'getBoundingClientRect', {
        value: () => ({ left: 100, top: 100, width: 400, height: 300, right: 500, bottom: 400 }),
      });

      const modalBtn = document.createElement('button');
      modalBtn.textContent = 'First Modal Control';
      Object.defineProperty(modalBtn, 'getBoundingClientRect', {
        value: () => ({ left: 120, top: 120, width: 100, height: 30, right: 220, bottom: 150 }),
      });
      modal.appendChild(modalBtn);
      document.body.appendChild(modal);

      const focused = inPageEnsureModalFocus(modal);
      expect(focused).toBe(true);
      expect(document.activeElement).toBe(modalBtn);
    });
  });

  describe('5. Shadow DOM & Overlay Piercing (inPageCheckOcclusion & inPageLocateBySelector)', () => {
    it('pierces Shadow DOM in inPageCheckOcclusion without false-positive occlusion', () => {
      const host = document.createElement('custom-host');
      const shadow = host.attachShadow({ mode: 'open' });
      const shadowBtn = document.createElement('button');
      shadowBtn.textContent = 'Inside Shadow Button';
      Object.defineProperty(shadowBtn, 'getBoundingClientRect', {
        value: () => ({
          x: 100,
          y: 100,
          width: 80,
          height: 30,
          left: 100,
          top: 100,
          right: 180,
          bottom: 130,
        }),
      });
      shadow.appendChild(shadowBtn);
      document.body.appendChild(host);

      // Register in isolatedMap
      const isolatedMap = getIsolatedIndexMap();
      isolatedMap.set(55, wrapElement(shadowBtn));

      // Mock shadow elementFromPoint
      document.elementFromPoint = vi.fn(() => host);
      shadow.elementFromPoint = vi.fn(() => shadowBtn);

      const res = inPageCheckOcclusion({ node: 55, kind: 'click' });
      expect(res).not.toBeNull();
      expect(res?.x).toBe(140);
      expect(res?.y).toBe(115);
    });

    it('pierces transparent backdrop mask in inPageCheckOcclusion', () => {
      const btn = document.createElement('button');
      btn.textContent = 'Target Under Mask';
      Object.defineProperty(btn, 'getBoundingClientRect', {
        value: () => ({
          x: 200,
          y: 200,
          width: 100,
          height: 40,
          left: 200,
          top: 200,
          right: 300,
          bottom: 240,
        }),
      });
      document.body.appendChild(btn);

      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop-mask';
      document.body.appendChild(backdrop);

      const isolatedMap = getIsolatedIndexMap();
      isolatedMap.set(77, wrapElement(btn));

      // First call returns backdrop, second call (with pointer-events: none) returns btn
      let callCount = 0;
      document.elementFromPoint = vi.fn(() => {
        callCount++;
        return callCount === 1 ? backdrop : btn;
      });

      const res = inPageCheckOcclusion({ node: 77, kind: 'click' });
      expect(res).not.toBeNull();
      expect(res?.x).toBe(250);
      expect(res?.y).toBe(220);
    });

    it('resolves >>> shadow selectors safely in inPageLocateBySelector without syntax crash', () => {
      const host = document.createElement('section');
      host.id = 'shadow-section';
      const shadow = host.attachShadow({ mode: 'open' });
      const innerEl = document.createElement('input');
      innerEl.id = 'nested-input';
      Object.defineProperty(innerEl, 'getBoundingClientRect', {
        value: () => ({
          x: 50,
          y: 50,
          width: 100,
          height: 30,
          left: 50,
          top: 50,
          right: 150,
          bottom: 80,
        }),
      });
      shadow.appendChild(innerEl);
      document.body.appendChild(host);

      // inPageLocateBySelector with >>> must not throw and must find innerEl
      const loc = inPageLocateBySelector('#shadow-section >>> #nested-input');
      expect(loc.success).toBe(true);
      expect(loc.x).toBe(100);
      expect(loc.y).toBe(65);
    });

    it('finds submit buttons across Shadow DOM in inPageVerifyInputCommitment', () => {
      const composerHost = document.createElement('div');
      composerHost.className = 'composer-container';
      const shadow = composerHost.attachShadow({ mode: 'open' });

      const input = document.createElement('input');
      input.value = 'Committed Tweet Text';
      composerHost.appendChild(input);

      const submitBtn = document.createElement('button');
      submitBtn.setAttribute('data-testid', 'tweetButtonInline');
      submitBtn.textContent = 'Post';
      shadow.appendChild(submitBtn);
      document.body.appendChild(composerHost);

      const isolatedMap = getIsolatedIndexMap();
      isolatedMap.set(90, wrapElement(input));

      const verification = inPageVerifyInputCommitment(90, 'Committed Tweet Text');
      expect(verification.committed).toBe(true);
      expect(verification.submitButtonState?.found).toBe(true);
      expect(verification.submitButtonState?.text).toBe('Post');
    });

    it('finds text inside generic div and custom components in inPageScrollUntilFound', async () => {
      const customPost = document.createElement('div');
      customPost.className = 'tweet-body-content';
      customPost.textContent = 'Custom Deep Component Tweet Payload';
      Object.defineProperty(customPost, 'getBoundingClientRect', {
        value: () => ({ left: 50, top: 100, width: 300, height: 50, right: 350, bottom: 150 }),
      });
      customPost.scrollIntoView = vi.fn();
      document.body.appendChild(customPost);

      const res = await inPageScrollUntilFound({
        query: 'Component Tweet Payload',
        maxSteps: 3,
        stepPx: 500,
        settleMs: 10,
      });

      expect(res.found).toBe(true);
      expect(res.text).toContain('Custom Deep Component');
    });
  });

  describe('6. High-Privilege Eval Channel & Parameter Interoperability', () => {
    it('accepts script parameter alias in JavaScriptTool without parameter validation error', async () => {
      // Missing both code and script
      const noArgsRes = await javascriptTool.execute({} as any);
      expect(noArgsRes.isError).toBe(true);
      expect((noArgsRes.content[0] as any).text).toContain('Parameter [code] is required');

      // Providing script alias passes validation (reaches tab resolution)
      const scriptRes = await javascriptTool.execute({ script: 'return 1 + 1;' } as any);
      // Fails at tab resolution (mock environment has no active tab), NOT parameter validation
      expect((scriptRes.content[0] as any).text).not.toContain('Parameter [code] is required');
      expect((scriptRes.content[0] as any).text).toContain('No active tab found');
    });
  });
});
