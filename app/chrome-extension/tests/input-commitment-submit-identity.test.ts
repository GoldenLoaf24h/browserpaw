import { afterEach, describe, expect, it } from 'vitest';
import {
  inPageVerifyInputCommitment,
  indexElement,
} from '../entrypoints/background/tools/browser/dom-indexer';
import { performPhysicalFill } from '../entrypoints/background/tools/browser/fill-core';

describe('input commitment submit identity', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('does not mistake a preceding close icon for the form submitter', () => {
    document.body.innerHTML = `
      <form id="profile-form">
        <button type="button" id="close-icon"><svg aria-hidden="true"></svg></button>
        <input id="display-name" name="displayName" value="" />
        <button type="submit" id="save-profile">Save profile</button>
      </form>
    `;
    const input = document.getElementById('display-name') as HTMLInputElement;
    input.value = 'Ada';

    const result = inPageVerifyInputCommitment(indexElement(input), 'Ada');

    expect(result.committed).toBe(true);
    expect(result.submitButtonState).toMatchObject({
      found: true,
      text: 'Save profile',
      index: indexElement(document.getElementById('save-profile')!),
    });
  });

  it('reports no submit identity when a form has multiple submit buttons', () => {
    document.body.innerHTML = `
      <form id="choice-form">
        <input id="choice-value" value="" />
        <button type="submit">Save draft</button>
        <button type="submit">Publish</button>
      </form>
    `;
    const input = document.getElementById('choice-value') as HTMLInputElement;
    input.value = 'ready';

    const result = inPageVerifyInputCommitment(indexElement(input), 'ready');

    expect(result.committed).toBe(true);
    expect(result.submitButtonState).toBeUndefined();
  });

  it('recognizes a submitter associated through the form attribute', () => {
    document.body.innerHTML = `
      <form id="account-form"></form>
      <input id="account-email" form="account-form" value="" />
      <button id="account-submit" form="account-form" type="submit">Continue</button>
    `;
    const input = document.getElementById('account-email') as HTMLInputElement;
    input.value = 'ada@example.com';

    const result = inPageVerifyInputCommitment(indexElement(input), 'ada@example.com');

    expect(result.committed).toBe(true);
    expect(result.submitButtonState).toMatchObject({
      found: true,
      disabled: false,
      text: 'Continue',
      index: indexElement(document.getElementById('account-submit')!),
    });
  });

  it('keeps field commitment successful when the associated submitter is disabled', () => {
    document.body.innerHTML = `
      <form id="pending-form">
        <input id="pending-email" value="" />
        <button type="submit" disabled>Continue</button>
      </form>
    `;
    const input = document.getElementById('pending-email') as HTMLInputElement;
    input.value = 'pending@example.com';

    const result = inPageVerifyInputCommitment(indexElement(input), 'pending@example.com');

    expect(result.committed).toBe(true);
    expect(result.submitButtonState).toMatchObject({
      found: true,
      disabled: true,
      text: 'Continue',
    });
  });

  it('does not fabricate a submit label for an icon-only native submitter', () => {
    document.body.innerHTML = `
      <form id="icon-form">
        <input id="icon-email" value="" />
        <button type="submit" id="icon-submit"><svg aria-hidden="true"></svg></button>
      </form>
    `;
    const input = document.getElementById('icon-email') as HTMLInputElement;
    input.value = 'ada@example.com';

    const result = inPageVerifyInputCommitment(indexElement(input), 'ada@example.com');

    expect(result.committed).toBe(true);
    expect(result.submitButtonState).toMatchObject({
      found: true,
      text: '',
      index: indexElement(document.getElementById('icon-submit')!),
    });
  });

  it('rejects Enter plus explicit submit before touching the field', async () => {
    const result = await performPhysicalFill({
      tabId: 1,
      target: 1,
      text: 'draft',
      pressEnter: true,
      submit: true,
      submitTarget: { index: 2 },
    });

    expect(result).toMatchObject({
      success: false,
      status: 'blocked',
      committed: false,
      interaction: {
        execution: { status: 'not_dispatched', dispatchedCount: 0 },
        verification: { status: 'not_requested' },
      },
    });
  });
});
