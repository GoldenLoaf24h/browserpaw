import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computePerceptiveDelta,
  extractElementLocationDetails,
  findIndexedElement,
  getIsolatedIndexMap,
  inPageDOMPruner,
  inPageDetectPerceptiveSignature,
  inPageLocateByText,
  inPageVerifyInputCommitment,
  wrapElement,
} from '../entrypoints/background/tools/browser/dom-indexer';

describe('Input commitment and strict locator contracts', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    getIsolatedIndexMap().clear();
    vi.clearAllMocks();
  });

  it('verifies field commitment and associated submit state', () => {
    const form = document.createElement('form');
    const input = document.createElement('input');
    input.value = 'Hello World';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = 'Post';
    form.append(input, submit);
    document.body.appendChild(form);
    getIsolatedIndexMap().set(3, input);

    expect(inPageVerifyInputCommitment(3, 'Hello World')).toMatchObject({
      committed: true,
      currentValue: 'Hello World',
      submitButtonState: { found: true, disabled: false },
    });
  });

  it('rejects similar values, normalized whitespace, checkboxes, and selects correctly', () => {
    const input = document.createElement('input');
    input.value = 'hello abc';
    const composer = document.createElement('div');
    composer.setAttribute('contenteditable', 'true');
    composer.innerText = '\u200BHello\u00A0World\uFEFF';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    const select = document.createElement('select');
    select.append(new Option('United States', 'US'), new Option('China', 'CN'));
    select.value = 'CN';
    document.body.append(input, composer, checkbox, select);
    getIsolatedIndexMap().set(1, input);
    getIsolatedIndexMap().set(2, composer);
    getIsolatedIndexMap().set(3, checkbox);
    getIsolatedIndexMap().set(4, select);

    expect(inPageVerifyInputCommitment(1, 'hello xyz').committed).toBe(false);
    expect(inPageVerifyInputCommitment(2, 'Hello World').committed).toBe(true);
    expect(inPageVerifyInputCommitment(3, 'true').committed).toBe(true);
    expect(inPageVerifyInputCommitment(3, 'false').committed).toBe(false);
    expect(inPageVerifyInputCommitment(4, 'CN').committed).toBe(true);
    expect(inPageVerifyInputCommitment(4, 'China').committed).toBe(true);
    expect(inPageVerifyInputCommitment(4, 'Japan').committed).toBe(false);
  });

  it('detects perceptive changes while ignoring hidden ghost controls', () => {
    const hidden = document.createElement('div');
    hidden.setAttribute('aria-hidden', 'true');
    const hiddenInput = document.createElement('input');
    hiddenInput.name = 'ghostField';
    hidden.appendChild(hiddenInput);
    const active = document.createElement('input');
    active.name = 'activeField';
    document.body.append(hidden, active);
    for (const element of [hiddenInput, active]) {
      element.getBoundingClientRect = () =>
        ({ top: 100, bottom: 130, left: 20, right: 250, width: 230, height: 30 }) as DOMRect;
    }

    const signature = inPageDetectPerceptiveSignature();
    expect(signature.activeInputs.some((item) => item.name === 'ghostField')).toBe(false);
    expect(signature.activeInputs.some((item) => item.name === 'activeField')).toBe(true);
    expect(
      computePerceptiveDelta(
        { question: 'Final', progress: '5 / 5', activeInputs: [], alerts: [] },
        { activeInputs: [], alerts: [] },
      ),
    ).toMatchObject({ advanced: true, questionChanged: true, progressChanged: true });
  });

  it('prunes inert, hidden, and horizontally offscreen nodes', () => {
    const visible = document.createElement('button');
    visible.textContent = 'Visible';
    const hidden = document.createElement('div');
    hidden.setAttribute('inert', 'true');
    const ghost = document.createElement('button');
    ghost.textContent = 'Ghost';
    hidden.appendChild(ghost);
    const offscreen = document.createElement('button');
    offscreen.textContent = 'Offscreen';
    document.body.append(visible, hidden, offscreen);
    visible.getBoundingClientRect = () =>
      ({ top: 100, bottom: 130, left: 50, right: 150, width: 100, height: 30 }) as DOMRect;
    ghost.getBoundingClientRect = visible.getBoundingClientRect;
    offscreen.getBoundingClientRect = () =>
      ({ top: 100, bottom: 130, left: 2500, right: 2700, width: 200, height: 30 }) as DOMRect;

    const tree = inPageDOMPruner({ activeViewportOnly: true }).treeString;
    expect(tree).toContain('Visible');
    expect(tree).not.toContain('Ghost');
    expect(tree).not.toContain('Offscreen');
  });

  it('fails strict duplicate-text and hidden-container locators', () => {
    const first = document.createElement('button');
    first.textContent = 'Continue';
    const second = document.createElement('button');
    second.textContent = 'Continue';
    const hidden = document.createElement('div');
    hidden.setAttribute('aria-hidden', 'true');
    const hiddenButton = document.createElement('button');
    hiddenButton.textContent = 'Submit Hidden';
    hidden.appendChild(hiddenButton);
    document.body.append(first, second, hidden);
    first.getBoundingClientRect = () =>
      ({ top: -1500, bottom: -1450, left: 100, right: 200, width: 100, height: 50 }) as DOMRect;
    second.getBoundingClientRect = () =>
      ({ top: 200, bottom: 250, left: 100, right: 200, width: 100, height: 50 }) as DOMRect;
    hiddenButton.getBoundingClientRect = second.getBoundingClientRect;
    getIsolatedIndexMap().set(1, first);
    getIsolatedIndexMap().set(2, second);
    getIsolatedIndexMap().set(3, hiddenButton);

    expect(inPageLocateByText('Continue', 'button')).toMatchObject({
      success: false,
      matchCount: 2,
    });
    expect(inPageLocateByText('Submit Hidden', 'button').success).toBe(false);
  });

  it('keeps submit-button indexes distinct from their parent containers', () => {
    const form = document.createElement('form');
    const input = document.createElement('input');
    input.value = 'user@example.com';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = 'Continue';
    form.append(input, submit);
    document.body.appendChild(form);
    getIsolatedIndexMap().set(10, wrapElement(form));
    getIsolatedIndexMap().set(11, wrapElement(input));

    const verification = inPageVerifyInputCommitment(11, 'user@example.com');
    expect(verification.submitButtonState?.index).not.toBe(10);
    expect(verification.submitButtonState?.index).not.toBe(11);
    expect(findIndexedElement(verification.submitButtonState!.index!)).toBe(submit);
    expect(extractElementLocationDetails(submit).index).toBe(verification.submitButtonState?.index);
  });
});
