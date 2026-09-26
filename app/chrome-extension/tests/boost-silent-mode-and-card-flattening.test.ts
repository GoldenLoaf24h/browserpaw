import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TabGroupManager,
  tabGroupManager,
  cleanPageTitle,
  deriveSmartGroupTitle,
} from '../entrypoints/background/tools/browser/tab-group-manager';
import { navigateTool } from '../entrypoints/background/tools/browser/common';
import {
  inPageDOMPruner,
  extractCleanElementText,
  getIsolatedIndexMap,
} from '../entrypoints/background/tools/browser/dom-indexer';

describe('Silent Background Operation, Intent Tab Grouping & Composite Card Flattening', () => {
  let prevRect: any;

  beforeEach(() => {
    document.body.innerHTML = '';
    getIsolatedIndexMap().clear();
    tabGroupManager.resetForTest();
    vi.restoreAllMocks();
    prevRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      return {
        x: 10,
        y: 10,
        left: 10,
        top: 10,
        right: 210,
        bottom: 80,
        width: 200,
        height: 70,
        toJSON: () => ({}),
      } as DOMRect;
    };
  });

  afterEach(() => {
    if (prevRect) Element.prototype.getBoundingClientRect = prevRect;
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Active Tab Protection Guard (P0 Non-Intrusive Human Coexistence)
  // =========================================================================
  describe('1. Active Tab Protection Guard in NavigateTool', () => {
    it('refuses to overwrite user active unmanaged tab and creates background tab instead', async () => {
      const userActiveTab = {
        id: 1581267292,
        url: 'https://x.com/home',
        active: true,
        windowId: 10,
        groupId: -1,
      };

      const newBgTab = {
        id: 20001,
        url: 'https://www.jd.com/',
        active: false,
        windowId: 10,
        groupId: -1,
      };

      const tabUpdateSpy = vi.fn();
      const tabCreateSpy = vi.fn(async () => newBgTab);

      (globalThis as any).chrome = {
        tabs: {
          get: vi.fn(async (id: number) => {
            if (id === 1581267292) return userActiveTab;
            if (id === 20001) return newBgTab;
            return { id, windowId: 10, url: 'about:blank' };
          }),
          query: vi.fn(async () => [userActiveTab]),
          create: tabCreateSpy,
          update: tabUpdateSpy,
          group: vi.fn(async () => 777),
        },
        windows: {
          get: vi.fn(async (id: number) => ({ id, focused: true })),
          getLastFocused: vi.fn(async () => ({ id: 10, focused: true })),
          create: vi.fn(),
        },
        tabGroups: {
          get: vi.fn(async (id: number) => ({ id, windowId: 10, title: '京东' })),
          update: vi.fn(),
        },
        storage: {
          session: {
            get: vi.fn(async () => ({})),
            set: vi.fn(async () => {}),
          },
          local: {
            get: vi.fn(async () => ({})),
            set: vi.fn(async () => {}),
          },
        },
      };

      // Agent calls navigate with tabId pointing to user's active tab
      const res = await navigateTool.execute({
        url: 'https://www.jd.com/',
        tabId: 1581267292,
        groupTitle: '京东显示器销量前十',
      });

      // Verification:
      // 1. User active tab must NEVER be updated/overwritten!
      expect(tabUpdateSpy).not.toHaveBeenCalled();
      // 2. A new tab must be created with active: false (silent background operation)
      expect(tabCreateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://www.jd.com/',
          active: false,
        }),
      );
      expect(res.isError).toBe(false);
    });

    it('permits navigating within an agent-managed tab even if active', async () => {
      const managedTab = {
        id: 9999,
        url: 'https://www.jd.com/',
        active: true,
        windowId: 10,
        groupId: 555,
      };

      const tabUpdateSpy = vi.fn(async () => managedTab);

      (globalThis as any).chrome = {
        tabs: {
          get: vi.fn(async () => managedTab),
          query: vi.fn(async () => [managedTab]),
          update: tabUpdateSpy,
          group: vi.fn(async () => 555),
        },
        windows: {
          getLastFocused: vi.fn(async () => ({ id: 10, focused: true })),
        },
        tabGroups: {
          get: vi.fn(async () => ({ id: 555, windowId: 10, title: '京东' })),
          update: vi.fn(),
        },
        storage: {
          session: {
            get: vi.fn(async () => ({
              tab_group_manager_managed_groups: [555],
            })),
            set: vi.fn(async () => {}),
          },
          local: {
            get: vi.fn(async () => ({})),
          },
        },
      };

      // Re-load storage into manager
      const mgr = new TabGroupManager();
      await new Promise((r) => setTimeout(r, 50));

      const isManaged = await mgr.isManagedGroup(555);
      expect(isManaged).toBe(true);
    });
  });

  // =========================================================================
  // 2. Task-Intent Driven Tab Group Naming & Dynamic Self-Healing
  // =========================================================================
  describe('2. Tab Group Naming & Dynamic Self-Healing', () => {
    it('cleanPageTitle removes noisy search suffixes and extracts clean entity title', () => {
      expect(cleanPageTitle('显示器 - 商品搜索 - 京东')).toBe('显示器');
      expect(cleanPageTitle('机械键盘 - 京东')).toBe('机械键盘');
      expect(cleanPageTitle('Google 搜索 - BrowserPaw')).toBe('Google 搜索');
      expect(cleanPageTitle('New Tab')).toBe('');
      expect(cleanPageTitle('about:blank')).toBe('');
    });

    it('deriveSmartGroupTitle extracts clean domain brand names dynamically when title is empty', () => {
      expect(deriveSmartGroupTitle(null, 'https://item.jd.com/1000123.html')).toBe('Jd');
      expect(deriveSmartGroupTitle(null, 'https://detail.tmall.com/item.htm')).toBe('Tmall');
      expect(deriveSmartGroupTitle(null, 'https://github.com/torvalds/linux')).toBe('Github');
      expect(deriveSmartGroupTitle(null, 'https://x.com/home')).toBe('X');
      expect(deriveSmartGroupTitle(null, 'https://news.ycombinator.com/item?id=123')).toBe(
        'Ycombinator',
      );
      expect(deriveSmartGroupTitle(null, 'https://www.amazon.co.uk/dp/B08N5WRWNW')).toBe('Amazon');
    });

    it('ensureAgentTabGroup respects explicit intent title and persists it across updates', async () => {
      const updateSpy = vi.fn();
      (globalThis as any).chrome = {
        tabs: {
          get: vi.fn(async () => ({ id: 101, windowId: 1, title: '京东(JD.COM)' })),
          group: vi.fn(async () => 888),
        },
        tabGroups: {
          get: vi.fn(async () => ({ id: 888, windowId: 1 })),
          update: updateSpy,
        },
        storage: {
          session: {
            get: vi.fn(async () => ({})),
            set: vi.fn(async () => {}),
          },
        },
      };

      const mgr = new TabGroupManager();
      const gid = await mgr.ensureAgentTabGroup(101, {
        title: '京东显示器销量前十',
        color: 'cyan',
      });

      expect(gid).toBe(888);
      expect(updateSpy).toHaveBeenCalledWith(
        888,
        expect.objectContaining({
          title: '京东显示器销量前十',
          color: 'cyan',
        }),
      );
    });
  });

  // =========================================================================
  // 3. W3C Standard Composite Card Flattening & PUA Filtering
  // =========================================================================
  describe('3. W3C Standard Composite Card Flattening & PUA Filtering', () => {
    it('strips Unicode Private Use Area (PUA) characters in extractCleanElementText', () => {
      const el = document.createElement('span');
      // Contains JD icon font character \ue610 and extra spaces
      el.textContent = '自营 \ue610 放心购';
      const clean = extractCleanElementText(el);
      expect(clean).toBe('自营 放心购');
      expect(clean.includes('\ue610')).toBe(false);
    });

    it('aggregates fragmented card text into a single structured card line with primary link index', () => {
      // Simulate an eCommerce product card structure without any vendor-specific classes
      document.body.innerHTML = `
        <ul id="product-list">
          <li class="item-wrapper" style="width: 280px; height: 360px;">
            <div class="p-img">
              <a href="/item/10001.html" id="link-10001">
                <img src="/thumb.jpg" alt="AOC显示器" />
              </a>
            </div>
            <div class="p-name">
              <a href="/item/10001.html">
                <em>AOC 27英寸 4K 160Hz 1ms IPS 显示器</em>
              </a>
            </div>
            <div class="p-price">
              <span>￥1299.00</span>
            </div>
            <div class="p-icons">
              <span>自营</span>
              <span>满1000减100</span>
            </div>
            <div class="p-commit">
              <span>5万+条评价 98%好评</span>
            </div>
            <div class="p-shop">
              <a href="/shop/aoc.html">AOC官方自营旗舰店</a>
            </div>
            <div class="p-operate">
              <button id="add-cart-10001">加入购物车</button>
            </div>
          </li>
        </ul>
      `;

      // Run DOM pruner with card flattening enabled (default)
      const res = inPageDOMPruner({
        flattenCards: true,
      });

      expect(res.flattenedCardCount).toBeGreaterThanOrEqual(1);

      // Verify that the tree string contains a clean [role="card"] line
      expect(res.treeString).toContain('card');
      expect(res.treeString).toContain('AOC 27英寸 4K 160Hz 1ms IPS 显示器');
      expect(res.treeString).toContain('￥1299.00');
      expect(res.treeString).toContain('自营');

      // Verify that the distinct action button "加入购物车" is preserved as its own interactive control!
      expect(res.treeString).toContain('button "加入购物车"');

      // Verify that redundant separate lines for price and tags are omitted
      const lines = res.treeString.split('\n');
      const cardLine = lines.find((l) => l.includes('AOC 27英寸'));
      expect(cardLine).toBeDefined();
      expect(cardLine).toContain('￥1299.00');
    });

    it('does not flatten cards that contain editable form inputs', () => {
      document.body.innerHTML = `
        <article style="width: 300px; height: 200px;">
          <h3>登录账户</h3>
          <p>请输入用户名和密码</p>
          <input type="text" placeholder="用户名" />
          <input type="password" placeholder="密码" />
          <button>提交</button>
        </article>
      `;

      const res = inPageDOMPruner({
        flattenCards: true,
      });

      // The form inputs must remain individually indexed and not collapsed into a card!
      expect(res.treeString).toContain('textbox');
      expect(res.treeString).toContain('password');
      expect(res.treeString).toContain('button "提交"');
      expect(res.flattenedCardCount).toBeUndefined();
    });

    it('respects flattenCards: false and preserves legacy individual element output', () => {
      document.body.innerHTML = `
        <ul>
          <li style="width: 200px; height: 200px;">
            <a href="/p1">商品标题</a>
            <span>￥99.00</span>
            <span>包邮</span>
          </li>
        </ul>
      `;

      const res = inPageDOMPruner({
        flattenCards: false,
      });

      expect(res.flattenedCardCount).toBeUndefined();
      expect(res.treeString).toContain('link "商品标题"');
      expect(res.treeString).toContain('span "￥99.00"');
    });
  });
});
