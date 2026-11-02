import { createErrorResponse, ToolResult } from '../../../../common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { cdpSessionManager, type CdpEventObserver } from '../../../../utils/cdp-session-manager';
import { DIAGNOSTIC_REFRESH_GUIDANCE } from './dom-indexer';
import { executeInPage } from './in-page-engine';
import { sendFileOperationToNative, cancelFileOperation } from '../../native-host';
import { interactIndexTool } from './interact-index';
import { sessionTabAffinity } from '../../../../utils/session-tab-affinity';
import { attachActionReceipt } from '../../../../utils/action-receipt';
import { isCdpOutcomeUncertainError } from '../../../../utils/race-cdp';
import { logUnexpectedToolError } from '../../../../utils/restricted-url';
import {
  FileBackingLeaseManager,
  type FileBackingConsumer,
  type FileBackingHandle,
  type FileBackingLease,
} from '../../../../utils/file-backing-lease';

interface FileUploadToolParams {
  selector?: string; // CSS selector for the file input element
  index?: number | string; // Compact 1-based numeric index or ref string from chrome_read_dom
  clickTargetIndex?: number | string; // Compact 1-based numeric index or ref string to click to trigger file chooser dialog
  filePath?: string; // Local file path
  fileUrl?: string; // URL to download file from
  base64Data?: string; // Base64 encoded file data
  fileName?: string; // Optional filename when using base64 or URL
  multiple?: boolean; // Whether to allow multiple files
  tabId?: number; // Target existing tab id
  frameId?: number; // Explicit frame containing the file input
  windowId?: number; // When no tabId, pick active tab from this window
  sessionId?: string; // Session affinity identifier
  sessionContext?: string;
}

const leaseStorage =
  typeof chrome !== 'undefined' && (chrome.storage?.local || chrome.storage?.session)
    ? ((chrome.storage.local || chrome.storage.session) as any)
    : undefined;

export const fileBackingLeaseManager = new FileBackingLeaseManager({
  send: (message, callback) => {
    if (typeof sendFileOperationToNative !== 'function') return false;
    try {
      return sendFileOperationToNative(message, callback);
    } catch {
      return false;
    }
  },
  storage: leaseStorage,
});
/**
 * Tool for uploading files to web forms using Chrome DevTools Protocol
 * Similar to Playwright's setInputFiles implementation
 */
function parseTargetIndex(val: unknown): number | null {
  if (typeof val === 'number') {
    return Number.isSafeInteger(val) && val > 0 ? val : null;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    const match = trimmed.match(/^(?:e|ref_)?(\d+)$/i);
    if (match) {
      const num = parseInt(match[1], 10);
      return Number.isSafeInteger(num) && num > 0 ? num : null;
    }
  }
  return null;
}
function isFileInputNode(
  node: { nodeName: string; attributes?: string[] } | null | undefined,
): boolean {
  if (!node || node.nodeName !== 'INPUT') return false;
  const attrs = node.attributes || [];
  for (let i = 0; i < attrs.length; i += 2) {
    if (attrs[i].toLowerCase() === 'type') {
      return attrs[i + 1]?.toLowerCase() === 'file';
    }
  }
  return false;
}

