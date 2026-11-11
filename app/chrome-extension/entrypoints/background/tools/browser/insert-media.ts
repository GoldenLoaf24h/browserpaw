import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { executeInPage } from './in-page-engine';
import { sessionTabAffinity } from '@/utils/session-tab-affinity';
import { sendFileOperationToNative, cancelFileOperation } from '../../native-host';
import { isCloudMetadataUrl } from '../../../../utils/restricted-url';

export interface InsertMediaParams {
  filePath?: string;
  fileUrl?: string;
  base64Data?: string;
  mediaUrl?: string;
  fileName?: string;
  mimeType?: string;
  index?: number;
  selector?: string;
  tabId?: number;
  windowId?: number;
  sessionId?: string;
  sessionContext?: string;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 32768;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

export class InsertMediaTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.INSERT_MEDIA;

  async execute(args: InsertMediaParams = {}): Promise<ToolResult> {
    try {
      const tab = await this.resolveAffinityTab({
        tabId: args.tabId,
        windowId: args.windowId,
        sessionId: args.sessionId || args.sessionContext,
      });

      if (!tab.id) {
        return createErrorResponse('No active tab found for chrome_insert_media');
      }

      const tabId = tab.id;

      return await sessionTabAffinity.runSerialized(tabId, async () => {
        let base64 = args.base64Data;
        let fileName = args.fileName;
        let mimeType = args.mimeType;

        // 1. If mediaUrl or remote fileUrl provided, fetch binary
        const fetchTargetUrl = args.mediaUrl || args.fileUrl;
        if (!base64 && fetchTargetUrl) {
          if (
            isCloudMetadataUrl(fetchTargetUrl) ||
            fetchTargetUrl.trim().toLowerCase().startsWith('file:')
          ) {
            return createErrorResponse('Access denied: Blocked restricted or cloud metadata URL');
          }
          try {
            const resp = await fetch(fetchTargetUrl);
            if (!resp.ok) {
              return createErrorResponse(
                `Failed to fetch media from URL (${resp.status} ${resp.statusText}): ${fetchTargetUrl}`,
              );
            }
            if (!mimeType) {
              mimeType = resp.headers.get('content-type') || undefined;
            }
            const arrayBuffer = await resp.arrayBuffer();
            base64 = uint8ArrayToBase64(new Uint8Array(arrayBuffer));
            if (!fileName) {
              const urlPath = new URL(fetchTargetUrl, 'http://localhost').pathname;
              fileName = urlPath.split('/').pop() || 'downloaded-media.png';
            }
          } catch (fetchErr: any) {
            return createErrorResponse(
              `Failed to download media from URL: ${fetchErr?.message || fetchErr}`,
            );
          }
        }

        // 2. If filePath provided but no base64 yet, request from Native Host
        if (!base64 && args.filePath) {
          const nativeRes = await this.readMediaFromNative(args.filePath);
          if (!nativeRes.success) {
            return createErrorResponse(
              nativeRes.error || `Failed to read local media file: ${args.filePath}`,
            );
          }
          if (nativeRes.mediaUrl) {
            try {
              // The media-asset endpoint sits behind the global bridge-token
              // preHandler; without the token every streamed fetch gets 401.
              const mediaUrl = new URL(nativeRes.mediaUrl);
              const stored = await chrome.storage.local
                .get(['serverStatus'])
                .catch(() => ({}) as any);
              const bridgeToken = (stored as any)?.serverStatus?.token;
              if (bridgeToken) {
                mediaUrl.searchParams.set('token', bridgeToken);
              }
              const resp = await fetch(mediaUrl.toString());
              if (!resp.ok) {
                return createErrorResponse(
                  `Failed to stream media asset from server (${resp.status}): ${nativeRes.mediaUrl}`,
                );
              }
              if (!mimeType) {
                mimeType = resp.headers.get('content-type') || nativeRes.mimeType;
              }
              const arrayBuffer = await resp.arrayBuffer();
              base64 = uint8ArrayToBase64(new Uint8Array(arrayBuffer));
            } catch (streamErr: any) {
              return createErrorResponse(
                `Failed to fetch streamed media from server: ${streamErr?.message || streamErr}`,
              );
            }
          } else if (nativeRes.base64Data) {
            base64 = nativeRes.base64Data;
          }
          if (!fileName && nativeRes.fileName) fileName = nativeRes.fileName;
          if (!mimeType && nativeRes.mimeType) mimeType = nativeRes.mimeType;
        }

        if (!base64) {
          return createErrorResponse(
            'One of filePath, fileUrl, mediaUrl, or base64Data must be provided for chrome_insert_media',
          );
        }

        // 3. Execute in-page media insertion
        const insertPayload = {
          base64Data: base64,
          fileName,
          mimeType,
          index: typeof args.index === 'number' && args.index > 0 ? args.index : undefined,
          selector: args.selector,
        };

        const results = await executeInPage({ tabId }, 'inPageInsertMedia', [insertPayload]);
        let outcome = results?.[0]?.result;

        // If target element was not found in top frame and index was specified, search all frames
        if ((!outcome || !outcome.success) && typeof args.index === 'number') {
          const frameResults = await executeInPage(
            { tabId, allFrames: true },
            'inPageInsertMedia',
            [insertPayload],
          );
          const match = frameResults.find((r) => r.result?.success);
          if (match?.result) {
            outcome = match.result;
          }
        }

        if (!outcome || !outcome.success) {
          return createErrorResponse(
            outcome?.error || 'Failed to inject media into active editor or targeted element',
          );
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  target: outcome.target,
                  dispatchedEvents: outcome.dispatchedEvents,
                  file: {
                    name: outcome.fileName,
                    mimeType: outcome.mimeType,
                    sizeBytes: outcome.fileSize,
                  },
                  message: `Successfully synthesized DataTransfer File insertion into ${outcome.target?.tagName || 'active element'} (${outcome.dispatchedEvents.join(', ')})`,
                },
                null,
                2,
              ),
            },
          ],
          isError: false,
        };
      });
    } catch (error) {
      return createErrorResponse(
        `Error executing chrome_insert_media: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async readMediaFromNative(filePath: string): Promise<{
    success: boolean;
    base64Data?: string;
    mediaUrl?: string;
    fileName?: string;
    mimeType?: string;
    error?: string;
  }> {
    return new Promise((resolve) => {
      const requestId = `media-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const timeout = setTimeout(() => {
        cancelFileOperation(requestId);
        resolve({ success: false, error: 'Timed out waiting for native host to read media file' });
      }, 30000);

      const ok = sendFileOperationToNative(
        {
          type: 'file_operation',
          requestId,
          payload: {
            action: 'readMediaFile',
            filePath,
          },
        },
        (message: any) => {
          clearTimeout(timeout);
          if (
            message.payload?.success &&
            (message.payload?.base64Data || message.payload?.mediaUrl)
          ) {
            resolve(message.payload);
          } else {
            resolve({
              success: false,
              error: message.error || message.payload?.error || 'Native host failed to read media',
            });
          }
        },
      );

      if (!ok) {
        clearTimeout(timeout);
        resolve({ success: false, error: 'Native host not connected' });
      }
    });
  }
}

export const insertMediaTool = new InsertMediaTool();
