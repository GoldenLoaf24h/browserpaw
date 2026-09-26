import { describe, expect, it, beforeEach } from '@jest/globals';
import {
  AgentUpdateNotifier,
  formatAgentUpdateNotice,
  MemoryVersionCacheStorage,
} from 'chrome-mcp-shared';

describe('AgentUpdateNotifier - Strict Single-Turn Update Prompt Enforcement', () => {
  let notifier: AgentUpdateNotifier;
  let storage: MemoryVersionCacheStorage;

  beforeEach(() => {
    notifier = new AgentUpdateNotifier();
    storage = new MemoryVersionCacheStorage();
  });

  it('attaches update notice strictly on the first MCP call when an update exists', async () => {
    const now = Date.now();
    storage.set({
      latestVersion: '2.10.0',
      releaseUrl: 'https://github.com/GoldenLoaf24h/browserpaw/releases/tag/v2.10.0',
      lastChecked: now,
      expiresAt: now + 3600_000,
    });

    // 1st tool call: must receive notice
    const notice1 = await notifier.maybeGetFirstCallNotice({
      currentVersion: '2.9.3',
      storage,
    });

    expect(notice1).not.toBeNull();
    expect(notice1).toContain('System Notice: A new version of BrowserPaw is available');
    expect(notice1).toContain('v2.10.0');
    expect(notice1).toContain('https://github.com/GoldenLoaf24h/browserpaw/releases/tag/v2.10.0');

    // 2nd tool call: strictly forbidden from appearing again! Must return null!
    const notice2 = await notifier.maybeGetFirstCallNotice({
      currentVersion: '2.9.3',
      storage,
    });
    expect(notice2).toBeNull();

    // 3rd tool call: strictly null
    const notice3 = await notifier.maybeGetFirstCallNotice({
      currentVersion: '2.9.3',
      storage,
    });
    expect(notice3).toBeNull();
  });

  it('returns null and does not prompt if current version is up to date', async () => {
    const now = Date.now();
    storage.set({
      latestVersion: '2.9.3',
      releaseUrl: 'https://github.com/GoldenLoaf24h/browserpaw/releases/tag/v2.9.3',
      lastChecked: now,
      expiresAt: now + 3600_000,
    });

    // 1st call: up to date -> null
    const notice1 = await notifier.maybeGetFirstCallNotice({
      currentVersion: '2.9.3',
      storage,
    });
    expect(notice1).toBeNull();

    // 2nd call: still null
    const notice2 = await notifier.maybeGetFirstCallNotice({
      currentVersion: '2.9.3',
      storage,
    });
    expect(notice2).toBeNull();
  });

  it('guarantees zero false-positives when remote version check fails or is malformed', async () => {
    const now = Date.now();
    storage.set({
      latestVersion: 'not-a-valid-version',
      releaseUrl: 'https://github.com/GoldenLoaf24h/browserpaw/releases',
      lastChecked: now,
      expiresAt: now + 3600_000,
    });

    const notice = await notifier.maybeGetFirstCallNotice({
      currentVersion: '2.9.3',
      storage,
    });

    expect(notice).toBeNull();
  });

  it('formatAgentUpdateNotice formats a clean, informative system prompt', () => {
    const formatted = formatAgentUpdateNotice(
      '2.11.0',
      'https://github.com/GoldenLoaf24h/browserpaw/releases/latest',
    );
    expect(formatted).toBe(
      '[System Notice: A new version of BrowserPaw is available (v2.11.0). It is recommended to update to the latest release for new features and improvements: https://github.com/GoldenLoaf24h/browserpaw/releases/latest]',
    );
  });

  it('verifies tool profile promotion and purge flags for Jev', async () => {
    const { filterToolSchemas, TOOL_SCHEMAS } = await import('chrome-mcp-shared');

    // 1. Without key & with purge flag -> chrome_act_toward_goal is completely purged
    const prevKey = process.env.TYPESAFE_API_KEY;
    const prevJevKey = process.env.JEV_API_KEY;
    const prevPurge = process.env.BROWSERPAW_DISABLE_JEV_WITHOUT_KEY;
    const prevPromote = process.env.CHROME_MCP_AUTO_PROMOTE_JEV;

    delete process.env.TYPESAFE_API_KEY;
    delete process.env.JEV_API_KEY;
    process.env.BROWSERPAW_DISABLE_JEV_WITHOUT_KEY = 'true';

    const fullPurged = filterToolSchemas(TOOL_SCHEMAS, 'full');
    expect(fullPurged.some((t) => t.name === 'chrome_act_toward_goal')).toBe(false);

    // 2. With key & with auto-promote flag -> chrome_act_toward_goal is in core profile
    delete process.env.BROWSERPAW_DISABLE_JEV_WITHOUT_KEY;
    process.env.TYPESAFE_API_KEY = 'test-typesafe-key';
    process.env.CHROME_MCP_AUTO_PROMOTE_JEV = 'true';

    const corePromoted = filterToolSchemas(TOOL_SCHEMAS, 'core');
    expect(corePromoted.some((t) => t.name === 'chrome_act_toward_goal')).toBe(true);

    // Restore environment
    if (prevKey !== undefined) process.env.TYPESAFE_API_KEY = prevKey;
    else delete process.env.TYPESAFE_API_KEY;
    if (prevJevKey !== undefined) process.env.JEV_API_KEY = prevJevKey;
    else delete process.env.JEV_API_KEY;
    if (prevPurge !== undefined) process.env.BROWSERPAW_DISABLE_JEV_WITHOUT_KEY = prevPurge;
    else delete process.env.BROWSERPAW_DISABLE_JEV_WITHOUT_KEY;
    if (prevPromote !== undefined) process.env.CHROME_MCP_AUTO_PROMOTE_JEV = prevPromote;
    else delete process.env.CHROME_MCP_AUTO_PROMOTE_JEV;
  });
});
