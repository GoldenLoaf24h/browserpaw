export interface CaptchaDetectionResult {
  detected: boolean;
  type?: string;
}

export function inPageCheckCaptcha(): { detected: boolean; type?: string } {
  try {
    const captchaSelectors = [
      '#captcha_modal',
      '.geetest_holder',
      '.nc_wrapper',
      '#nc_1_wrapper',
      '.yidun_modal',
      '.tcaptcha-transform',
      'iframe[src*="captcha"]',
      'iframe[src*="recaptcha"]',
      'iframe[src*="hcaptcha"]',
      'iframe[src*="turnstile"]',
      'iframe[src*="challenges.cloudflare.com"]',
      'iframe[src*="arkoselabs"]',
      'iframe[src*="funcaptcha"]',
      '.cf-turnstile',
      '#cf-turnstile',
      'div[class*="cf-turnstile" i]',
      '.h-captcha',
      '#hcaptcha',
      'div[class*="hcaptcha" i]',
      '#arkose',
      'div[id*="arkose" i]',
      'div[class*="arkose" i]',
      'div[id*="aws-waf" i]',
      'div[class*="aws-waf" i]',
      'div[class*="captcha" i]',
      'div[id*="captcha" i]',
      '.slider-verify',
      '.slide-verify',
      '[data-testid*="captcha" i]',
      '[data-testid*="turnstile" i]',
    ];
    for (const sel of captchaSelectors) {
      const els = document.querySelectorAll(sel);
      for (const el of Array.from(els)) {
        if (el && el instanceof HTMLElement) {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          if (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            (el.offsetWidth > 0 || el.offsetHeight > 0 || rect.width > 0 || rect.height > 0)
          ) {
            return { detected: true, type: sel };
          }
        }
      }
    }
  } catch {}
  return { detected: false };
}

/**
 * In-page rich text media insertion engine.
 * Synthesizes ClipboardEvent('paste') and DragEvent('drop') containing a real File object
 * inside a DataTransfer container, bypassing browser clipboard security sandboxes.
 */
