import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseBrowserToolExecutor } from '../entrypoints/background/tools/base-browser';

class TestBrowserExecutor extends BaseBrowserToolExecutor {
  name = 'test_executor';

  async execute() {
    return { content: [], isError: false };
  }

  inject(tabId: number, files: string[]) {
    return this.injectContentScript(tabId, files);
  }
}

describe('injectContentScript ping handling', () => {
  const executor = new TestBrowserExecutor();

  beforeEach(() => {
    vi.stubGlobal('chrome', {
      tabs: {
        get: vi.fn(async () => ({ id: 101, url: 'https://example.com/' })),
        sendMessage: vi.fn(),
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
        onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      scripting: {
        executeScript: vi.fn(async () => [{ frameId: 0, result: undefined }]),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('treats a missing receiver before first injection as an expected cache miss', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(chrome.tabs.sendMessage).mockRejectedValue(
      new Error('Could not establish connection. Receiving end does not exist.'),
    );

    await expect(executor.inject(101, ['inject-scripts/click-helper.js'])).resolves.toBeUndefined();

    expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('still reports an unexpected ping transport failure', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(chrome.tabs.sendMessage).mockRejectedValue(
      new Error('Cannot access contents of the page'),
    );

    await expect(executor.inject(102, ['inject-scripts/fill-helper.js'])).resolves.toBeUndefined();

    expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('ping content script failed: Cannot access contents of the page'),
    );
  });

  it('turns a Chrome error-page ping into one friendly failure without console noise', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(chrome.tabs.sendMessage).mockRejectedValue(
      new Error('Frame with ID 0 is showing error page'),
    );

    await expect(executor.inject(103, ['inject-scripts/network-helper.js'])).rejects.toThrow(
      /Chrome is showing an error page/,
    );

    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('turns a Chrome error-page injection failure into one friendly failure without console noise', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(chrome.tabs.sendMessage).mockRejectedValue(
      new Error('Could not establish connection. Receiving end does not exist.'),
    );
    vi.mocked(chrome.scripting.executeScript).mockRejectedValue(
      new Error('Frame with ID 0 is showing error page'),
    );

    await expect(executor.inject(104, ['inject-scripts/network-helper.js'])).rejects.toThrow(
      /Chrome is showing an error page/,
    );

    expect(consoleError).not.toHaveBeenCalled();
  });
});
