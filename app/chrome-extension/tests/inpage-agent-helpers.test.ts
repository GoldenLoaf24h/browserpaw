import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  wrapUserCode,
  MCP_INPAGE_HELPERS,
} from '../entrypoints/background/tools/browser/javascript';

describe('In-Page Agent Helpers & Workflows', () => {
  const evaluateInPage = async (code: string) => {
    const wrapped = wrapUserCode(code);
    // wrapUserCode returns `(async () => { ... })()`.
    // In browser/CDP Runtime.evaluate with awaitPromise: true, this evaluates to the promise result.
    // In Node/vitest, evaluating `eval(wrapped)` evaluates and returns the Promise.
    return await (0, eval)(wrapped);
  };

  let prevRect: typeof Element.prototype.getBoundingClientRect;

  beforeEach(() => {
    prevRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      return {
        x: 10,
        y: 10,
        left: 10,
        top: 10,
        right: 110,
        bottom: 50,
        width: 100,
        height: 40,
        toJSON: () => ({}),
      } as DOMRect;
    };
    document.body.innerHTML = '';
  });

  afterEach(() => {
    Element.prototype.getBoundingClientRect = prevRect;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  describe('mcp.run closure execution', () => {
    it('executes closure and provides mcp object with return value', async () => {
      document.body.innerHTML = `
        <div id="counter">5</div>
      `;

      const result = await evaluateInPage(`
        return await mcp.run(async (ctx) => {
          const text = ctx.extract('#counter', 'text');
          return { original: text, doubled: parseInt(text, 10) * 2 };
        });
      `);

      expect(result).toEqual({ original: '5', doubled: 10 });
    });
  });

  describe(':has-text pseudo selector', () => {
    it('matches elements using document.querySelector with :has-text("...")', async () => {
      document.body.innerHTML = `
        <button class="action-btn">Cancel</button>
        <button class="action-btn">Confirm Order</button>
        <div class="card"><p>Some text</p></div>
      `;

      const result = await evaluateInPage(`
        const btn = document.querySelector('button:has-text("Confirm Order")');
        const allBtns = document.querySelectorAll('button:has-text("Order")');
        return {
          btnTag: btn?.tagName,
          btnText: btn?.textContent,
          count: allBtns.length
        };
      `);

      expect(result.btnTag).toBe('BUTTON');
      expect(result.btnText).toBe('Confirm Order');
      expect(result.count).toBe(1);
    });

    it('matches scoped child elements via element.querySelector with :has-text', async () => {
      document.body.innerHTML = `
        <div id="modal-a">
          <button>Proceed</button>
        </div>
        <div id="modal-b">
          <button>Proceed</button>
        </div>
      `;

      const result = await evaluateInPage(`
        const modalB = document.getElementById('modal-b');
        const proceedInB = modalB.querySelector('button:has-text("Proceed")');
        return proceedInB ? proceedInB.parentElement.id : null;
      `);

      expect(result).toBe('modal-b');
    });
  });

  describe('mcp.query and mcp.queryAll with text filtering', () => {
    it('filters elements by regex pattern', async () => {
      document.body.innerHTML = `
        <div class="item">Item #101: Pending</div>
        <div class="item">Item #102: Complete</div>
        <div class="item">Item #103: Pending</div>
      `;

      const result = await evaluateInPage(`
        const pendingItems = mcp.queryAll('.item', /Pending/);
        const completeItem = mcp.query('.item', /Complete/);
        return {
          pendingCount: pendingItems.length,
          completeText: completeItem?.textContent?.trim()
        };
      `);

      expect(result.pendingCount).toBe(2);
      expect(result.completeText).toBe('Item #102: Complete');
    });

    it('finds element by text using findByText and findAllByText', async () => {
      document.body.innerHTML = `
        <span class="badge">Status: OK</span>
        <span class="badge">Status: ERROR</span>
      `;

      const result = await evaluateInPage(`
        const ok = mcp.findByText(/OK/, '.badge');
        const err = mcp.findAllByText('ERROR', '.badge');
        return {
          okFound: !!ok,
          errCount: err.length
        };
      `);

      expect(result.okFound).toBe(true);
      expect(result.errCount).toBe(1);
    });
  });

  describe('mcp.check, mcp.press, mcp.isVisible', () => {
    it('checks and unchecks checkbox while dispatching change and click events', async () => {
      document.body.innerHTML = `
        <input type="checkbox" id="agree" />
      `;
      const checkbox = document.getElementById('agree') as HTMLInputElement;
      const events: string[] = [];
      checkbox.addEventListener('input', () => events.push('input'));
      checkbox.addEventListener('change', () => events.push('change'));

      await evaluateInPage(`
        await mcp.check('#agree', true);
      `);

      expect(checkbox.checked).toBe(true);
      expect(events).toEqual(['input', 'change']);

      // Uncheck
      await evaluateInPage(`
        await mcp.check('#agree', false);
      `);
      expect(checkbox.checked).toBe(false);
    });

    it('dispatches key events via mcp.press', async () => {
      document.body.innerHTML = `
        <input type="text" id="search" />
      `;
      const input = document.getElementById('search') as HTMLInputElement;
      const keysPressed: string[] = [];
      input.addEventListener('keydown', (e) => keysPressed.push(e.key));

      await evaluateInPage(`
        await mcp.press('Enter', '#search');
      `);

      expect(keysPressed).toEqual(['Enter']);
    });

    it('evaluates element visibility correctly', async () => {
      document.body.innerHTML = `
        <div id="hidden-display" style="display: none;">Hidden 1</div>
        <div id="hidden-visibility" style="visibility: hidden;">Hidden 2</div>
        <div id="visible-item">Visible Item</div>
      `;

      // Mock getBoundingClientRect for JSDOM
      const visibleEl = document.getElementById('visible-item')!;
      visibleEl.getBoundingClientRect = () => ({
        width: 100,
        height: 50,
        top: 0,
        left: 0,
        bottom: 50,
        right: 100,
        x: 0,
        y: 0,
        toJSON: () => {},
      });

      const result = await evaluateInPage(`
        return {
          hiddenDisplay: mcp.isVisible('#hidden-display'),
          hiddenVis: mcp.isVisible('#hidden-visibility'),
          visible: mcp.isVisible('#visible-item')
        };
      `);

      expect(result.hiddenDisplay).toBe(false);
      expect(result.hiddenVis).toBe(false);
      expect(result.visible).toBe(true);
    });
  });

  describe('mcp.waitFor and mcp.click with waitFor', () => {
    it('waits for predicate to resolve true', async () => {
      let ready = false;
      setTimeout(() => {
        ready = true;
      }, 50);

      (window as any).__testReady = () => ready;

      const result = await evaluateInPage(`
        await mcp.waitFor(() => window.__testReady(), 500, 20);
        return true;
      `);

      expect(result).toBe(true);
    });

    it('waits for element selector to appear dynamically', async () => {
      setTimeout(() => {
        const div = document.createElement('div');
        div.id = 'async-loaded-box';
        div.textContent = 'Dynamic Content';
        document.body.appendChild(div);
      }, 50);

      const result = await evaluateInPage(`
        const el = await mcp.waitFor('#async-loaded-box', 500, 20);
        return el ? el.textContent : null;
      `);

      expect(result).toBe('Dynamic Content');
    });

    it('mcp.click with waitFor waits for target element', async () => {
      setTimeout(() => {
        const btn = document.createElement('button');
        btn.id = 'deferred-btn';
        btn.textContent = 'Click me';
        btn.onclick = () => {
          btn.setAttribute('data-clicked', 'true');
        };
        document.body.appendChild(btn);
      }, 40);

      await evaluateInPage(`
        await mcp.click('#deferred-btn', { waitFor: 500 });
      `);

      const btn = document.getElementById('deferred-btn');
      expect(btn?.getAttribute('data-clicked')).toBe('true');
    });
  });

  describe('fast-snapshot index resolution', () => {
    const snapshotSymbol = Symbol.for('__browser_use_last_snapshot_type__');

    afterEach(() => {
      delete (globalThis as any).__pawFast;
      delete (globalThis as any)[snapshotSymbol];
    });

    it('resolves numeric indices through __pawFast.actionElements while a fast snapshot is current', async () => {
      document.body.innerHTML = `
        <button id="fast-target">Fast</button>
        <button id="standard-target" data-mcp-idx="1">Standard</button>
      `;

      (globalThis as any).__pawFast = {
        actionElements: new Map<string | number, Element>([
          [1, document.getElementById('fast-target')],
        ]),
      };
      (globalThis as any)[snapshotSymbol] = 'fast';

      const result = await evaluateInPage(`
        return {
          numeric: mcp.get(1)?.id,
          ref: mcp.get('ref_1')?.id,
          stringIndex: mcp.get('1')?.id
        };
      `);

      expect(result).toEqual({
        numeric: 'fast-target',
        ref: 'fast-target',
        stringIndex: 'fast-target',
      });
    });

    it('ignores stale fast actions once a standard snapshot replaced them', async () => {
      document.body.innerHTML = `
        <button id="fast-target">Fast</button>
        <button id="standard-target" data-mcp-idx="1">Standard</button>
      `;

      (globalThis as any).__pawFast = {
        actionElements: new Map<string | number, Element>([
          [1, document.getElementById('fast-target')],
        ]),
      };
      (globalThis as any)[snapshotSymbol] = 'standard';

      const result = await evaluateInPage(`return mcp.get(1)?.id;`);

      expect(result).toBe('standard-target');
    });
  });

  describe('End-to-End Single-Turn In-Page Agent Workflow', () => {
    it('executes a complex multi-step cart cleanup workflow in a single turn', async () => {
      document.body.innerHTML = `
        <div id="cart-app">
          <div class="cart-item" data-id="1">
            <input type="checkbox" class="item-check" />
            <span class="title">Expired Coupon Item</span>
            <span class="status">Out of stock</span>
          </div>
          <div class="cart-item" data-id="2">
            <input type="checkbox" class="item-check" />
            <span class="title">Fresh Milk</span>
            <span class="status">In stock</span>
          </div>
          <div class="cart-item" data-id="3">
            <input type="checkbox" class="item-check" />
            <span class="title">Discontinued Tea</span>
            <span class="status">Out of stock</span>
          </div>
          <button id="batch-delete-btn">Delete Selected</button>
          <div id="confirm-modal" style="display: none;">
            <p>Confirm removing selected items?</p>
            <button id="confirm-yes">Yes, Delete</button>
            <button id="confirm-no">Cancel</button>
          </div>
        </div>
      `;

      const modal = document.getElementById('confirm-modal')!;
      const batchBtn = document.getElementById('batch-delete-btn')!;
      const confirmYes = document.getElementById('confirm-yes')!;

      batchBtn.addEventListener('click', () => {
        modal.style.display = 'block';
      });

      confirmYes.addEventListener('click', () => {
        const checkedItems = document.querySelectorAll('.cart-item input.item-check:checked');
        checkedItems.forEach((chk) => {
          chk.closest('.cart-item')?.remove();
        });
        modal.style.display = 'none';
      });

      const result = await evaluateInPage(`
        return await mcp.run(async (ctx) => {
          const allItems = Array.from(document.querySelectorAll('.cart-item'));
          const outOfStockItems = allItems.filter(item => item.textContent.includes('Out of stock'));

          for (const item of outOfStockItems) {
            const chk = item.querySelector('.item-check');
            await ctx.check(chk, true);
          }

          await ctx.click('#batch-delete-btn');
          await ctx.click('button:has-text("Yes, Delete")');

          const remaining = Array.from(document.querySelectorAll('.cart-item')).map(item => {
            return item.querySelector('.title').textContent.trim();
          });

          return {
            removedCount: outOfStockItems.length,
            remainingItems: remaining
          };
        });
      `);

      expect(result.removedCount).toBe(2);
      expect(result.remainingItems).toEqual(['Fresh Milk']);
      expect(document.querySelectorAll('.cart-item').length).toBe(1);
    });
  });

  describe('Edge Cases & Advanced Selector Features', () => {
    it('supports non-terminal :has-text pseudo selectors (e.g. tr:has-text("...") button)', async () => {
      document.body.innerHTML = `
        <table>
          <tr id="row-1">
            <td class="name">Order #101</td>
            <td class="action"><button class="del-btn">Delete</button></td>
          </tr>
          <tr id="row-2">
            <td class="name">Order #102</td>
            <td class="action"><button class="del-btn">Delete</button></td>
          </tr>
        </table>
      `;

      const result = await evaluateInPage(`
        const btn = document.querySelector('tr:has-text("Order #102") button.del-btn');
        return {
          rowId: btn?.closest('tr')?.id,
          btnText: btn?.textContent
        };
      `);

      expect(result.rowId).toBe('row-2');
      expect(result.btnText).toBe('Delete');
    });

    it('supports comma-separated selectors containing :has-text without throwing SyntaxError', async () => {
      document.body.innerHTML = `
        <button id="btn-save">Save Progress</button>
        <button id="btn-submit">Submit Form</button>
        <button id="btn-cancel">Cancel</button>
      `;

      const result = await evaluateInPage(`
        const btns = document.querySelectorAll('button:has-text("Save"), button:has-text("Submit")');
        return Array.from(btns).map(b => b.id);
      `);

      expect(result).toEqual(['btn-save', 'btn-submit']);
    });

    it('supports regex patterns in :has-text(/.../)', async () => {
      document.body.innerHTML = `
        <ul>
          <li class="item" id="item-invalid">状态: 失效商品</li>
          <li class="item" id="item-nostock">状态: 无货商品</li>
          <li class="item" id="item-valid">状态: 正常现货</li>
        </ul>
      `;

      const result = await evaluateInPage(`
        const matched = document.querySelectorAll('li:has-text(/失效|无货/)');
        return Array.from(matched).map(el => el.id);
      `);

      expect(result).toEqual(['item-invalid', 'item-nostock']);
    });

    it('selects the innermost element when tags are nested with :has-text', async () => {
      document.body.innerHTML = `
        <div id="outer" class="container">
          <div id="inner" class="card">
            <div id="target" class="title">Submit Application</div>
          </div>
        </div>
      `;

      const result = await evaluateInPage(`
        const innermost = document.querySelector('div:has-text("Submit Application")');
        return innermost?.id;
      `);

      expect(result).toBe('target');
    });

    it('does not treat CSS selectors starting with numbers as numeric indices', async () => {
      document.body.innerHTML = `
        <button id="24h-delivery" class="btn">24 Hour Delivery</button>
      `;

      const result = await evaluateInPage(`
        const el = mcp.get('#24h-delivery');
        return el ? el.id : null;
      `);

      expect(result).toBe('24h-delivery');
    });

    it('accepts options object in mcp.waitFor with timeout and visible check', async () => {
      document.body.innerHTML = `
        <div id="target-box" style="display: block;">Loaded Content</div>
      `;

      const result = await evaluateInPage(`
        const el = await mcp.waitFor('#target-box', { timeout: 1000, visible: true });
        return el ? el.textContent : null;
      `);

      expect(result).toBe('Loaded Content');
    });

    it('returns result when user code is a single variable declaration like const res = await mcp.run(...)', async () => {
      document.body.innerHTML = `
        <div id="summary">Result Data 42</div>
      `;

      const result = await evaluateInPage(`
        const res = await mcp.run(async () => {
          return { summary: document.getElementById('summary')?.textContent };
        });
      `);

      expect(result).toEqual({ summary: 'Result Data 42' });
    });
  });
});
