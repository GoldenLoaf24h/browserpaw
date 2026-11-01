import { describe, it, expect, beforeEach } from 'vitest';
import {
  SnapshotCacheManager,
  snapshotCacheManager,
  isClockOrTimerNoise,
  isNoiseElement,
  compactDeltaElement,
  DEFAULT_MAX_DELTA_CHANGES,
} from '../utils/snapshot-cache-manager';
import { captureDeltaIfRequested } from '../utils/delta-helper';
import * as engine from '../entrypoints/background/tools/browser/in-page-engine';
import { vi } from 'vitest';

describe('Delta Hardening (Anti-Explosion & Noise Gating)', () => {
  let manager: SnapshotCacheManager;

  beforeEach(() => {
    manager = new SnapshotCacheManager();
    vi.restoreAllMocks();
  });

  describe('isClockOrTimerNoise', () => {
    it('identifies standard countdown timers as noise', () => {
      expect(isClockOrTimerNoise('00:15:23', '00:15:22')).toBe(true);
      expect(isClockOrTimerNoise('15:23', '15:22')).toBe(true);
      expect(isClockOrTimerNoise('10s', '9s')).toBe(true);
      expect(isClockOrTimerNoise('59秒', '58秒')).toBe(true);
      expect(isClockOrTimerNoise('倒计时 00:05', '倒计时 00:04')).toBe(true);
      expect(isClockOrTimerNoise('距结束 01:20:00', '距结束 01:19:59')).toBe(true);
      expect(isClockOrTimerNoise('ends in 00:10', 'ends in 00:09')).toBe(true);
      expect(isClockOrTimerNoise('12分30秒', '12分29秒')).toBe(true);
      expect(isClockOrTimerNoise('01小时23分45秒', '01小时23分44秒')).toBe(true);
      expect(isClockOrTimerNoise('秒杀 00:15:23', '秒杀 00:15:22')).toBe(true);
      expect(isClockOrTimerNoise('限时 05:00', '限时 04:59')).toBe(true);
      expect(isClockOrTimerNoise('距结束 2天05:12:30', '距结束 2天05:12:29')).toBe(true);
    });

    it('does not classify meaningful business content changes as clock noise', () => {
      expect(isClockOrTimerNoise('Total: $10', 'Total: $15')).toBe(false);
      expect(isClockOrTimerNoise('Items (3)', 'Items (2)')).toBe(false);
      expect(isClockOrTimerNoise('Submitting...', 'Success')).toBe(false);
      expect(isClockOrTimerNoise('Qty: 1', 'Qty: 2')).toBe(false);
    });
  });

  describe('isNoiseElement', () => {
    it('identifies ad banners, carousels, and feed recommendations as noise', () => {
      expect(isNoiseElement({ tagName: 'div', attributes: { class: 'guess-you-like' } })).toBe(
        true,
      );
      expect(isNoiseElement({ tagName: 'div', attributes: { id: 'jdccm-elevator' } })).toBe(true);
      expect(isNoiseElement({ tagName: 'div', attributes: { class: 'ad-banner-top' } })).toBe(true);
      expect(isNoiseElement({ tagName: 'ins', attributes: { class: 'adsbygoogle' } })).toBe(true);
      expect(isNoiseElement({ tagName: 'div', attributes: { class: 'feed-item-wrapper' } })).toBe(
        true,
      );
    });

    it('preserves user input and form elements even with noisy classes', () => {
      expect(isNoiseElement({ tagName: 'input', attributes: { class: 'feed-item' } })).toBe(false);
      expect(
        isNoiseElement({ tagName: 'textarea', attributes: { id: 'recommend-feedback' } }),
      ).toBe(false);
      expect(isNoiseElement({ tagName: 'select', attributes: { class: 'ad-filter' } })).toBe(false);
    });
  });

  describe('compactDeltaElement', () => {
    it('prunes bulky internal objects and keeps essential attributes and hints', () => {
      const el = {
        index: 10,
        tagName: 'button',
        role: 'button',
        text: 'Delete Item',
        value: undefined,
        attributes: {
          id: 'btn-del',
          type: 'button',
          class: 'btn btn-danger',
          'data-v-1234567': 'internal-vue-hash',
          'data-spm-anchor': 'deep-tracking-string',
        },
        rect: { x: 100, y: 200, width: 80, height: 35 },
        isInteractive: true,
        isOccluded: false,
        safeClickPoint: { x: 140, y: 217 },
        diffHints: { oldText: 'Remove' },
      };

      const compacted = compactDeltaElement(el);

      expect(compacted.index).toBe(10);
      expect(compacted.tagName).toBe('button');
      expect(compacted.text).toBe('Delete Item');
      expect(compacted.attributes?.id).toBe('btn-del');
      expect(compacted.attributes?.type).toBe('button');
      expect(compacted.attributes?.class).toBe('btn btn-danger');
      expect(compacted.attributes?.['data-v-1234567']).toBeUndefined();
      expect(compacted.rect).toBeUndefined();
      expect(compacted.safeClickPoint).toBeUndefined();
      expect(compacted.diffHints?.oldText).toBe('Remove');
    });
  });

  describe('diffWithPrevious Hardening', () => {
    it('filters out ticking timer countdowns so DOM reports unchanged', () => {
      const baseline = [
        { index: 1, tagName: 'button', text: 'Clean Cart', isInteractive: true },
        { index: 2, tagName: 'span', text: '00:15:23', isInteractive: false },
      ];
      manager.setSnapshot(1, { url: 'https://jd.com/cart', elementCount: 2, elements: baseline });

      // Only the countdown timer ticked down by 1 second
      const next = [
        { index: 1, tagName: 'button', text: 'Clean Cart', isInteractive: true },
        { index: 2, tagName: 'span', text: '00:15:22', isInteractive: false },
      ];

      const diff = manager.diffWithPrevious(1, next);
      expect(diff.isDelta).toBe(true);
      expect(diff.unchanged).toBe(true);
      expect(diff.modified).toHaveLength(0);
    });

    it('caps delta at DEFAULT_MAX_DELTA_CHANGES when a large surge of changes occurs', () => {
      const baseline = [{ index: 1, tagName: 'div', text: 'Root', isInteractive: false }];
      manager.setSnapshot(1, { url: 'https://jd.com', elementCount: 1, elements: baseline });

      // 60 elements added
      const next = [
        { index: 1, tagName: 'div', text: 'Root', isInteractive: false },
        ...Array.from({ length: 60 }, (_, i) => ({
          index: i + 2,
          tagName: 'button',
          text: `Button ${i}`,
          isInteractive: true,
        })),
      ];

      const diff = manager.diffWithPrevious(1, next);
      expect(diff.isDelta).toBe(true);
      expect(diff.truncated).toBe(true);
      expect(diff.totalAdded).toBe(60);
      expect(diff.added).toHaveLength(DEFAULT_MAX_DELTA_CHANGES);
      expect(diff.summary).toContain(
        `Delta truncated: showing ${DEFAULT_MAX_DELTA_CHANGES}/60 added`,
      );
    });

    it('truncates initial baseline elements if diff is called on massive page without prior snapshot', () => {
      const manyElements = Array.from({ length: 100 }, (_, i) => ({
        index: i + 1,
        tagName: 'div',
        text: `Item ${i}`,
        isInteractive: true,
      }));

      const diff = manager.diffWithPrevious(1, manyElements);
      expect(diff.isDelta).toBe(false);
      expect(diff.truncated).toBe(true);
      expect(diff.added).toHaveLength(DEFAULT_MAX_DELTA_CHANGES);
      expect(diff.totalAdded).toBe(100);
    });
  });

  describe('captureDeltaIfRequested Protection', () => {
    it('returns empty added array on initial capture when no baseline exists to prevent 96KB payload dump', async () => {
      const fakeElements = Array.from({ length: 500 }, (_, i) => ({
        index: i + 1,
        tagName: 'div',
        text: `Node ${i}`,
        isInteractive: true,
      }));

      vi.spyOn(engine, 'executeInPage').mockResolvedValue([
        {
          frameId: 0,
          result: {
            treeString: '...',
            elementCount: 500,
            interactiveCount: 500,
            compressionRatio: 0.8,
            indexMap: {},
            indexedElements: fakeElements,
          },
        },
      ] as any);

      // Chrome tabs API mock
      (globalThis as any).chrome = {
        webNavigation: { getAllFrames: vi.fn(async () => [{ frameId: 0 }]) },
        tabs: {
          get: vi.fn().mockResolvedValue({ url: 'https://jd.com/cart' }),
        },
      };

      const result = await captureDeltaIfRequested(42, true);
      expect(result).toBeDefined();
      expect(result?.isDelta).toBe(false);
      expect(result?.added).toHaveLength(0);
      expect(result?.message).toContain('Baseline snapshot established');
      expect(result?.totalCurrent).toBe(500);
    });
  });

  describe('readDOMTool Delta Truncation Preservation', () => {
    it('preserves truncation metadata in chrome_read_dom delta response', async () => {
      const { readDOMTool } = await import('../entrypoints/background/tools/browser/read-dom');
      const baseline = [{ index: 1, tagName: 'button', text: 'Checkout', isInteractive: true }];
      snapshotCacheManager.setSnapshot(99, {
        url: 'https://jd.com/cart',
        elementCount: 1,
        elements: baseline,
      });

      const current = [
        { index: 1, tagName: 'button', text: 'Checkout', isInteractive: true },
        ...Array.from({ length: 60 }, (_, i) => ({
          index: i + 2,
          tagName: 'button',
          text: `Dynamic Item ${i}`,
          isInteractive: true,
        })),
      ];

      vi.spyOn(engine, 'executeInPage').mockResolvedValue([
        {
          frameId: 0,
          result: {
            treeString: '...',
            elementCount: 61,
            interactiveCount: 61,
            compressionRatio: 0.5,
            indexMap: {},
            indexedElements: current,
          },
        },
      ] as any);

      (readDOMTool as any).resolveAffinityTab = async () => ({
        id: 99,
        url: 'https://jd.com/cart',
        title: 'Cart',
      });

      const response = await readDOMTool.execute({ deltaOnly: true, tabId: 99 });
      const payload = JSON.parse(response.content[0].text);

      expect(payload.isDelta).toBe(true);
      expect(payload.truncated).toBe(true);
      expect(payload.addedCount).toBe(25);
      expect(payload.totalAdded).toBe(60);
      expect(payload.summary).toContain('Delta truncated');
    });
  });
});
