import { describe, it, expect, beforeEach, vi } from 'vitest';
import { scrubUrl } from '../utils/url-sanitizer';
import { snapshotCacheManager, computeScopeHash } from '../utils/snapshot-cache-manager';
import {
  safePostMessage,
  ChunkReassembler,
  CHUNK_THRESHOLD_BYTES,
  CHUNK_SIZE,
} from '../utils/safe-post-message';
import {
  inPageDOMPruner,
  inPageGetElementCoordinates,
  inPageInteractIndex,
  inPageFillIndex,
  inPageDispatchInputEvents,
  getIndexFingerprintMap,
  getIsolatedIndexMap,
  wrapElement,
} from '../entrypoints/background/tools/browser/dom-indexer';
import {
  BaseWatchdog,
  WatchdogCluster,
  DialogWatchdog,
  DownloadsWatchdog,
  CrashWatchdog,
} from '../entrypoints/background/watchdogs';

describe('Architectural Upgrade Verification Suite (B1-B12)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    getIndexFingerprintMap().clear();
    getIsolatedIndexMap().clear();
  });

  describe('Task B9: URL Sanitizer & Secret Scrubbing', () => {
    it('scrubs sensitive tokens, oauth codes, api keys, and passwords from URLs', () => {
      const dirtyUrl =
        'https://api.example.com/oauth/callback?code=abc123secret&access_token=ya29.xyz456&state=ok&client_secret=supersecret#id_token=jwt789';
      const clean = scrubUrl(dirtyUrl);
      expect(clean).toContain('code=REDACTED');
      expect(clean).toContain('access_token=REDACTED');
      expect(clean).toContain('client_secret=REDACTED');
      expect(clean).toContain('state=ok');
      expect(clean).not.toContain('abc123secret');
      expect(clean).not.toContain('supersecret');
      expect(clean).not.toContain('jwt789');
    });

    it('preserves clean URLs unchanged', () => {
      const cleanUrl = 'https://example.com/search?q=browserpaw&page=2';
      expect(scrubUrl(cleanUrl)).toBe(cleanUrl);
    });
  });

  describe('Task B1: Local Scope Guard & Scope Hash', () => {
    it('computes deterministic djb2 scopeHash for container text', () => {
      const text1 = 'User Profile Settings Form';
      const hash1 = computeScopeHash(text1);
      const hash2 = computeScopeHash(text1);
      expect(hash1).toBeTruthy();
      expect(hash1).toBe(hash2);
      expect(computeScopeHash('Different text')).not.toBe(hash1);
    });

    it('validates scope validity via SnapshotCacheManager when global snapshot is invalidated', () => {
      const tabId = 42;
      const text = 'Stable Form Container Text';
      const scopeHash = computeScopeHash(text);

      snapshotCacheManager.setSnapshot(tabId, {
        url: 'https://example.com/form',
        elementCount: 1,
        elements: [
          {
            index: 1,
            tagName: 'input',
            role: 'textbox',
            isInteractive: true,
            attributes: { 'data-scope-hash': scopeHash },
          } as any,
        ],
      });

      expect(snapshotCacheManager.isSnapshotValid(tabId)).toBe(true);
      expect(snapshotCacheManager.isScopeValid(tabId, 1, scopeHash)).toBe(true);

      // Invalidate snapshot globally due to a clock/timer tick elsewhere
      snapshotCacheManager.invalidate(tabId, 'Countdown timer tick');
      expect(snapshotCacheManager.isSnapshotValid(tabId)).toBe(false);

      // Local Scope Guard preserves interaction if container text scopeHash has not mutated
      expect(snapshotCacheManager.isScopeValid(tabId, 1, scopeHash)).toBe(true);
      // Mismatched container hash fails scope validation
      expect(snapshotCacheManager.isScopeValid(tabId, 1, 'mutated_hash')).toBe(false);
    });
  });

  describe('Task B7: Form Control Descendant Penetration Filter', () => {
    it('eliminates outer label/span/div wrapper index noise when wrapping an input', () => {
      document.body.innerHTML = `
        <label id="outer-label" class="checkbox-wrapper">
          <span class="label-text">Accept Terms</span>
          <input type="checkbox" id="inner-checkbox" />
        </label>
      `;

      // Mock bounding rects for visibility
      const label = document.getElementById('outer-label')!;
      const checkbox = document.getElementById('inner-checkbox')!;
      vi.spyOn(label, 'getBoundingClientRect').mockReturnValue({
        x: 10,
        y: 10,
        width: 120,
        height: 30,
        top: 10,
        left: 10,
        bottom: 40,
        right: 130,
        toJSON: () => {},
      } as any);
      vi.spyOn(checkbox, 'getBoundingClientRect').mockReturnValue({
        x: 15,
        y: 15,
        width: 20,
        height: 20,
        top: 15,
        left: 15,
        bottom: 35,
        right: 35,
        toJSON: () => {},
      } as any);

      const res = inPageDOMPruner(true, undefined, undefined, 'compact');
      // Checkbox is indexed, while outer label wrapper is penetrated/skipped
      expect(res.treeString).toContain('checkbox');
      expect(res.treeString).not.toContain('label');
    });
  });

  describe('Task B4: Native <select> Options Static Flattening & Single-Step Selection', () => {
    it('flattens native select options into virtual entries and allows single-step selection', () => {
      document.body.innerHTML = `
        <form>
          <select id="country" name="country">
            <option value="us">United States</option>
            <option value="ca">Canada</option>
            <option value="uk">United Kingdom</option>
          </select>
        </form>
      `;

      const select = document.getElementById('country') as HTMLSelectElement;
      vi.spyOn(select, 'getBoundingClientRect').mockReturnValue({
        x: 50,
        y: 50,
        width: 150,
        height: 35,
        top: 50,
        left: 50,
        bottom: 85,
        right: 200,
        toJSON: () => {},
      } as any);

      const res = inPageDOMPruner(true, undefined, undefined, 'compact');
      expect(res.treeString).toContain('combobox');
      expect(res.treeString).toContain('country → United States');
      expect(res.treeString).toContain('country → Canada');
      expect(res.treeString).toContain('country → United Kingdom');

      // Find the index for Canada (value="ca")
      const canadaElem = res.indexedElements.find((e) => e.text?.includes('Canada'));
      expect(canadaElem).toBeDefined();
      const canadaIdx = canadaElem!.index;

      let changeFired = false;
      let inputFired = false;
      select.addEventListener('change', () => {
        changeFired = true;
      });
      select.addEventListener('input', () => {
        inputFired = true;
      });

      // Direct single-step click interaction
      const interactRes = inPageInteractIndex(canadaIdx, 'click');
      expect(interactRes.success).toBe(true);
      expect(select.value).toBe('ca');
      expect(changeFired).toBe(true);
      expect(inputFired).toBe(true);
    });
  });

  describe('Task B3: Controlled Component Input Commitment & Dispatch', () => {
    it('dispatches bubbling input and change events in inPageFillIndex and inPageDispatchInputEvents', () => {
      document.body.innerHTML = `
        <input type="text" id="username" />
      `;
      const input = document.getElementById('username') as HTMLInputElement;
      vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({
        x: 10,
        y: 10,
        width: 100,
        height: 30,
        top: 10,
        left: 10,
        bottom: 40,
        right: 110,
        toJSON: () => {},
      } as any);

      const res = inPageDOMPruner(true, undefined, undefined, 'compact');
      const idx = res.indexedElements[0].index;

      let inputEventsCount = 0;
      let changeEventsCount = 0;
      input.addEventListener('input', () => {
        inputEventsCount++;
      });
      input.addEventListener('change', () => {
        changeEventsCount++;
      });

      inPageFillIndex(idx, 'hello_antigravity');
      expect(input.value).toBe('hello_antigravity');
      expect(inputEventsCount).toBeGreaterThan(0);
      expect(changeEventsCount).toBeGreaterThan(0);

      // inPageDispatchInputEvents explicitly fires synthetic bubbling input/change
      const dispatchRes = inPageDispatchInputEvents(idx);
      expect(dispatchRes.success).toBe(true);
      expect(inputEventsCount).toBeGreaterThanOrEqual(2);
      expect(changeEventsCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Task B12: Index Drift Self-Healing', () => {
    it('detects index drift and recovers target using element fingerprint with warning', () => {
      document.body.innerHTML = `
        <div id="container">
          <button id="submit-btn" data-testid="submit-action">Submit Order</button>
        </div>
      `;
      const btn = document.getElementById('submit-btn')!;
      vi.spyOn(btn, 'getBoundingClientRect').mockReturnValue({
        x: 20,
        y: 20,
        width: 80,
        height: 30,
        top: 20,
        left: 20,
        bottom: 50,
        right: 100,
        toJSON: () => {},
      } as any);

      const res = inPageDOMPruner(true, undefined, undefined, 'compact');
      const idx = res.indexedElements[0].index;

      // Simulate React/Vue re-rendering: replace button element with identical fingerprint
      const newBtn = document.createElement('button');
      newBtn.id = 'submit-btn';
      newBtn.setAttribute('data-testid', 'submit-action');
      newBtn.textContent = 'Submit Order';
      vi.spyOn(newBtn, 'getBoundingClientRect').mockReturnValue({
        x: 20,
        y: 20,
        width: 80,
        height: 30,
        top: 20,
        left: 20,
        bottom: 50,
        right: 100,
        toJSON: () => {},
      } as any);
      btn.replaceWith(newBtn);

      // Now the weakref/original element in the map is detached
      const coords = inPageGetElementCoordinates(idx);
      expect(coords.success).toBe(true);
      expect(coords.warning).toContain('auto-healed target using element fingerprint');
    });
  });

  describe('Task B8: Native Messaging Chunking & Reassembly', () => {
    it('chunks messages >= 950KB and safely reassembles them', () => {
      const bigString = 'x'.repeat(1_200_000); // 1.2MB payload
      const originalMessage = {
        type: 'big_data',
        requestId: 'req_123',
        payload: { content: bigString },
      };

      const postedMessages: any[] = [];
      const mockPort: any = {
        postMessage: (m: any) => {
          postedMessages.push(m);
        },
      };

      const ok = safePostMessage(mockPort, originalMessage);
      expect(ok).toBe(true);
      expect(postedMessages.length).toBeGreaterThan(1);
      expect(postedMessages[0].__chunked__).toBe(true);
      expect(postedMessages[0].total).toBe(postedMessages.length);

      // Reassemble
      const reassembler = new ChunkReassembler();
      let assembledMessage: any = null;

      for (const chunk of postedMessages) {
        reassembler.processMessage(chunk, (full) => {
          assembledMessage = full;
        });
      }

      expect(assembledMessage).toBeDefined();
      expect(assembledMessage.type).toBe('big_data');
      expect(assembledMessage.payload.content.length).toBe(1_200_000);
    });
  });

  describe('Task B11: Watchdog Cluster & Decoupled Event Bus', () => {
    it('starts, stops, and propagates events across decoupled watchdogs', () => {
      const cluster = new WatchdogCluster();
      const dialogWd = cluster.getWatchdog<DialogWatchdog>('dialog')!;
      const downloadsWd = cluster.getWatchdog<DownloadsWatchdog>('downloads')!;
      const crashWd = cluster.getWatchdog<CrashWatchdog>('crash')!;

      expect(dialogWd).toBeDefined();
      expect(downloadsWd).toBeDefined();
      expect(crashWd).toBeDefined();

      let eventReceived = false;
      const unsubscribe = dialogWd.on('dialog-opened', (ev) => {
        expect(ev.tabId).toBe(101);
        eventReceived = true;
      });

      dialogWd.emit('dialog-opened', { tabId: 101, timestamp: Date.now() });
      expect(eventReceived).toBe(true);

      unsubscribe();
      eventReceived = false;
      dialogWd.emit('dialog-opened', { tabId: 101, timestamp: Date.now() });
      expect(eventReceived).toBe(false);
    });

    it('enforces required CDP event subscriptions via listensTo property', () => {
      const cluster = new WatchdogCluster();
      const dialogWd = cluster.getWatchdog<DialogWatchdog>('dialog')!;
      const downloadsWd = cluster.getWatchdog<DownloadsWatchdog>('downloads')!;
      const crashWd = cluster.getWatchdog<CrashWatchdog>('crash')!;

      expect(dialogWd.listensTo).toEqual([
        'Page.javascriptDialogOpening',
        'Page.javascriptDialogClosed',
      ]);
      expect(downloadsWd.listensTo).toEqual([
        'chrome.downloads.onCreated',
        'chrome.downloads.onChanged',
      ]);
      expect(crashWd.listensTo).toEqual([
        'Inspector.targetCrashed',
        'webNavigation.onErrorOccurred',
        'tabs.onRemoved',
      ]);
    });
  });

  describe('Refined Architectural Parity & Hardening Fixes', () => {
    it('Task B1 Live Extraction: inPageGetElementCoordinates extracts scopeHash for container validation', () => {
      document.body.innerHTML = `
        <div id="checkout-container">
          <h2>Shipping Address Section</h2>
          <input type="text" id="postal-code" />
        </div>
      `;
      const input = document.getElementById('postal-code') as HTMLInputElement;
      vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({
        x: 10,
        y: 10,
        width: 100,
        height: 30,
        top: 10,
        left: 10,
        bottom: 40,
        right: 110,
        toJSON: () => {},
      } as any);

      const res = inPageDOMPruner(true, undefined, undefined, 'compact');
      const idx = res.indexedElements[0].index;

      const coords = inPageGetElementCoordinates(idx);
      expect(coords.success).toBe(true);
      expect(coords.scopeHash).toBeDefined();
      expect(typeof coords.scopeHash).toBe('string');
      expect(coords.scopeHash!.length).toBeGreaterThan(0);

      // Register snapshot and verify scope validity
      const tabId = 999;
      snapshotCacheManager.setSnapshot(tabId, {
        url: 'https://example.com/checkout',
        elementCount: 1,
        elements: [
          {
            index: idx,
            tagName: 'input',
            role: 'textbox',
            isInteractive: true,
            attributes: { 'data-scope-hash': coords.scopeHash },
          } as any,
        ],
      });

      // Valid initially
      expect(snapshotCacheManager.isScopeValid(tabId, idx, coords.scopeHash)).toBe(true);
      // Invalidate snapshot globally (e.g. clock ticker)
      snapshotCacheManager.invalidate(tabId, 'External update');
      // Local Scope Guard ensures the unchanged container is still considered valid
      expect(snapshotCacheManager.isScopeValid(tabId, idx, coords.scopeHash)).toBe(true);
      // Mismatched container text fails
      expect(snapshotCacheManager.isScopeValid(tabId, idx, 'altered_hash')).toBe(false);
    });

    it('Task B12: self-heals elements using text content alone when ID and data-testid are missing', () => {
      document.body.innerHTML = `
        <div class="actions">
          <button class="btn primary">Proceed to Final Step</button>
        </div>
      `;
      const btn = document.querySelector('button')!;
      vi.spyOn(btn, 'getBoundingClientRect').mockReturnValue({
        x: 15,
        y: 15,
        width: 140,
        height: 32,
        top: 15,
        left: 15,
        bottom: 47,
        right: 155,
        toJSON: () => {},
      } as any);

      const res = inPageDOMPruner(true, undefined, undefined, 'compact');
      const idx = res.indexedElements[0].index;

      // Replace button with identical text button (no ID, no data-testid)
      const freshBtn = document.createElement('button');
      freshBtn.className = 'btn primary';
      freshBtn.textContent = 'Proceed to Final Step';
      vi.spyOn(freshBtn, 'getBoundingClientRect').mockReturnValue({
        x: 15,
        y: 15,
        width: 140,
        height: 32,
        top: 15,
        left: 15,
        bottom: 47,
        right: 155,
        toJSON: () => {},
      } as any);
      btn.replaceWith(freshBtn);

      const coords = inPageGetElementCoordinates(idx);
      expect(coords.success).toBe(true);
      expect(coords.warning).toContain('auto-healed target using element fingerprint');
      expect(coords.text).toContain('Proceed to Final Step');
    });

    it('Task B7: penetrates button wrapper containers', () => {
      document.body.innerHTML = `
        <div class="custom-button-wrapper" role="button" tabindex="0">
          <button id="real-action-btn">Action Button</button>
        </div>
      `;
      const wrapper = document.querySelector('.custom-button-wrapper')!;
      const innerBtn = document.getElementById('real-action-btn')!;
      vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue({
        x: 10,
        y: 10,
        width: 120,
        height: 40,
        top: 10,
        left: 10,
        bottom: 50,
        right: 130,
        toJSON: () => {},
      } as any);
      vi.spyOn(innerBtn, 'getBoundingClientRect').mockReturnValue({
        x: 12,
        y: 12,
        width: 116,
        height: 36,
        top: 12,
        left: 12,
        bottom: 48,
        right: 128,
        toJSON: () => {},
      } as any);

      const res = inPageDOMPruner(true, undefined, undefined, 'compact');
      // Inner button is indexed, outer wrapper is penetrated
      expect(res.treeString).toContain('button');
      expect(res.indexedElements.some((e) => e.tagName === 'button')).toBe(true);
    });

    it('Task B4: flags option elements with isSelectOption for direct in-page execution', () => {
      document.body.innerHTML = `
        <select id="size-selector">
          <option value="s">Small</option>
          <option value="m">Medium</option>
          <option value="l">Large</option>
        </select>
      `;
      const select = document.getElementById('size-selector')!;
      vi.spyOn(select, 'getBoundingClientRect').mockReturnValue({
        x: 10,
        y: 10,
        width: 80,
        height: 30,
        top: 10,
        left: 10,
        bottom: 40,
        right: 90,
        toJSON: () => {},
      } as any);

      const res = inPageDOMPruner(true, undefined, undefined, 'compact');
      const mediumOpt = res.indexedElements.find((e) => e.text?.includes('Medium'))!;
      expect(mediumOpt).toBeDefined();

      const coords = inPageGetElementCoordinates(mediumOpt.index);
      expect(coords.success).toBe(true);
      expect(coords.isSelectOption).toBe(true);
    });
  });
});