export class FileUploadTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.FILE_UPLOAD;
  constructor() {
    super();
  }

  /**
   * Execute file upload operation using Chrome DevTools Protocol
   */
  async execute(args: FileUploadToolParams): Promise<ToolResult> {
    const { selector, index, filePath, fileUrl, base64Data, fileName, multiple = false } = args;

    const hasExplicitClickTarget =
      args.clickTargetIndex !== undefined && args.clickTargetIndex !== null;
    const parsedClickIndex = parseTargetIndex(args.clickTargetIndex);
    if (hasExplicitClickTarget && parsedClickIndex === null) {
      return createErrorResponse(
        `Invalid clickTargetIndex provided for file upload: ${String(args.clickTargetIndex)}`,
      );
    }
    const hasClickTarget = parsedClickIndex !== null;

    const hasExplicitIndex = index !== undefined && index !== null;
    const parsedIndex = parseTargetIndex(index);
    if (hasExplicitIndex && parsedIndex === null) {
      return createErrorResponse(`Invalid index provided for file upload: ${String(index)}`);
    }
    const hasIndex = parsedIndex !== null;

    const targetSelector =
      typeof selector === 'string' && selector.trim() ? selector.trim() : undefined;
    const hasTargetSelector = Boolean(targetSelector);

    // Validate input
    if (!hasTargetSelector && !hasIndex && !hasClickTarget) {
      return createErrorResponse(
        'Either selector, index, or clickTargetIndex must be provided for file upload',
      );
    }

    if (!filePath && !fileUrl && !base64Data) {
      return createErrorResponse('One of filePath, fileUrl, or base64Data must be provided');
    }

    const createdTempFiles: string[] = [];
    let preparedFileMayBeSelected = false;
    let preparedLease: FileBackingLease | null = null;
    let retainedLease: FileBackingLease | null = null;
    let consumer: FileBackingConsumer = {};

    try {
      // Resolve tab
      const tab = await this.resolveAffinityTab({
        tabId: args.tabId,
        windowId: args.windowId,
        sessionId: args.sessionId || (args as any).sessionContext,
      });
      if (!tab.id) return createErrorResponse('No active tab found');
      const tabId = tab.id;
      await fileBackingLeaseManager.start();
      consumer = await this.resolveFileConsumer(tabId, args.frameId);

      // Prepare file paths
      let files: string[] = [];

      if (filePath) {
        // Direct file path provided
        files = [filePath];
      } else if (fileUrl || base64Data) {
        // For URL or base64, we need to use the native messaging host
        // to download or save the file temporarily
        const prepResult = await this.prepareFileFromRemote({
          fileUrl,
          base64Data,
          fileName: fileName || 'uploaded-file',
        });
        if (!prepResult.filePath) {
          if (base64Data && !hasClickTarget) {
            console.warn(
              'Native messaging host unavailable to create temp file for CDP, falling back directly to HTML5 DataTransfer:',
              prepResult.error,
            );
            const dtRes = await this.uploadViaDataTransfer(tabId, {
              index: parsedIndex ?? index,
              selector: targetSelector,
              files: [{ name: fileName || 'uploaded-file', base64: base64Data }],
            });
            if (dtRes.success) {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      success: true,
                      delivery: 'selected',
                      submitted: false,
                      message: 'File(s) selected in the page; form submission is separate',
                      mode: 'html5_datatransfer_fallback',
                      selector: targetSelector,
                      index: parsedIndex ?? index,
                      fileCount: dtRes.fileCount,
                    }),
                  },
                ],
                isError: false,
              };
            }
            return createErrorResponse(
              dtRes.error || prepResult.error || 'Failed to prepare file for upload',
            );
          }
          return createErrorResponse(prepResult.error || 'Failed to prepare file for upload');
        }
        createdTempFiles.push(prepResult.filePath);
        files = [prepResult.filePath];
        if (prepResult.assetId && prepResult.leaseId) {
          preparedLease = fileBackingLeaseManager.track(
            {
              assetId: prepResult.assetId,
              leaseId: prepResult.leaseId,
              filePath: prepResult.filePath,
              fileName: prepResult.fileName,
              size: prepResult.size,
            },
            consumer,
          );
        }
      }

      // Mode 1: Dynamic File Chooser Interception (Ant Design, Element Plus dynamic dialogs)
      if (hasClickTarget) {
        const clickIndex = parsedClickIndex!;
        let openedEvent: any = null;

        let clickSummary: any;
        await sessionTabAffinity.runSerialized(tabId, () =>
          cdpSessionManager.withSession(tabId, 'file-upload-dialog', async () => {
            const children = await cdpSessionManager.ensureFrameSessions(tabId);
            const sessions: Array<string | undefined> = [
              undefined,
              ...children.map((s) => s.sessionId),
            ];
            const intercepted: Array<string | undefined> = [];
            let chooserTimeout: ReturnType<typeof setTimeout> | undefined;
            let chooserListener: CdpEventObserver | undefined;
            try {
              for (const sid of sessions) {
                await cdpSessionManager.sendFrameCommand(tabId, sid, 'Page.enable', {});
                intercepted.push(sid);
                await cdpSessionManager.sendFrameCommand(
                  tabId,
                  sid,
                  'Page.setInterceptFileChooserDialog',
                  { enabled: true },
                );
              }
              const eventPromise = new Promise<any>((resolve, reject) => {
                chooserTimeout = setTimeout(
                  () =>
                    reject(
                      new Error(
                        `Timed out (8000ms) waiting for file chooser after index [${clickIndex}]`,
                      ),
                    ),
                  8000,
                );
                chooserListener = (eventTabId, method, params, source) => {
                  if (
                    eventTabId === tabId &&
                    method === 'Page.fileChooserOpened' &&
                    sessions.includes(source?.sessionId)
                  ) {
                    clearTimeout(chooserTimeout);
                    resolve({ ...params, sessionId: source?.sessionId });
                  }
                };
                cdpSessionManager.addCdpEventObserver(chooserListener);
              });
              void eventPromise.catch(() => {});
              const click = await interactIndexTool.execute({
                tabId,
                index: clickIndex,
                frameId: args.frameId,
                action: 'click',
                skipLock: true,
                includeDelta: false,
              });
              const text = click.content.find((block) => block.type === 'text')?.text;
              try {
                clickSummary = JSON.parse(text || 'null');
              } catch {}
              if (click.isError || clickSummary?.success !== true) {
                const error = new Error(
                  `File chooser trigger failed: ${text || 'unconfirmed click'}`,
                );
                (error as any).receipt = clickSummary?.receipt;
                throw error;
              }
              openedEvent = await eventPromise;
              if (!Number.isInteger(openedEvent?.backendNodeId))
                throw new Error('File chooser has no backend node');
              // CDP emits input/change itself; synthetic duplicates can upload the same file twice.
              preparedFileMayBeSelected = true;
              await cdpSessionManager.sendFrameCommand(
                tabId,
                openedEvent.sessionId,
                'DOM.setFileInputFiles',
                {
                  files,
                  backendNodeId: openedEvent.backendNodeId,
                },
              );
            } finally {
              clearTimeout(chooserTimeout);
              if (chooserListener) cdpSessionManager.removeCdpEventObserver(chooserListener);
              for (const sid of intercepted) {
                await cdpSessionManager
                  .sendFrameCommand(tabId, sid, 'Page.setInterceptFileChooserDialog', {
                    enabled: false,
                  })
                  .catch(() => {});
              }
            }
          }),
        );
        retainedLease = await this.retainPreparedLease(preparedLease, 'selected', consumer);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                delivery: 'selected',
                submitted: false,
                mode: 'file_chooser_dialog_intercept',
                clickTargetIndex: clickIndex,
                backendNodeId: openedEvent?.backendNodeId,
                receipt: {
                  ...clickSummary?.receipt,
                  hasReceipt: true,
                  fileChooser: {
                    backendNodeId: openedEvent?.backendNodeId,
                    sessionId: openedEvent?.sessionId,
                    requiresAction: false,
                  },
                },
                files,
                ...(retainedLease ? this.leaseResult(retainedLease) : {}),
              }),
            },
          ],
          isError: false,
        };
      }

      // Mode 2: Standard file input element (CDP DOM query + DOM.setFileInputFiles)
      let uploadMode = 'cdp_set_file_input_files';
      let fileInputSet = false;

      try {
        // Use shared CDP session manager to attach/do work/detach safely
        await cdpSessionManager.withSession(tabId, 'file-upload', async () => {
          // Enable necessary CDP domains
          await cdpSessionManager.sendCommand(tabId, 'DOM.enable', {});
          await cdpSessionManager.sendCommand(tabId, 'Runtime.enable', {});

          // Get the document
          const { root } = (await cdpSessionManager.sendCommand(tabId, 'DOM.getDocument', {
            depth: -1,
            pierce: true,
          })) as { root: { nodeId: number } };

          // Find the file input element:
          // If index is provided, resolve directly via Isolated World memory map with ephemeral attribute bridge to CDP
          let targetNodeId = 0;
          let targetSessionId: string | undefined;
          if (
            (hasIndex && parsedIndex !== null) ||
            (hasTargetSelector && args.frameId !== undefined)
          ) {
            const markerAttr = 'data-cdp-upload-' + Math.random().toString(36).slice(2, 10);
            try {
              const markScript = (targetIdx: number, marker: string, targetSel?: string) => {
                let el: Element | null = null;
                if (targetSel) {
                  const visit = (root: ParentNode): Element | null => {
                    const direct = root.querySelector(targetSel);
                    if (direct) return direct;
                    for (const child of root.querySelectorAll('*')) {
                      const shadow = (child as Element).shadowRoot;
                      if (!shadow) continue;
                      const nested = visit(shadow);
                      if (nested) return nested;
                    }
                    return null;
                  };
                  el = visit(document);
                } else {
                  const map = (globalThis as any)[Symbol.for('__browser_use_isolated_index_map__')];
                  const wrapped = map?.get(targetIdx);
                  el = wrapped && typeof wrapped.deref === 'function' ? wrapped.deref() : wrapped;
                }
                const input = el?.matches?.('input[type="file"]')
                  ? el
                  : el?.querySelector?.('input[type="file"]') ||
                    el?.shadowRoot?.querySelector?.('input[type="file"]');
                if (
                  input &&
                  input instanceof Element &&
                  input.isConnected &&
                  input.ownerDocument === document
                ) {
                  input.setAttribute(marker, '1');
                  return true;
                }
                return false;
              };

              const markRes = await this.safeExecuteScript(tabId, {
                target:
                  args.frameId !== undefined ? { tabId, frameIds: [args.frameId] } : { tabId },
                func: markScript,
                args: [parsedIndex || 0, markerAttr, targetSelector],
              });

              let marked = markRes?.[0]?.result;
              if (!marked) {
                const frameMarkRes = await this.safeExecuteScript(tabId, {
                  target:
                    args.frameId !== undefined
                      ? { tabId, frameIds: [args.frameId] }
                      : { tabId, allFrames: true },
                  func: markScript,
                  args: [parsedIndex || 0, markerAttr, targetSelector],
                });
                marked = frameMarkRes.some((r) => r.result);
              }

              if (marked) {
                const direct = (await cdpSessionManager.sendCommand(tabId, 'DOM.querySelector', {
                  nodeId: root.nodeId,
                  selector: `[${markerAttr}="1"]`,
                })) as { nodeId: number };
                if (direct?.nodeId && direct.nodeId > 0) {
                  targetNodeId = direct.nodeId;
                }
                if (!targetNodeId) {
                  const children = await cdpSessionManager.ensureFrameSessions(tabId);
                  for (const sid of [undefined, ...children.map((child) => child.sessionId)]) {
                    await cdpSessionManager.sendFrameCommand(tabId, sid, 'DOM.getDocument', {
                      depth: 0,
                      pierce: true,
                    });
                    const search = await cdpSessionManager.sendFrameCommand<{
                      searchId: string;
                      resultCount: number;
                    }>(tabId, sid, 'DOM.performSearch', {
                      query: `[${markerAttr}="1"]`,
                      includeUserAgentShadowDOM: true,
                    });
                    try {
                      if (!search.resultCount) continue;
                      if (search.resultCount !== 1 || targetNodeId) {
                        throw new Error('Ambiguous indexed upload target');
                      }
                      const found = await cdpSessionManager.sendFrameCommand<{
                        nodeIds: number[];
                      }>(tabId, sid, 'DOM.getSearchResults', {
                        searchId: search.searchId,
                        fromIndex: 0,
                        toIndex: 1,
                      });
                      if (!found.nodeIds?.[0])
                        throw new Error('Upload target is no longer attached');
                      targetNodeId = found.nodeIds[0];
                      targetSessionId = sid;
                    } finally {
                      await cdpSessionManager.sendFrameCommand(
                        tabId,
                        sid,
                        'DOM.discardSearchResults',
                        {
                          searchId: search.searchId,
                        },
                      );
                    }
                  }
                }
              }
            } finally {
              // Clean up ephemeral marker immediately so DOM is not polluted
              await this.safeExecuteScript(tabId, {
                target:
                  args.frameId !== undefined
                    ? { tabId, frameIds: [args.frameId] }
                    : { tabId, allFrames: true },
                func: (targetIdx: number, marker: string, targetSel?: string) => {
                  let el: Element | null = null;
                  if (targetSel) {
                    el = document.querySelector(targetSel);
                    if (el) {
                      const shadowInput = el.shadowRoot?.querySelector?.('input[type="file"]');
                      if (shadowInput) el = shadowInput;
                    }
                  } else {
                    const map = (globalThis as any)[
                      Symbol.for('__browser_use_isolated_index_map__')
                    ];
                    const wrapped = map?.get(targetIdx);
                    el = wrapped && typeof wrapped.deref === 'function' ? wrapped.deref() : wrapped;
                  }
                  el?.removeAttribute(marker);
                },
                args: [parsedIndex || 0, markerAttr, targetSelector],
              }).catch(() => {});
            }

            if (!targetNodeId || targetNodeId === 0) {
              throw new Error(
                `Element with index [${index}] not found or expired. ${DIAGNOSTIC_REFRESH_GUIDANCE}`,
              );
            }
          } else if (targetSelector) {
            try {
              const direct = (await cdpSessionManager.sendCommand(tabId, 'DOM.querySelector', {
                nodeId: root.nodeId,
                selector: targetSelector,
              })) as { nodeId: number };
              if (direct?.nodeId && direct.nodeId > 0) {
                targetNodeId = direct.nodeId;
              }
            } catch {}

            if (!targetNodeId) {
              // Fallback: search for input[type="file"] inside selector
              try {
                const fallback = (await cdpSessionManager.sendCommand(tabId, 'DOM.querySelector', {
                  nodeId: root.nodeId,
                  selector: `${targetSelector} input[type="file"]`,
                })) as { nodeId: number };
                if (fallback?.nodeId && fallback.nodeId > 0) {
                  targetNodeId = fallback.nodeId;
                }
              } catch {}
            }

            if (!targetNodeId || targetNodeId === 0) {
              throw new Error(
                `Element with selector "${targetSelector}" not found. ${DIAGNOSTIC_REFRESH_GUIDANCE}`,
              );
            }
          } else {
            // Default file input discovery when no target was specified
            try {
              const defaultInput = (await cdpSessionManager.sendCommand(
                tabId,
                'DOM.querySelector',
                {
                  nodeId: root.nodeId,
                  selector: 'input[type="file"]',
                },
              )) as { nodeId: number };
              if (defaultInput?.nodeId && defaultInput.nodeId > 0) {
                targetNodeId = defaultInput.nodeId;
              }
            } catch {}

            if (!targetNodeId || targetNodeId === 0) {
              throw new Error(`No file input found on page. ${DIAGNOSTIC_REFRESH_GUIDANCE}`);
            }
          }

          const sendToTarget = (method: string, params: object): Promise<any> =>
            targetSessionId === undefined
              ? cdpSessionManager.sendCommand(tabId, method, params)
              : cdpSessionManager.sendFrameCommand(tabId, targetSessionId, method, params);
          // Verify it's an input element, or find child file input if it is a wrapper
          let { node } = (await sendToTarget('DOM.describeNode', {
            nodeId: targetNodeId,
          })) as { node: { nodeName: string; attributes?: string[] } };

          if (node.nodeName === 'INPUT') {
            if (!isFileInputNode(node)) {
              throw new Error(`Target element <${node.nodeName}> is not an input[type="file"]`);
            }
          } else {
            try {
              const childInput = (await sendToTarget('DOM.querySelector', {
                nodeId: targetNodeId,
                selector: 'input[type="file"]',
              })) as { nodeId: number };
              if (childInput?.nodeId && childInput.nodeId > 0) {
                targetNodeId = childInput.nodeId;
                const desc = (await sendToTarget('DOM.describeNode', {
                  nodeId: targetNodeId,
                })) as { node: { nodeName: string; attributes?: string[] } };
                if (desc?.node) node = desc.node;
              }
            } catch {}

            if (!isFileInputNode(node)) {
              throw new Error(`Target element <${node.nodeName}> is not an input[type="file"]`);
            }
          }

          // Set the files on the input element using CDP DOM.setFileInputFiles
          preparedFileMayBeSelected = true;
          await sendToTarget('DOM.setFileInputFiles', {
            nodeId: targetNodeId,
            files,
          });
          fileInputSet = true;
        });
      } catch (cdpErr) {
        if (fileInputSet) {
          // File was already set via CDP; post-upload event or session teardown glitch must not replay upload
          console.warn(
            'Post-upload event dispatch error, but file was already set via CDP:',
            cdpErr,
          );
        } else {
          if (!base64Data || preparedFileMayBeSelected || isCdpOutcomeUncertainError(cdpErr)) {
            throw cdpErr;
          }
          console.warn(
            'CDP file upload failed or debugger unavailable, falling back to HTML5 DataTransfer:',
            cdpErr,
          );
          const dtRes = await this.uploadViaDataTransfer(tabId, {
            index: parsedIndex ?? index,
            selector: targetSelector,
            frameId: args.frameId,
            files: [{ name: fileName || 'uploaded-file', base64: base64Data }],
          });
          if (!dtRes.success) {
            throw new Error(
              `CDP upload failed (${cdpErr instanceof Error ? cdpErr.message : String(cdpErr)}) and DataTransfer fallback failed (${dtRes.error})`,
            );
          }
          uploadMode = 'html5_datatransfer_fallback';
        }
      }
      if (fileInputSet) {
        retainedLease = await this.retainPreparedLease(preparedLease, 'selected', consumer);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              delivery: 'selected',
              submitted: false,
              message: 'File(s) selected in the page; form submission is separate',
              mode: uploadMode,
              files: files,
              selector: targetSelector,
              index: parsedIndex ?? index,
              fileCount: files.length,
              ...(retainedLease ? this.leaseResult(retainedLease) : {}),
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      logUnexpectedToolError('Error in file upload operation:', error);
      const deliveryUnknown =
        Boolean(preparedLease) && (preparedFileMayBeSelected || isCdpOutcomeUncertainError(error));
      if (deliveryUnknown && preparedLease) {
        retainedLease = await this.retainPreparedLease(preparedLease, 'unknown', consumer);
      }
      if (retainedLease) {
        return attachActionReceipt(
          {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                  delivery: 'unknown',
                  submitted: false,
                  retained: true,
                  ...this.leaseResult(retainedLease),
                }),
              },
            ],
            isError: true,
          },
          (error as any)?.receipt,
        );
      }
      return attachActionReceipt(
        createErrorResponse(
          `Error uploading file: ${error instanceof Error ? error.message : String(error)}`,
        ),
        (error as any)?.receipt,
      );
    } finally {
      // Clean up temporary files created from URL or base64 data
      if (preparedLease && !retainedLease) {
        try {
          await fileBackingLeaseManager.release(preparedLease.handle);
        } catch (leaseCleanupError) {
          console.warn('Failed to release unused upload lease', leaseCleanupError);
        }
      }
      if (
        !retainedLease &&
        (!preparedFileMayBeSelected || Boolean(preparedLease)) &&
        createdTempFiles.length > 0
      ) {
        for (const tempPath of createdTempFiles) {
          if (preparedLease?.handle.filePath === tempPath) continue;
          try {
            await this.cleanupTempFile(tempPath);
          } catch (cleanErr) {
            console.warn(`Failed to cleanup temp upload file: ${tempPath}`, cleanErr);
          }
        }
      }
    }
  }

  // All debugger attach/detach is centrally managed by cdpSessionManager

  private async resolveFileConsumer(tabId: number, frameId = 0): Promise<FileBackingConsumer> {
    try {
      const frame = await chrome.webNavigation?.getFrame?.({ tabId, frameId });
      return { tabId, frameId, documentId: frame?.documentId };
    } catch {
      return { tabId, frameId };
    }
  }

  private async retainPreparedLease(
    lease: FileBackingLease | null,
    delivery: 'selected' | 'unknown',
    consumer: FileBackingConsumer,
  ): Promise<FileBackingLease | null> {
    if (!lease) return null;
    return fileBackingLeaseManager.retain(lease.handle, delivery, consumer);
  }

  private leaseResult(lease: FileBackingLease): {
    assetId: string;
    leaseId: string;
    handle: FileBackingHandle;
  } {
    return {
      assetId: lease.assetId,
      leaseId: lease.leaseId,
      handle: { ...lease.handle },
    };
  }

  /**
   * Prepare file from URL or base64 data using native messaging host
   */
  private async prepareFileFromRemote(options: {
    fileUrl?: string;
    base64Data?: string;
    fileName: string;
  }): Promise<{
    filePath?: string;
    fileName?: string;
    size?: number;
    assetId?: string;
    leaseId?: string;
    error?: string;
  }> {
    const { fileUrl, base64Data, fileName } = options;

    return new Promise((resolve) => {
      const requestId = `prep-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const timeout = setTimeout(() => {
        cancelFileOperation(requestId);
        resolve({ error: 'File preparation request timed out after 30 seconds' });
      }, 30000); // 30 second timeout

      const ok = sendFileOperationToNative(
        {
          type: 'file_operation',
          requestId,
          payload: {
            action: 'prepareFile',
            fileUrl,
            base64Data,
            fileName,
          },
        },
        (message: any) => {
          clearTimeout(timeout);
          if (message.payload?.success && message.payload?.filePath) {
            resolve({
              filePath: message.payload.filePath,
              fileName: message.payload.fileName,
              size: message.payload.size,
              assetId: message.payload.assetId,
              leaseId: message.payload.leaseId,
            });
          } else {
            const err =
              message.error || message.payload?.error || 'Native host failed to prepare file';
            console.error('Native host failed to prepare file:', err);
            resolve({ error: err });
          }
        },
      );

      if (!ok) {
        clearTimeout(timeout);
        // safePostMessage returns false when the 1MB Native Messaging ceiling
        // rejects the payload; report the real cause instead of a dead-host error.
        resolve({
          error:
            'Native message rejected: payload exceeded the 1MB Native Messaging ceiling. Upload smaller files or pass a file path / server media URL instead of base64Data.',
        });
      }
    });
  }

  /**
   * Request native host to delete a temporary upload file
   */
  private async cleanupTempFile(filePath: string): Promise<void> {
    return new Promise((resolve) => {
      const requestId = `cleanup-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const timeout = setTimeout(() => resolve(), 5000);

      const ok = sendFileOperationToNative(
        {
          type: 'file_operation',
          requestId,
          payload: {
            action: 'cleanupFile',
            filePath,
          },
        },
        () => {
          clearTimeout(timeout);
          resolve();
        },
      );

      if (!ok) {
        clearTimeout(timeout);
        resolve();
      }
    });
  }

  /**
   * Unprivileged HTML5 DataTransfer File Upload Fallback Channel (Phase M3)
   * When chrome.debugger is unavailable or target page restricts CDP, provides
   * synthetic file upload using browser native DataTransfer API.
   */
  async uploadViaDataTransfer(
    tabId: number,
    options: {
      index?: number | string;
      selector?: string;
      frameId?: number;
      files: Array<{ name: string; type?: string; base64?: string; content?: string }>;
    },
  ): Promise<{ success: boolean; error?: string; fileCount?: number }> {
    try {
      const results = await chrome.scripting.executeScript({
        target:
          typeof options.frameId === 'number' ? { tabId, frameIds: [options.frameId] } : { tabId },
        func: (
          idx: number | string | undefined,
          sel: string | undefined,
          fileList: Array<{ name: string; type?: string; base64?: string; content?: string }>,
        ) => {
          const findFileInputInSubtree = (
            root: Element | DocumentFragment | Document,
          ): HTMLInputElement | null => {
            const direct = root.querySelector('input[type="file"]') as HTMLInputElement | null;
            if (direct) return direct;
            const elements = root.querySelectorAll('*');
            for (let i = 0; i < elements.length; i++) {
              const node = elements[i];
              if (node.shadowRoot) {
                const shadowChild = findFileInputInSubtree(node.shadowRoot);
                if (shadowChild) return shadowChild;
              }
            }
            return null;
          };

          let el: Element | null = null;
          const hasExplicitIndex = idx !== undefined && idx !== null && String(idx).trim() !== '';
          const hasExplicitSel = typeof sel === 'string' && sel.trim() !== '';

          if (hasExplicitIndex) {
            let numericIndex: number | null = null;
            if (typeof idx === 'number') {
              if (Number.isSafeInteger(idx) && idx > 0) {
                numericIndex = idx;
              }
            } else if (typeof idx === 'string') {
              const match = idx.trim().match(/^(?:e|ref_)?(\d+)$/i);
              if (match) {
                const num = parseInt(match[1], 10);
                if (Number.isSafeInteger(num) && num > 0) {
                  numericIndex = num;
                }
              }
            }

            if (numericIndex !== null) {
              const g = globalThis as any;
              const isolatedMap = g[Symbol.for('__browser_use_isolated_index_map__')];
              const entry = isolatedMap?.get(numericIndex);
              const dereffed = entry && typeof entry.deref === 'function' ? entry.deref() : entry;
              if (
                dereffed &&
                dereffed instanceof Element &&
                dereffed.isConnected &&
                dereffed.ownerDocument === document
              ) {
                el = dereffed;
              }
            }

            if (!el) {
              return {
                success: false,
                error: 'Element with index [' + idx + '] not found or expired',
              };
            }
          } else if (hasExplicitSel) {
            try {
              el = document.querySelector(sel);
            } catch (selErr) {
              return {
                success: false,
                error:
                  'Invalid selector "' +
                  sel +
                  '": ' +
                  (selErr instanceof Error ? selErr.message : String(selErr)),
              };
            }
            if (!el) {
              return {
                success: false,
                error: 'Element with selector "' + sel + '" not found',
              };
            }
          } else {
            el = findFileInputInSubtree(document);
            if (!el) {
              return { success: false, error: 'File input element not found' };
            }
          }

          const isFileInputElement = (element: Element): boolean => {
            if (element.tagName !== 'INPUT') return false;
            const input = element as HTMLInputElement;
            const attrType = element.getAttribute('type')?.toLowerCase();
            return input.type === 'file' || attrType === 'file';
          };

          if (el.tagName === 'INPUT') {
            if (!isFileInputElement(el)) {
              return {
                success: false,
                error: `Target element <${el.tagName}> is not an input[type="file"]`,
              };
            }
          } else {
            // If wrapper element, find nested input[type="file"] strictly within this wrapper including in shadowRoot
            const child =
              findFileInputInSubtree(el) ||
              (el.shadowRoot ? findFileInputInSubtree(el.shadowRoot) : null);
            if (child) el = child;

            if (!isFileInputElement(el)) {
              return {
                success: false,
                error: `Target element <${el.tagName}> is not an input[type="file"]`,
              };
            }
          }

          try {
            let dt: any;
            if (typeof DataTransfer !== 'undefined') {
              dt = new DataTransfer();
            } else {
              dt = {
                items: {
                  add: (f: any) => {
                    dt.files.push(f);
                  },
                },
                files: [],
              };
            }
            for (const f of fileList) {
              let blob: Blob;
              if (f.base64) {
                const rawBase64 = f.base64.includes(',') ? f.base64.split(',')[1] : f.base64;
                const binaryStr = atob(rawBase64);
                const bytes = new Uint8Array(binaryStr.length);
                for (let i = 0; i < binaryStr.length; i++) {
                  bytes[i] = binaryStr.charCodeAt(i);
                }
                blob = new Blob([bytes], { type: f.type || 'application/octet-stream' });
              } else if (f.content) {
                blob = new Blob([f.content], { type: f.type || 'text/plain' });
              } else {
                return {
                  success: false,
                  error: 'Cannot synthesize file without base64 or content bytes',
                };
              }
              let fileObj: any;
              if (typeof File !== 'undefined') {
                fileObj = new File([blob], f.name || 'uploaded-file', {
                  type: f.type || blob.type,
                  lastModified: Date.now(),
                });
              } else {
                fileObj = Object.assign(blob, {
                  name: f.name || 'uploaded-file',
                  lastModified: Date.now(),
                });
              }
              dt.items.add(fileObj);
            }

            try {
              (el as HTMLInputElement).files = dt.files;
            } catch {
              Object.defineProperty(el, 'files', {
                value: dt.files,
                configurable: true,
                writable: true,
              });
            }
            el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
            return { success: true, fileCount: dt.files.length };
          } catch (err) {
            return {
              success: false,
              error: `DataTransfer synthesis failed: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        },
        args: [options.index, options.selector, options.files],
      });
      return (
        results?.[0]?.result || { success: false, error: 'Script injection returned no result' }
      );
    } catch (injErr) {
      return {
        success: false,
        error: `Failed to inject DataTransfer upload script: ${injErr instanceof Error ? injErr.message : String(injErr)}`,
      };
    }
  }
}

export const fileUploadTool = new FileUploadTool();
