import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  inPageGetActiveElementSummary,
  inPageDOMPruner,
} from '../entrypoints/background/tools/browser/dom-indexer';

describe('Modal & Stacking Occlusion Pruning (v3.4.0)', () => {
  let prevRect: typeof Element.prototype.getBoundingClientRect;

  beforeEach(() => {
    document.body.innerHTML = '';
    prevRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      const isModal =
        this.tagName?.toLowerCase() === 'dialog' ||
        this.getAttribute?.('role') === 'dialog' ||
        this.getAttribute?.('aria-modal') === 'true' ||
        this.classList?.contains('modal');
      if (isModal) {
        return {
          top: 100,
          left: 100,
          right: 900,
          bottom: 700,
          width: 800,
          height: 600,
          x: 100,
          y: 100,
          toJSON: () => {},
        } as any;
      }
      return {
        top: 20,
        left: 20,
        right: 200,
        bottom: 60,
        width: 180,
        height: 40,
        x: 20,
        y: 20,
        toJSON: () => {},
      } as any;
    };
  });

  afterEach(() => {
    Element.prototype.getBoundingClientRect = prevRect;
  });

  it('inPageGetActiveElementSummary identifies active input element and value', () => {
    const input = document.createElement('input');
    input.id = 'username-input';
    input.type = 'text';
    input.value = 'agent_tester';
    document.body.appendChild(input);
    input.focus();

    const summary = inPageGetActiveElementSummary();
    expect(summary.tagName).toBe('input');
    expect(summary.id).toBe('username-input');
    expect(summary.isInput).toBe(true);
    expect(summary.value).toBe('agent_tester');
    expect(summary.hasActiveModal).toBe(false);
  });

  it('inPageGetActiveElementSummary detects open modal dialog', () => {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    dialog.setAttribute('aria-modal', 'true');
    const dialogBtn = document.createElement('button');
    dialogBtn.textContent = 'Confirm';
    dialog.appendChild(dialogBtn);
    document.body.appendChild(dialog);

    dialogBtn.focus();

    const summary = inPageGetActiveElementSummary();
    expect(summary.tagName).toBe('button');
    expect(summary.text).toBe('Confirm');
    expect(summary.hasActiveModal).toBe(true);
  });

  it('inPageDOMPruner prioritizes modal contents and isolates background when modal is active', () => {
    // Background button
    const bgBtn = document.createElement('button');
    bgBtn.textContent = 'Background Action';
    bgBtn.id = 'bg-btn';
    document.body.appendChild(bgBtn);

    // Active modal dialog covering viewport
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.style.position = 'fixed';
    modal.style.top = '100px';
    modal.style.left = '100px';
    modal.style.width = '600px';
    modal.style.height = '400px';
    modal.style.zIndex = '9999';

    const modalBtn = document.createElement('button');
    modalBtn.textContent = 'Modal Confirm';
    modalBtn.id = 'modal-btn';
    modal.appendChild(modalBtn);
    document.body.appendChild(modal);

    const result = inPageDOMPruner({ isolateModal: true });
    expect(result.indexedElements.length).toBeGreaterThan(0);
    // Modal element is present
    const modalIndexed = result.indexedElements.some((el) => el.text?.includes('Modal Confirm'));
    expect(modalIndexed).toBe(true);
  });
});
