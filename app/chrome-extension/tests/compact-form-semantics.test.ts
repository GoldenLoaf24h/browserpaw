import { describe, it, expect, afterEach } from 'vitest';
import {
  inPageDOMPruner,
  renderCompactElementLine,
} from '../entrypoints/background/tools/browser/dom-indexer';

function withStubbedGeometry() {
  const prevRect = Element.prototype.getBoundingClientRect;
  const prevStyle = window.getComputedStyle;
  window.getComputedStyle = ((el: Element, pseudo?: string | null) =>
    pseudo
      ? ({ getPropertyValue: () => '' } as unknown as CSSStyleDeclaration)
      : prevStyle(el)) as any;
  Element.prototype.getBoundingClientRect = function () {
    return {
      x: 10,
      y: 10,
      left: 10,
      top: 10,
      right: 210,
      bottom: 50,
      width: 200,
      height: 40,
      toJSON: () => ({}),
    } as DOMRect;
  };
  return () => {
    Element.prototype.getBoundingClientRect = prevRect;
    window.getComputedStyle = prevStyle;
  };
}

describe('compact form semantics', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders native label, value, validity, message, and focus in the default format', () => {
    const restore = withStubbedGeometry();
    try {
      document.body.innerHTML = `
        <label for="employee">Employee code</label>
        <input id="employee" name="employee" pattern="[A-Z]{3}" required value="nope">
      `;
      const input = document.getElementById('employee') as HTMLInputElement;
      input.focus();

      const res = inPageDOMPruner();
      const indexed = res.indexedElements?.find((el) => el.attributes.id === 'employee');
      const line = renderCompactElementLine(indexed!);

      expect(line).toContain('"Employee code"');
      expect(line).toContain('value="nope"');
      expect(line).toContain('invalid');
      expect(line).toContain('invalidReason="patternMismatch"');
      expect(line).toContain('validationMessage="');
      expect(line).toContain('focused');
      expect(res.treeString).toContain(line);
    } finally {
      restore();
    }
  });

  it('renders ARIA error and description associations for invalid custom fields', () => {
    const restore = withStubbedGeometry();
    try {
      document.body.innerHTML = `
        <label for="work">Work email</label>
        <input id="work" aria-invalid="true" aria-errormessage="work-error"
          aria-describedby="work-hint" value="person@example.com">
        <p id="work-error">Use your company email address.</p>
        <p id="work-hint">Used for account notices.</p>
      `;

      const res = inPageDOMPruner();
      const indexed = res.indexedElements?.find((el) => el.attributes.id === 'work');
      const line = renderCompactElementLine(indexed!);

      expect(line).toContain('"Work email"');
      expect(line).toContain('invalid');
      expect(line).toContain('errormessage="Use your company email address."');
      expect(line).toContain('description="Used for account notices."');
    } finally {
      restore();
    }
  });

  it('keeps password values masked and suppresses a label equal to the secret', () => {
    const restore = withStubbedGeometry();
    try {
      document.body.innerHTML = `
        <label for="password">hunter2</label>
        <input id="password" name="password" type="password" value="hunter2">
      `;

      const res = inPageDOMPruner();
      const indexed = res.indexedElements?.find((el) => el.attributes.id === 'password');
      const line = renderCompactElementLine(indexed!);

      expect(line).toContain('value="•••"');
      expect(line).not.toContain('hunter2');
    } finally {
      restore();
    }
  });

  it('does not repeat a label that exactly equals a non-secret value', () => {
    const restore = withStubbedGeometry();
    try {
      document.body.innerHTML = `
        <label for="coupon">SAVE10</label>
        <input id="coupon" value="SAVE10">
      `;

      const res = inPageDOMPruner();
      const indexed = res.indexedElements?.find((el) => el.attributes.id === 'coupon');
      const line = renderCompactElementLine(indexed!);

      expect(line.match(/SAVE10/g)).toHaveLength(1);
      expect(line).toContain('value="SAVE10"');
    } finally {
      restore();
    }
  });

  it('caps native select options at 50 and reports the omitted count and read path', () => {
    const restore = withStubbedGeometry();
    try {
      const options = Array.from(
        { length: 100 },
        (_, i) => `<option value="v${i + 1}">Option ${i + 1}</option>`,
      ).join('');
      document.body.innerHTML = `
        <label for="choice">Choice</label>
        <select id="choice" name="choice">${options}</select>
      `;

      const res = inPageDOMPruner();
      const indexedOptions = (res.indexedElements || []).filter(
        (el) => el.tagName === 'option' && el.attributes.selected !== undefined,
      );

      expect(indexedOptions).toHaveLength(50);
      expect(res.treeString).toContain('label="Choice"');
      expect(res.treeString).toContain('50 enabled options omitted');
      expect(res.treeString).toContain('get_dropdown_options');
      expect(res.treeString).toContain('index=');
      expect(res.treeString).not.toContain('Option 100');
    } finally {
      restore();
    }
  });
});
