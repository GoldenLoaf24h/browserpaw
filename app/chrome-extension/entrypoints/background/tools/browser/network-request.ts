import { isCloudMetadataUrl, restrictedUrlErrorMessage } from '@/utils/restricted-url';
import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import {
  sendFileOperationToNative,
  cancelFileOperation,
  ensureNativeConnected,
} from '../../native-host';

const DEFAULT_NETWORK_REQUEST_TIMEOUT = 30000; // For sending a single request via content script

interface NetworkRequestToolParams {
  url: string; // URL is always required
  method?: string; // Defaults to GET
  headers?: Record<string, string>; // User-provided headers
  body?: any; // User-provided body
  timeout?: number; // Timeout for the network request itself
  // Optional multipart/form-data descriptor. When provided, overrides body and lets the helper build FormData.
  // Shape: { fields?: Record<string, string|number|boolean>, files?: Array<{ name: string, fileUrl?: string, filePath?: string, base64Data?: string, filename?: string, contentType?: string }> }
  // Or a compact array: [ [name, fileSpec, filename?], ... ] where fileSpec can be 'url:...', 'file:/abs/path', 'base64:...'
  formData?: any;
  tabId?: number; // Optional ID of specific tab to execute request within
  tabUrl?: string; // Optional URL of tab to execute request within
  sessionId?: string; // Optional session identifier to bind affinity to a specific tab context
  sessionContext?: string; // Optional alias for sessionId
}

/**
 * NetworkRequestTool - Sends network requests based on provided parameters.
 */
class NetworkRequestTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.NETWORK_REQUEST;

  private async preReadFileData(
    filePath: string,
  ): Promise<{ base64Data: string; fileName: string }> {
    const connected = await ensureNativeConnected('network_request_file');
    if (!connected) {
      throw new Error('Native host not connected for file operation');
    }

    return new Promise<{ base64Data: string; fileName: string }>((resolve, reject) => {
      const requestId = `net-file-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const timer = setTimeout(() => {
        cancelFileOperation(requestId);
        reject(new Error(`File read timed out after 30 seconds: ${filePath}`));
      }, 30000);

      const posted = sendFileOperationToNative(
        {
          type: 'file_operation',
          requestId,
          payload: {
            action: 'readBase64File',
            filePath,
          },
        },
        (response: any) => {
          clearTimeout(timer);
          if (response?.payload?.success && typeof response?.payload?.base64Data === 'string') {
            resolve({
              base64Data: response.payload.base64Data,
              fileName: response.payload.fileName || '',
            });
          } else {
            const errMsg =
              response?.error || response?.payload?.error || 'Failed to read file from native host';
            reject(new Error(errMsg));
          }
        },
      );

      if (!posted) {
        clearTimeout(timer);
        reject(new Error('Failed to send file operation to native host'));
      }
    });
  }

  async execute(args: NetworkRequestToolParams): Promise<ToolResult> {
    if (
      args.url &&
      (isCloudMetadataUrl(args.url) ||
        args.url.startsWith('file:') ||
        args.url.startsWith('file://'))
    ) {
      return createErrorResponse(restrictedUrlErrorMessage(args.url));
    }
    const {
      url,
      method = 'GET',
      headers = {},
      body,
      timeout = DEFAULT_NETWORK_REQUEST_TIMEOUT,
    } = args;

    console.log(`NetworkRequestTool: Executing with options:`, args);

    if (!url) {
      return createErrorResponse('URL parameter is required.');
    }

    try {
      let targetTabId: number | undefined;
      const sessionId = args.sessionId || args.sessionContext;

      if (typeof args.tabId === 'number' && args.tabId > 0) {
        const explicit = await this.tryGetTab(args.tabId, sessionId);
        if (!explicit?.id) {
          return createErrorResponse(`Tab with ID ${args.tabId} not found.`);
        }
        targetTabId = explicit.id;
      } else if (args.tabUrl) {
        const matchingTabs = await chrome.tabs.query({ url: args.tabUrl });
        if (matchingTabs.length > 0 && matchingTabs[0]?.id) {
          targetTabId = matchingTabs[0].id;
        } else {
          return createErrorResponse(`No open tab found matching tabUrl: "${args.tabUrl}"`);
        }
      } else {
        const resolved = await this.resolveAffinityTab({ sessionId });
        targetTabId = resolved.id;
      }

      if (!targetTabId) {
        return createErrorResponse('No active tab found or tab has no ID.');
      }

      // Pre-read any local files specified in formData before delegating to content script
      let processedFormData = args.formData || null;
      if (processedFormData) {
        if (Array.isArray(processedFormData)) {
          const items: any[] = [];
          for (const item of processedFormData) {
            if (Array.isArray(item) && item.length >= 2) {
              const name = item[0];
              const spec = String(item[1] || '');
              const filenameHint = item[2];
              if (/^file:/i.test(spec)) {
                const filePath = spec.replace(/^file:/i, '');
                const { base64Data, fileName } = await this.preReadFileData(filePath);
                items.push([name, `base64:${base64Data}`, filenameHint || fileName || undefined]);
              } else {
                items.push([...item]);
              }
            } else {
              items.push(item);
            }
          }
          processedFormData = items;
        } else if (typeof processedFormData === 'object') {
          const fields = { ...(processedFormData.fields || {}) };
          const rawFiles = Array.isArray(processedFormData.files) ? processedFormData.files : [];
          const files: any[] = [];
          for (const file of rawFiles) {
            if (file && typeof file === 'object') {
              if (file.filePath && !file.base64Data) {
                const { base64Data, fileName } = await this.preReadFileData(String(file.filePath));
                const { filePath: _, ...rest } = file;
                files.push({
                  ...rest,
                  base64Data,
                  filename: file.filename || fileName || undefined,
                });
              } else {
                files.push({ ...file });
              }
            } else {
              files.push(file);
            }
          }
          processedFormData = { ...processedFormData, fields, files };
        }
      }

      // Ensure content script is available in the target tab
      await this.injectContentScript(targetTabId, ['inject-scripts/network-helper.js']);

      console.log(
        `NetworkRequestTool: Sending to content script: URL=${url}, Method=${method}, Headers=${Object.keys(headers).join(',')}, BodyType=${typeof body}`,
      );

      // Add a 5s IPC margin over in-page timeout so content script aborts and formats error before background kills the RPC
      const networkIpcTimeout = Math.min(Math.max(timeout + 5000, 1000), 300000);

      const resultFromContentScript = await this.sendMessageToTab(
        targetTabId,
        {
          action: TOOL_MESSAGE_TYPES.NETWORK_SEND_REQUEST,
          url: url,
          method: method,
          headers: headers,
          body: body,
          formData: processedFormData,
          timeout: timeout,
        },
        undefined,
        networkIpcTimeout,
      );

      console.log(`NetworkRequestTool: Response from content script:`, resultFromContentScript);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(resultFromContentScript),
          },
        ],
        isError: !resultFromContentScript?.success,
      };
    } catch (error: any) {
      console.error('NetworkRequestTool: Error sending network request:', error);
      return createErrorResponse(
        `Error sending network request: ${error.message || String(error)}`,
      );
    }
  }
}

export const networkRequestTool = new NetworkRequestTool();
