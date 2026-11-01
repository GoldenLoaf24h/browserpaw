const KEY = 'browserpaw_browser_instance_id';
let pending: Promise<string> | undefined;

/** storage.session survives worker suspension, but never a new browser session. */
export function getBrowserInstanceId(): Promise<string> {
  if (!pending) {
    pending = (async () => {
      const stored = await chrome.storage.session.get(KEY);
      if (typeof stored[KEY] === 'string' && stored[KEY]) return stored[KEY];
      const id = crypto.randomUUID();
      await chrome.storage.session.set({ [KEY]: id });
      return id;
    })().catch((error) => {
      pending = undefined;
      throw error;
    });
  }
  return pending;
}
