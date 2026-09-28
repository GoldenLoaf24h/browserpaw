import { isCloudMetadataUrl, restrictedUrlErrorMessage } from '@/utils/restricted-url';
import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { isPopupUrl } from '@/utils/popup-guard';

interface WebFetcherToolParams {
  htmlContent?: boolean; // get the visible HTML content of the current page. default: false
  textContent?: boolean; // get the visible text content of the current page. default: true
  url?: string; // optional URL to fetch content from (if not provided, uses active tab)
  selector?: string; // optional CSS selector to get content from a specific element
  tabId?: number; // target existing tab id
  background?: boolean; // do not activate/focus
  windowId?: number; // target window id to pick active tab or create tab
}

class WebFetcherTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.WEB_FETCHER;

  /**
   * Execute web fetcher operation
   */
  async execute(args: WebFetcherToolParams): Promise<ToolResult> {
    // Handle mutually exclusive parameters: if htmlContent is true, textContent is forced to false
    const htmlContent = args.htmlContent === true;
    const textContent = htmlContent ? false : args.textContent !== false; // Default is true, unless htmlContent is true or textContent is explicitly set to false
    const url = args.url;
    const selector = args.selector;
    const explicitTabId = args.tabId;
    const background = args.background === true;
    const windowId = args.windowId;

    console.log(`Starting web fetcher with options:`, {
      htmlContent,
      textContent,
      url,
      selector,
    });

    try {
      // Get tab to fetch content from
      let tab;

      if (typeof explicitTabId === 'number') {
        tab = await chrome.tabs.get(explicitTabId);
      } else if (url) {
        if (isCloudMetadataUrl(url)) {
          return createErrorResponse(restrictedUrlErrorMessage(url));
        }
        if (isPopupUrl(url)) {
          return createErrorResponse(
            'Access denied: popup.html cannot be opened or navigated to by agent code paths. Popup is reserved exclusively for user manual interaction.',
          );
        }
        // If URL is provided, check if it's already open
        console.log(`Checking if URL is already open: ${url}`);
        const allTabs = await chrome.tabs.query({});

        // Find tab with matching URL
        const matchingTabs = allTabs.filter((t) => {
          // Normalize URLs for comparison (remove trailing slashes)
          const tabUrl = t.url?.endsWith('/') ? t.url.slice(0, -1) : t.url;
          const targetUrl = url.endsWith('/') ? url.slice(0, -1) : url;
          return tabUrl === targetUrl;
        });

        if (matchingTabs.length > 0) {
          // Use existing tab
          tab = matchingTabs[0];
          console.log(`Found existing tab with URL: ${url}, tab ID: ${tab.id}`);
        } else {
          // Create new tab with the URL (default active: false to protect focus)
          console.log(`No existing tab found with URL: ${url}, creating new tab`);
          tab = await chrome.tabs.create({ url, active: background === false });

          // Wait for page to load
          if (tab.id && tab.status !== 'complete') {
            const newTabId = tab.id;
            console.log('Waiting for page to load...');
            await new Promise<void>((resolve) => {
              let timer: any = undefined;
              const updatedListener = (
                updatedTabId: number,
                changeInfo: chrome.tabs.TabChangeInfo,
              ) => {
                if (updatedTabId === newTabId && changeInfo.status === 'complete') {
                  cleanup();
                  resolve();
                }
              };
              const removedListener = (removedTabId: number) => {
                if (removedTabId === newTabId) {
                  cleanup();
                  resolve();
                }
              };
              const cleanup = () => {
                clearTimeout(timer);
                chrome.tabs.onUpdated?.removeListener?.(updatedListener);
                chrome.tabs.onRemoved?.removeListener?.(removedListener);
              };
              if (chrome.tabs?.onUpdated?.addListener) {
                chrome.tabs.onUpdated.addListener(updatedListener);
              }
              if (chrome.tabs?.onRemoved?.addListener) {
                chrome.tabs.onRemoved.addListener(removedListener);
              }
              timer = setTimeout(() => {
                cleanup();
                resolve();
              }, 10000);
            });
            try {
              tab = await chrome.tabs.get(newTabId);
            } catch {}
          }
        }
      } else {
        // Use active tab (prefer specified window)
        const tabs =
          typeof windowId === 'number'
            ? await chrome.tabs.query({ active: true, windowId })
            : await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs[0]) {
          return createErrorResponse('No active tab found');
        }
        tab = tabs[0];
      }

      if (!tab.id) {
        return createErrorResponse('Tab has no ID');
      }

      // Optionally bring tab/window to foreground only if background is explicitly false (P0-1)
      if (background === false) {
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
      }

      // Prepare result object
      const result: any = {
        success: true,
        url: tab.url,
        title: tab.title,
      };

      await this.injectContentScript(tab.id, ['inject-scripts/web-fetcher-helper.js']);

      // Get HTML content if requested
      if (htmlContent) {
        const htmlResponse = await this.sendMessageToTab(tab.id, {
          action: TOOL_MESSAGE_TYPES.WEB_FETCHER_GET_HTML_CONTENT,
          selector: selector,
        });

        if (htmlResponse.success) {
          result.htmlContent = htmlResponse.htmlContent;
        } else {
          console.error('Failed to get HTML content:', htmlResponse.error);
          result.htmlContentError = htmlResponse.error;
        }
      }

      // Get text content if requested (and htmlContent is not true)
      if (textContent) {
        const textResponse = await this.sendMessageToTab(tab.id, {
          action: TOOL_MESSAGE_TYPES.WEB_FETCHER_GET_TEXT_CONTENT,
          selector: selector,
        });

        if (textResponse.success) {
          result.textContent = textResponse.textContent;

          // Include article metadata if available
          if (textResponse.article) {
            result.article = {
              title: textResponse.article.title,
              byline: textResponse.article.byline,
              siteName: textResponse.article.siteName,
              excerpt: textResponse.article.excerpt,
              lang: textResponse.article.lang,
            };
          }

          // Include page metadata if available
          if (textResponse.metadata) {
            result.metadata = textResponse.metadata;
          }
        } else {
          console.error('Failed to get text content:', textResponse.error);
          result.textContentError = textResponse.error;
        }
      }

      // Native Messaging 1MB physical ceiling defense & safe degradation:
      // Truncate oversized HTML or text content (> 800KB) inline; agent
      // operations must not leave files in the user Downloads folder.
      if (typeof result.htmlContent === 'string' && result.htmlContent.length > 800 * 1024) {
        result.htmlContent = result.htmlContent.slice(0, 500 * 1024);
        result.warning =
          'HTML content exceeded the 800KB Native Messaging ceiling; truncated to 500KB inline (nothing written to disk).';
      }

      if (typeof result.textContent === 'string' && result.textContent.length > 800 * 1024) {
        result.textContent = result.textContent.slice(0, 500 * 1024);
        result.warning =
          'Text content exceeded the 800KB Native Messaging ceiling; truncated to 500KB inline (nothing written to disk).';
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in web fetcher:', error);
      return createErrorResponse(
        `Error fetching web content: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const webFetcherTool = new WebFetcherTool();
