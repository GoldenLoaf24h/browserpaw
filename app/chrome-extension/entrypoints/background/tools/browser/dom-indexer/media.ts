import { findIndexedElement, getDeepActiveElement } from '../dom-indexer';

export interface InsertMediaOptions {
  base64Data: string;
  fileName?: string;
  mimeType?: string;
  index?: number;
  selector?: string;
}

export interface InsertMediaResult {
  success: boolean;
  target?: {
    tagName: string;
    selector?: string;
    isContentEditable: boolean;
    index?: number;
  };
  dispatchedEvents: string[];
  fileName: string;
  mimeType: string;
  fileSize: number;
  error?: string;
}

export function inPageInsertMedia(options: {
  base64Data: string;
  fileName?: string;
  mimeType?: string;
  index?: number;
  selector?: string;
}): {
  success: boolean;
  target?: {
    tagName: string;
    selector?: string;
    isContentEditable: boolean;
    index?: number;
  };
  dispatchedEvents: string[];
  fileName: string;
  mimeType: string;
  fileSize: number;
  error?: string;
} {
  try {
    let targetEl: Element | null = null;
    const targetIndex = options.index;

    if (typeof targetIndex === 'number' && targetIndex > 0) {
      targetEl = findIndexedElement(targetIndex);
    } else if (options.selector) {
      try {
        targetEl = document.querySelector(options.selector);
      } catch {}
    }

    // If no explicit target, prefer document.activeElement if editable
    if (!targetEl) {
      const active = getDeepActiveElement();
      if (
        active &&
        active !== document.body &&
        active !== document.documentElement &&
        ((active as HTMLElement).isContentEditable ||
          active.getAttribute('contenteditable') === 'true' ||
          active.tagName === 'TEXTAREA' ||
          active.getAttribute('role') === 'textbox')
      ) {
        targetEl = active;
      }
    }

    // If still no target, locate the primary composer / rich text editor on page
    if (!targetEl) {
      const composerSelectors = [
        '[data-lexical-editor="true"]',
        '.DraftEditor-root [contenteditable="true"]',
        '.drafteditor-root [contenteditable="true"]',
        '.ProseMirror[contenteditable="true"]',
        '.ProseMirror',
        '.ql-editor',
        '.monaco-editor [contenteditable="true"]',
        '.cm-content[contenteditable="true"]',
        '.tiptap',
        '[data-testid*="composer" i]',
        '[data-testid*="editor" i]',
        '[data-testid*="post" i]',
        '[data-testid*="tweet" i]',
        '[data-testid*="comment" i]',
        '[data-testid*="message" i]',
        '[data-testid*="chat" i]',
        '[contenteditable="true"]',
        '[role="textbox"]',
        'div[aria-label*="post" i][contenteditable="true"]',
        'div[aria-label*="comment" i][contenteditable="true"]',
        'div[aria-label*="write" i][contenteditable="true"]',
        'div[aria-label*="message" i][contenteditable="true"]',
        'textarea',
      ];
      for (const sel of composerSelectors) {
        const found = document.querySelector(sel);
        if (found) {
          targetEl = found;
          break;
        }
      }
    }

    if (!targetEl) {
      targetEl = document.body;
    }

    // Scroll into view & focus
    try {
      if (typeof (targetEl as any).scrollIntoView === 'function') {
        targetEl.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as any });
      }
      if (typeof (targetEl as HTMLElement).focus === 'function') {
        (targetEl as HTMLElement).focus();
      }
    } catch {}

    const cleanBase64 = (options.base64Data || '').replace(/^data:.*?;base64,/, '').trim();
    if (!cleanBase64) {
      return {
        success: false,
        dispatchedEvents: [],
        fileName: options.fileName || 'unknown',
        mimeType: options.mimeType || 'application/octet-stream',
        fileSize: 0,
        error: 'base64Data must be a non-empty string',
      };
    }

    // Convert base64 string to Uint8Array
    let byteArray: Uint8Array;
    if (typeof atob === 'function') {
      const binaryString = atob(cleanBase64);
      const len = binaryString.length;
      byteArray = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        byteArray[i] = binaryString.charCodeAt(i);
      }
    } else if (typeof Buffer !== 'undefined') {
      byteArray = new Uint8Array(Buffer.from(cleanBase64, 'base64'));
    } else {
      byteArray = new Uint8Array(0);
    }

    const extMatch = (options.fileName || '').match(/\.([a-zA-Z0-9]+)$/);
    const ext = extMatch ? extMatch[1].toLowerCase() : '';
    let mimeType = options.mimeType;
    if (!mimeType) {
      if (ext === 'png') mimeType = 'image/png';
      else if (ext === 'jpg' || ext === 'jpeg') mimeType = 'image/jpeg';
      else if (ext === 'gif') mimeType = 'image/gif';
      else if (ext === 'webp') mimeType = 'image/webp';
      else if (ext === 'svg') mimeType = 'image/svg+xml';
      else mimeType = 'image/png';
    }

    const fileName = options.fileName || `media-${Date.now()}.${mimeType.split('/')[1] || 'png'}`;

    // Construct File and DataTransfer
    let dt: DataTransfer | null = null;
    let fileObj: any = null;
    if (typeof File === 'function') {
      try {
        fileObj = new File([byteArray as any], fileName, {
          type: mimeType,
          lastModified: Date.now(),
        });
      } catch {}
    }
    if (!fileObj && typeof Blob === 'function') {
      try {
        fileObj = new Blob([byteArray as any], { type: mimeType });
      } catch {}
    }
    if (!fileObj) {
      fileObj = {
        name: fileName,
        type: mimeType,
        size: byteArray.length,
        lastModified: Date.now(),
      };
    }
    try {
      Object.defineProperty(fileObj, 'name', {
        value: fileName,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(fileObj, 'type', {
        value: mimeType,
        writable: true,
        configurable: true,
      });
    } catch {}

    if (typeof DataTransfer === 'function') {
      try {
        dt = new DataTransfer();
        if (fileObj) {
          try {
            dt.items.add(fileObj);
          } catch {}
          try {
            Object.defineProperty(dt, 'files', {
              get: () => [fileObj],
              configurable: true,
            });
          } catch {}
        }
      } catch {}
    }

    const dispatchedEvents: string[] = [];

    // 1. Dispatch synthetic ClipboardEvent('paste')
    try {
      let pasteEvent: any;
      if (typeof ClipboardEvent === 'function') {
        try {
          pasteEvent = new ClipboardEvent('paste', {
            bubbles: true,
            cancelable: true,
            composed: true,
            clipboardData: dt || undefined,
          });
        } catch {
          pasteEvent = new Event('paste', { bubbles: true, cancelable: true, composed: true });
        }
      } else {
        pasteEvent = new Event('paste', { bubbles: true, cancelable: true, composed: true });
      }

      const clipboardDataObj = {
        items: [
          {
            kind: 'file',
            type: mimeType,
            getAsFile: () => fileObj,
          },
        ],
        files: [fileObj],
        types: ['Files'],
        getData: () => '',
        setData: () => {},
        clearData: () => {},
      };

      try {
        Object.defineProperty(pasteEvent, 'clipboardData', {
          get: () => clipboardDataObj,
          configurable: true,
        });
      } catch {
        try {
          pasteEvent.clipboardData = clipboardDataObj;
        } catch {}
      }

      targetEl.dispatchEvent(pasteEvent);
      dispatchedEvents.push('paste');
    } catch {}

    // 2. Dispatch synthetic DragEvent dragenter -> dragover -> drop
    try {
      const dragDataObj = {
        items: [
          {
            kind: 'file',
            type: mimeType,
            getAsFile: () => fileObj,
          },
        ],
        files: [fileObj],
        types: ['Files'],
        getData: () => '',
        setData: () => {},
        clearData: () => {},
      };

      const createDragEvent = (type: string) => {
        let ev: any;
        if (typeof DragEvent === 'function') {
          try {
            ev = new DragEvent(type, {
              bubbles: true,
              cancelable: true,
              composed: true,
              dataTransfer: dt || undefined,
            });
          } catch {
            ev = new Event(type, { bubbles: true, cancelable: true, composed: true });
          }
        } else {
          ev = new Event(type, { bubbles: true, cancelable: true, composed: true });
        }
        try {
          Object.defineProperty(ev, 'dataTransfer', {
            get: () => dragDataObj,
            configurable: true,
          });
        } catch {
          try {
            ev.dataTransfer = dragDataObj;
          } catch {}
        }
        return ev;
      };

      targetEl.dispatchEvent(createDragEvent('dragenter'));
      targetEl.dispatchEvent(createDragEvent('dragover'));
      targetEl.dispatchEvent(createDragEvent('drop'));
      dispatchedEvents.push('drop');
    } catch {}

    // 3. Dispatch beforeinput with insertFromPaste
    try {
      if (typeof InputEvent === 'function') {
        const beforeInput = new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          composed: true,
          inputType: 'insertFromPaste',
          dataTransfer: dt || undefined,
        } as any);
        targetEl.dispatchEvent(beforeInput);
        dispatchedEvents.push('beforeinput');
      }
    } catch {}

    const isContentEditable = Boolean(
      (targetEl as HTMLElement).isContentEditable ||
      targetEl.getAttribute('contenteditable') === 'true' ||
      targetEl.getAttribute('contenteditable') === '',
    );

    const targetId = targetEl.id ? `#${targetEl.id}` : '';
    const selector = targetId || targetEl.tagName.toLowerCase();

    return {
      success: true,
      target: {
        tagName: targetEl.tagName.toLowerCase(),
        selector,
        isContentEditable,
        ...(typeof targetIndex === 'number' ? { index: targetIndex } : {}),
      },
      dispatchedEvents,
      fileName,
      mimeType,
      fileSize: byteArray.length,
    };
  } catch (err: any) {
    return {
      success: false,
      dispatchedEvents: [],
      fileName: options.fileName || 'unknown',
      mimeType: options.mimeType || 'application/octet-stream',
      fileSize: 0,
      error: err?.message || String(err),
    };
  }
}

/**
 * Retrieve current scroll and viewport geometry in the page.
 * Used for real-time drift compensation between screenshot capture and click execution.
 */
