import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  inPageFindSmartScrollTarget,
  inPageFillIndex,
  inPageInsertMedia,
} from '../entrypoints/background/tools/browser/dom-indexer';

describe('Production Boost: Priority Scroll, Multiline Newlines, and Media Injection', () => {
  describe('1. Priority Scroll Engine (inPageFindSmartScrollTarget)', () => {
    it('penalizes narrow navigation sidebars and prefers window or main content', () => {
      // Mock window size
      (window as any).innerWidth = 1280;
      (window as any).innerHeight = 800;

      // Mock DOM structure: narrow sidebar (reddit-sidebar-nav) vs main container
      const sidebar = document.createElement('div');
      sidebar.className = 'reddit-sidebar-nav';
      sidebar.id = 'left-nav';
      sidebar.setAttribute('role', 'navigation');

      const mainContent = document.createElement('main');
      mainContent.className = 'main-content';
      mainContent.id = 'reddit-main-feed';
      mainContent.setAttribute('role', 'main');

      document.body.appendChild(sidebar);
      document.body.appendChild(mainContent);

      // Mock getBoundingClientRect
      sidebar.getBoundingClientRect = () =>
        ({
          x: 0,
          y: 60,
          left: 0,
          top: 60,
          right: 240,
          bottom: 760,
          width: 240,
          height: 700,
          toJSON: () => ({}),
        }) as DOMRect;

      mainContent.getBoundingClientRect = () =>
        ({
          x: 260,
          y: 60,
          left: 260,
          top: 60,
          right: 1060,
          bottom: 760,
          width: 800,
          height: 700,
          toJSON: () => ({}),
        }) as DOMRect;

      // Mock scroll properties
      Object.defineProperty(sidebar, 'scrollHeight', { value: 1500, configurable: true });
      Object.defineProperty(sidebar, 'clientHeight', { value: 700, configurable: true });
      Object.defineProperty(sidebar, 'scrollWidth', { value: 240, configurable: true });
      Object.defineProperty(sidebar, 'clientWidth', { value: 240, configurable: true });

      Object.defineProperty(mainContent, 'scrollHeight', { value: 3000, configurable: true });
      Object.defineProperty(mainContent, 'clientHeight', { value: 700, configurable: true });
      Object.defineProperty(mainContent, 'scrollWidth', { value: 800, configurable: true });
      Object.defineProperty(mainContent, 'clientWidth', { value: 800, configurable: true });

      // Mock getComputedStyle
      const origGetComputedStyle = window.getComputedStyle;
      window.getComputedStyle = (el: Element) => {
        if (el === sidebar || el === mainContent) {
          return {
            overflowY: 'auto',
            overflowX: 'hidden',
            display: 'block',
            visibility: 'visible',
            opacity: '1',
          } as CSSStyleDeclaration;
        }
        return origGetComputedStyle(el);
      };

      try {
        const target = inPageFindSmartScrollTarget();
        expect(target.found).toBe(true);
        // It must NOT pick the narrow sidebar
        expect(target.selector).not.toContain('reddit-sidebar-nav');
        expect(target.selector).not.toContain('left-nav');
        // It should pick main content or window
        expect(target.isWindow || target.selector?.includes('main')).toBe(true);
      } finally {
        window.getComputedStyle = origGetComputedStyle;
        sidebar.remove();
        mainContent.remove();
      }
    });

    it('disqualifies containers exhausted in requested scroll direction', () => {
      (window as any).innerWidth = 1280;
      (window as any).innerHeight = 800;

      const sidebar = document.createElement('div');
      sidebar.id = 'exhausted-sidebar';
      document.body.appendChild(sidebar);

      sidebar.getBoundingClientRect = () =>
        ({
          x: 0,
          y: 60,
          left: 0,
          top: 60,
          right: 350,
          bottom: 760,
          width: 350,
          height: 700,
          toJSON: () => ({}),
        }) as DOMRect;

      // Fully scrolled to bottom: scrollTop + clientHeight >= scrollHeight - 5
      Object.defineProperty(sidebar, 'scrollHeight', { value: 1400, configurable: true });
      Object.defineProperty(sidebar, 'clientHeight', { value: 700, configurable: true });
      Object.defineProperty(sidebar, 'scrollTop', { value: 700, configurable: true });
      Object.defineProperty(sidebar, 'scrollWidth', { value: 350, configurable: true });
      Object.defineProperty(sidebar, 'clientWidth', { value: 350, configurable: true });

      const origGetComputedStyle = window.getComputedStyle;
      window.getComputedStyle = (el: Element) => {
        if (el === sidebar) {
          return {
            overflowY: 'auto',
            overflowX: 'hidden',
            display: 'block',
            visibility: 'visible',
            opacity: '1',
          } as CSSStyleDeclaration;
        }
        return origGetComputedStyle(el);
      };

      try {
        // When direction is down, the exhausted sidebar must be disqualified
        const targetDown = inPageFindSmartScrollTarget({ direction: 'down' });
        expect(targetDown.selector).not.toBe('#exhausted-sidebar');

        // But when direction is up, it can still scroll up
        const targetUp = inPageFindSmartScrollTarget({ direction: 'up' });
        expect(targetUp.selector).toBe('#exhausted-sidebar');
      } finally {
        window.getComputedStyle = origGetComputedStyle;
        sidebar.remove();
      }
    });

    it('honors explicit selector even if targeting a sidebar', () => {
      const sidebar = document.createElement('nav');
      sidebar.id = 'target-nav';
      document.body.appendChild(sidebar);

      sidebar.getBoundingClientRect = () =>
        ({
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: 200,
          bottom: 600,
          width: 200,
          height: 600,
          toJSON: () => ({}),
        }) as DOMRect;

      Object.defineProperty(sidebar, 'scrollHeight', { value: 1200, configurable: true });
      Object.defineProperty(sidebar, 'clientHeight', { value: 600, configurable: true });

      const origGetComputedStyle = window.getComputedStyle;
      window.getComputedStyle = () =>
        ({
          overflowY: 'auto',
          overflowX: 'hidden',
          display: 'block',
          visibility: 'visible',
          opacity: '1',
        }) as CSSStyleDeclaration;

      try {
        const target = inPageFindSmartScrollTarget({ selector: '#target-nav' });
        expect(target.found).toBe(true);
        expect(target.selector).toBe('#target-nav');
        expect(target.isWindow).toBe(false);
      } finally {
        window.getComputedStyle = origGetComputedStyle;
        sidebar.remove();
      }
    });
  });

  describe('2. Multiline Newline Preservation (inPageFillIndex)', () => {
    it('dispatches paragraph/enter events for contenteditable elements containing newlines', async () => {
      const { inPageDOMPruner, getIsolatedIndexMap } =
        await import('../entrypoints/background/tools/browser/dom-indexer');

      const editor = document.createElement('div');
      editor.setAttribute('contenteditable', 'true');
      editor.id = 'rich-editor';
      document.body.appendChild(editor);

      editor.getBoundingClientRect = () =>
        ({
          x: 10,
          y: 10,
          left: 10,
          top: 10,
          right: 300,
          bottom: 100,
          width: 290,
          height: 90,
          toJSON: () => ({}),
        }) as DOMRect;

      let keydownEnterCount = 0;
      editor.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') keydownEnterCount++;
      });

      try {
        inPageDOMPruner();
        const map = getIsolatedIndexMap();
        let editorIndex = 0;
        for (const [idx, ref] of map.entries()) {
          const el = ref?.deref ? ref.deref() : ref;
          if (el?.id === 'rich-editor') {
            editorIndex = idx;
            break;
          }
        }
        expect(editorIndex).toBeGreaterThan(0);

        const result = inPageFillIndex(editorIndex, 'Line 1\nLine 2\nLine 3', true, false);
        expect(result.success).toBe(true);
        expect(keydownEnterCount).toBeGreaterThanOrEqual(2);
      } finally {
        editor.remove();
      }
    });
  });

  describe('3. Native Media Injection (inPageInsertMedia)', () => {
    it('dispatches paste and drop events with real DataTransfer and File objects', () => {
      const composer = document.createElement('div');
      composer.setAttribute('contenteditable', 'true');
      composer.id = 'composer-target';
      document.body.appendChild(composer);

      let pasteFired = false;
      let fileReceived: any = null;

      composer.addEventListener('paste', (e: any) => {
        pasteFired = true;
        if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length > 0) {
          fileReceived = e.clipboardData.files[0];
        }
      });

      // Sample 1x1 transparent PNG base64
      const sampleBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

      try {
        const res = inPageInsertMedia({
          selector: '#composer-target',
          base64Data: sampleBase64,
          fileName: 'test-diagram.png',
          mimeType: 'image/png',
        });

        expect(res.success).toBe(true);
        expect(pasteFired).toBe(true);
        expect(fileReceived).toBeDefined();
        expect(fileReceived?.name).toBe('test-diagram.png');
        expect(fileReceived?.type).toBe('image/png');
      } finally {
        composer.remove();
      }
    });
  });
});
