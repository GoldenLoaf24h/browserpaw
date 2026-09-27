import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  detectEditorSemantics,
  getStickyOcclusionMargins,
  inPageDetectConfirmationTrap,
  inPageCheckInterception,
  inPageDispatchSyntheticClick,
  inPageScrollToIndex,
  inPageFillIndex,
  renderCompactElementLine,
  inPageLocateByText,
  getIsolatedIndexMap,
  type IndexedElement,
} from '../entrypoints/background/tools/browser/dom-indexer';
import { sessionTabAffinity } from '../utils/session-tab-affinity';
import { waitForNetworkQuiescence } from '../utils/action-watchdog';

describe('SPA Twitter/X Edge Cases & Parity Hardening', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    getIsolatedIndexMap().clear();
  });

  describe('Direction 1: Rich Text Composer vs Search Input Disambiguation', () => {
    it('accurately distinguishes Twitter compose box from top navigation search box', () => {
      // 1. Search Box
      const searchInput = document.createElement('input');
      searchInput.setAttribute('type', 'text');
      searchInput.setAttribute('placeholder', 'Search Twitter');
      searchInput.setAttribute('role', 'searchbox');
      searchInput.setAttribute('data-testid', 'SearchBox_Search_Input');
      document.body.appendChild(searchInput);

      const searchSemantics = detectEditorSemantics(searchInput);
      expect(searchSemantics.isSearch).toBe(true);
      expect(searchSemantics.isComposer).toBe(false);

      // 2. Twitter Post Composer
      const tweetComposer = document.createElement('div');
      tweetComposer.setAttribute('role', 'textbox');
      tweetComposer.setAttribute('contenteditable', 'true');
      tweetComposer.setAttribute('aria-label', 'Tweet text');
      tweetComposer.setAttribute('data-testid', 'tweetTextarea_0');
      document.body.appendChild(tweetComposer);

      const composerSemantics = detectEditorSemantics(tweetComposer);
      expect(composerSemantics.isComposer).toBe(true);
      expect(composerSemantics.isSearch).toBe(false);
    });

    it('identifies modern editor frameworks (Draft.js, Lexical, ProseMirror)', () => {
      const lexicalEditor = document.createElement('div');
      lexicalEditor.className = 'lexical-editor wysiwyg-post-body';
      lexicalEditor.setAttribute('contenteditable', 'true');
      lexicalEditor.setAttribute('role', 'textbox');
      lexicalEditor.setAttribute('aria-multiline', 'true');
      document.body.appendChild(lexicalEditor);

      const semantics = detectEditorSemantics(lexicalEditor);
      expect(semantics.isComposer).toBe(true);
      expect(semantics.isSearch).toBe(false);
    });

    it('annotates [composer] and [editor] tags in renderCompactElementLine', () => {
      const composerEl: IndexedElement = {
        index: 12,
        tagName: 'div',
        role: 'textbox',
        isInteractive: true,
        isComposer: true,
        text: 'What is happening?',
      };
      const renderedComposer = renderCompactElementLine(composerEl);
      expect(renderedComposer).toContain('[12]');
      expect(renderedComposer).toContain('[composer]');
      expect(renderedComposer).toContain('textbox');

      const searchEl: IndexedElement = {
        index: 15,
        tagName: 'input',
        role: 'searchbox',
        isInteractive: true,
        isSearch: true,
        attributes: { placeholder: 'Search...' },
      };
      const renderedSearch = renderCompactElementLine(searchEl);
      expect(renderedSearch).toContain('[15]');
      expect(renderedSearch).toContain('searchbox');
      expect(renderedSearch).not.toContain('[composer]');
    });

    it('locates role="composer" prioritising rich tweet composer over generic search inputs', () => {
      const searchBox = document.createElement('input');
      searchBox.setAttribute('type', 'search');
      searchBox.setAttribute('placeholder', 'Search Twitter');
      document.body.appendChild(searchBox);

      const tweetBox = document.createElement('div');
      tweetBox.setAttribute('role', 'textbox');
      tweetBox.setAttribute('contenteditable', 'true');
      tweetBox.setAttribute('data-testid', 'tweetTextarea_0');
      tweetBox.setAttribute('aria-label', 'Post text');
      document.body.appendChild(tweetBox);

      vi.spyOn(searchBox, 'getBoundingClientRect').mockReturnValue({
        x: 100,
        y: 20,
        width: 200,
        height: 35,
        top: 20,
        bottom: 55,
        left: 100,
        right: 300,
        toJSON: () => {},
      });
      vi.spyOn(tweetBox, 'getBoundingClientRect').mockReturnValue({
        x: 100,
        y: 100,
        width: 400,
        height: 120,
        top: 100,
        bottom: 220,
        left: 100,
        right: 500,
        toJSON: () => {},
      });

      const matched = inPageLocateByText('', 'composer');
      expect(matched.success).toBe(true);
      expect(matched.isComposer).toBe(true);
      expect(matched.tagName).toBe('div');
    });
  });

  describe('Direction 2: Invisible Overlay & Mask Piercing', () => {
    it('allows click through when intercepting overlay has pointer-events: none', () => {
      const targetBtn = document.createElement('button');
      targetBtn.id = 'add-post-btn';
      document.body.appendChild(targetBtn);
      getIsolatedIndexMap().set(5, targetBtn);

      const overlay = document.createElement('div');
      overlay.className = 'pointer-events-none-mask';
      document.body.appendChild(overlay);

      vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => {
        if (el === overlay) {
          return { pointerEvents: 'none', display: 'block', visibility: 'visible' } as any;
        }
        return { pointerEvents: 'auto', display: 'block', visibility: 'visible' } as any;
      });

      document.elementFromPoint = vi.fn().mockReturnValue(overlay);
      (document as any).elementsFromPoint = vi.fn().mockReturnValue([overlay]);

      const res = inPageCheckInterception(5, 100, 200);
      expect(res.intercepted).toBe(false);
    });

    it('marks transient backdrop mask with canPierce: true', () => {
      const targetBtn = document.createElement('button');
      targetBtn.id = 'send-reply';
      document.body.appendChild(targetBtn);
      getIsolatedIndexMap().set(8, targetBtn);

      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop fade show';
      backdrop.setAttribute('role', 'presentation');
      document.body.appendChild(backdrop);

      vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => {
        if (el === backdrop) {
          return {
            pointerEvents: 'auto',
            display: 'block',
            visibility: 'visible',
            opacity: '0.02',
          } as any;
        }
        return { pointerEvents: 'auto', display: 'block', visibility: 'visible' } as any;
      });

      document.elementFromPoint = vi.fn().mockReturnValue(backdrop);
      (document as any).elementsFromPoint = vi.fn().mockReturnValue([backdrop]);

      const res = inPageCheckInterception(8, 150, 250);
      expect(res.intercepted).toBe(true);
      expect(res.canPierce).toBe(true);
      expect(res.pierceReason).toBe('zero_opacity');
    });

    it('does NOT allow piercing real interactive modal dialogs', () => {
      const targetBtn = document.createElement('button');
      document.body.appendChild(targetBtn);
      getIsolatedIndexMap().set(3, targetBtn);

      const modal = document.createElement('div');
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-label', 'Subscribe to Premium');
      const subBtn = document.createElement('button');
      subBtn.textContent = 'Upgrade';
      modal.appendChild(subBtn);
      document.body.appendChild(modal);

      vi.spyOn(window, 'getComputedStyle').mockImplementation(() => {
        return {
          pointerEvents: 'auto',
          display: 'block',
          visibility: 'visible',
          opacity: '1',
        } as any;
      });

      document.elementFromPoint = vi.fn().mockReturnValue(modal);
      (document as any).elementsFromPoint = vi.fn().mockReturnValue([modal]);

      const res = inPageCheckInterception(3, 50, 50);
      expect(res.intercepted).toBe(true);
      expect(res.canPierce).toBeFalsy();
    });

    it('pierces transparent background mask (opacity: 1, backgroundColor: transparent)', () => {
      const targetBtn = document.createElement('button');
      targetBtn.id = 'submit-post';
      document.body.appendChild(targetBtn);
      getIsolatedIndexMap().set(7, targetBtn);

      const transparentMask = document.createElement('div');
      transparentMask.className = 'css-175oi2r r-172uzdr backdrop';
      document.body.appendChild(transparentMask);

      vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => {
        if (el === transparentMask) {
          return {
            pointerEvents: 'auto',
            display: 'block',
            visibility: 'visible',
            opacity: '1',
            backgroundColor: 'rgba(0, 0, 0, 0)',
          } as any;
        }
        return {
          pointerEvents: 'auto',
          display: 'block',
          visibility: 'visible',
          opacity: '1',
          backgroundColor: '#fff',
        } as any;
      });

      document.elementFromPoint = vi.fn().mockReturnValue(transparentMask);
      (document as any).elementsFromPoint = vi.fn().mockReturnValue([transparentMask, targetBtn]);

      const res = inPageCheckInterception(7, 200, 300);
      expect(res.intercepted).toBe(true);
      expect(res.canPierce).toBe(true);
      expect(res.pierceReason).toBe('transparent_background');
    });

    it('pierces transient mask using elementsFromPoint in inPageDispatchSyntheticClick', () => {
      const targetBtn = document.createElement('button');
      targetBtn.id = 'tweet-button';
      let clicked = false;
      targetBtn.addEventListener('click', () => {
        clicked = true;
      });
      document.body.appendChild(targetBtn);

      const mask = document.createElement('div');
      mask.className = 'loading-overlay-stub';
      document.body.appendChild(mask);

      vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => {
        if (el === mask) {
          return {
            pointerEvents: 'auto',
            display: 'block',
            visibility: 'visible',
            opacity: '0.01',
            backgroundColor: 'transparent',
          } as any;
        }
        return {
          pointerEvents: 'auto',
          display: 'block',
          visibility: 'visible',
          opacity: '1',
          backgroundColor: '#fff',
        } as any;
      });

      // elementsFromPoint returns mask on top, followed by targetBtn
      (document as any).elementsFromPoint = vi.fn().mockReturnValue([mask, targetBtn]);
      document.elementFromPoint = vi.fn().mockReturnValue(mask);

      // Dispatch click via coordinates (index null)
      const dispatched = inPageDispatchSyntheticClick(null, 150, 250, 'click');
      expect(dispatched).toBe(true);
      expect(clicked).toBe(true);
    });
  });

  describe('Direction 3: Queue Serialization & Concurrency Order Guard', () => {
    it('executes concurrent asynchronous operations in strict FIFO sequence', async () => {
      const executionOrder: number[] = [];

      const p1 = sessionTabAffinity.runSerialized(101, async () => {
        await new Promise((r) => setTimeout(r, 60));
        executionOrder.push(1);
        return 'first';
      });

      const p2 = sessionTabAffinity.runSerialized(101, async () => {
        await new Promise((r) => setTimeout(r, 10));
        executionOrder.push(2);
        return 'second';
      });

      const p3 = sessionTabAffinity.runSerialized(101, async () => {
        await new Promise((r) => setTimeout(r, 5));
        executionOrder.push(3);
        return 'third';
      });

      const results = await Promise.all([p1, p2, p3]);
      expect(results).toEqual(['first', 'second', 'third']);
      expect(executionOrder).toEqual([1, 2, 3]);
    });

    it('continues queue processing even if a preceding operation throws', async () => {
      const order: string[] = [];

      const p1 = sessionTabAffinity
        .runSerialized(202, async () => {
          order.push('op1_started');
          throw new Error('Failure in op 1');
        })
        .catch(() => {
          order.push('op1_failed');
          return 'caught';
        });

      const p2 = sessionTabAffinity.runSerialized(202, async () => {
        order.push('op2_succeeded');
        return 'success';
      });

      await Promise.all([p1, p2]);
      expect(order).toContain('op1_started');
      expect(order).toContain('op2_succeeded');
    });
  });

  describe('Direction 4: Modal Confirmation Trap & Sticky Occlusion Margins', () => {
    it('detects confirmation trap dialog (Discard draft / 放弃帖子)', () => {
      const dialog = document.createElement('dialog');
      dialog.open = true;
      dialog.setAttribute('aria-label', 'Discard post?');
      dialog.innerHTML = `
        <h3>Discard post?</h3>
        <p>This cannot be undone and you will lose your draft.</p>
        <button id="discard">Discard</button>
        <button id="cancel">Cancel</button>
      `;
      document.body.appendChild(dialog);

      vi.spyOn(window, 'getComputedStyle').mockReturnValue({
        display: 'block',
        visibility: 'visible',
      } as any);
      vi.spyOn(dialog, 'offsetWidth', 'get').mockReturnValue(320);

      const trap = inPageDetectConfirmationTrap();
      expect(trap.detected).toBe(true);
      expect(trap.title).toContain('Discard post?');
      expect(trap.buttons).toContain('Discard');
      expect(trap.buttons).toContain('Cancel');
    });

    it('returns detected: false for normal non-trap dialogs', () => {
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-label', 'User Profile Settings');
      dialog.innerHTML = '<button>Save</button>';
      document.body.appendChild(dialog);

      vi.spyOn(window, 'getComputedStyle').mockReturnValue({
        display: 'block',
        visibility: 'visible',
      } as any);
      vi.spyOn(dialog, 'offsetWidth', 'get').mockReturnValue(400);

      const trap = inPageDetectConfirmationTrap();
      expect(trap.detected).toBe(false);
    });

    it('calculates sticky occlusion margins correctly for fixed headers and footers', () => {
      const header = document.createElement('header');
      header.className = 'sticky-top-nav';
      document.body.appendChild(header);

      const footer = document.createElement('footer');
      footer.className = 'fixed-bottom-bar';
      document.body.appendChild(footer);

      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1280);
      vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800);

      vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => {
        if (el === header) return { position: 'fixed' } as any;
        if (el === footer) return { position: 'fixed' } as any;
        return { position: 'static' } as any;
      });

      vi.spyOn(header, 'getBoundingClientRect').mockReturnValue({
        top: 0,
        bottom: 53,
        left: 0,
        right: 1280,
        width: 1280,
        height: 53,
        x: 0,
        y: 0,
        toJSON: () => {},
      });

      vi.spyOn(footer, 'getBoundingClientRect').mockReturnValue({
        top: 745,
        bottom: 800,
        left: 0,
        right: 1280,
        width: 1280,
        height: 55,
        x: 0,
        y: 745,
        toJSON: () => {},
      });

      const margins = getStickyOcclusionMargins(window);
      expect(margins.top).toBe(53);
      expect(margins.bottom).toBe(55);
    });

    it('nudges scroll in inPageScrollToIndex when target element lands inside sticky margins', () => {
      const targetEl = document.createElement('div');
      targetEl.id = 'reply-box';
      document.body.appendChild(targetEl);
      getIsolatedIndexMap().set(9, targetEl);

      // Simulate scrollIntoView
      targetEl.scrollIntoView = vi.fn();

      // Return a rect that lands inside top sticky margin (top: 30px, while safe top margin is 80px)
      vi.spyOn(targetEl, 'getBoundingClientRect').mockReturnValue({
        top: 30,
        bottom: 70,
        left: 50,
        right: 400,
        width: 350,
        height: 40,
        x: 50,
        y: 30,
        toJSON: () => {},
      });

      const scrollBySpy = vi.fn();
      window.scrollBy = scrollBySpy;

      const success = inPageScrollToIndex(9);
      expect(success).toBe(true);
      expect(targetEl.scrollIntoView).toHaveBeenCalled();
      // Should have nudged scroll up because top: 30 < safeTop (80) + 10
      expect(scrollBySpy).toHaveBeenCalled();
      expect(scrollBySpy.mock.calls[0][0].top).toBeLessThan(0);
    });
  });

  describe('Direction 1 Extra: In-Page Fill Rich Editor Execution', () => {
    it('successfully fills contenteditable element and triggers input/change events', () => {
      const editor = document.createElement('div');
      editor.setAttribute('contenteditable', 'true');
      editor.setAttribute('role', 'textbox');
      document.body.appendChild(editor);
      getIsolatedIndexMap().set(14, editor);

      let inputFired = false;
      let changeFired = false;
      editor.addEventListener('input', () => {
        inputFired = true;
      });
      editor.addEventListener('change', () => {
        changeFired = true;
      });

      const fillRes = inPageFillIndex(14, 'Hello Twitter World!', true, false);
      expect(fillRes.success).toBe(true);
      expect(editor.innerText).toBe('Hello Twitter World!');
      expect(inputFired).toBe(true);
      expect(changeFired).toBe(true);
    });
  });
});
