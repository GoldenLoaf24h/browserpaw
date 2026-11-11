export interface ConfirmationTrapInfo {
  detected: boolean;
  title?: string;
  buttons?: string[];
}

/**
 * Detect active confirmation trap dialogs (e.g. "Discard draft?", "放弃帖子？") on the page.
 */
export function inPageDetectConfirmationTrap(): ConfirmationTrapInfo {
  if (typeof document === 'undefined') return { detected: false };
  try {
    const dialogs = Array.from(
      document.querySelectorAll(
        'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]',
      ),
    ) as HTMLElement[];
    for (const d of dialogs) {
      const isAriaHidden = d.getAttribute('aria-hidden') === 'true';
      const isOpenAttr =
        d.tagName.toLowerCase() === 'dialog' ? (d as HTMLDialogElement).open : true;
      if (isAriaHidden || !isOpenAttr) continue;
      const win = d.ownerDocument?.defaultView || window;
      let isVis = false;
      try {
        const style = win.getComputedStyle(d);
        isVis =
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          (d.offsetWidth > 0 || d.offsetHeight > 0);
      } catch {}
      if (!isVis) continue;

      const title =
        d.getAttribute('aria-label') ||
        d.querySelector('h1, h2, h3, [role="heading"]')?.textContent?.trim()?.slice(0, 80) ||
        d.textContent?.slice(0, 150)?.trim();

      const textSnippet = `${d.tagName} ${title || ''} ${d.textContent?.slice(0, 300) || ''}`;
      const isTrap =
        /(discard|abandon|unsaved|confirm|放弃|取消|未保存|确认放弃|是否放弃|离开)/i.test(
          textSnippet,
        );

      if (isTrap) {
        const buttons = Array.from(d.querySelectorAll('button, [role="button"]'))
          .map((b) => b.textContent?.trim() || b.getAttribute('aria-label') || '')
          .filter(Boolean)
          .slice(0, 5);
        return {
          detected: true,
          title: title || 'Confirmation Dialog',
          buttons,
        };
      }
    }
  } catch {}
  return { detected: false };
}
