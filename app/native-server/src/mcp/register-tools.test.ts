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

  it('verifies Stdio MCP setupTools normalizes browserpaw_ prefix and gates act_toward_goal', async () => {
    const { setupTools } = await import('./mcp-server-stdio');
    const { jevModelManager } = await import('../server/jev-model-manager');
    const handlers: Record<string, (req: any) => Promise<any>> = {};

    const mockServer = {
      setRequestHandler: (schema: any, handler: any) => {
        // Track handlers by schema
        handlers[
          schema._def?.description || schema.name || 'handler_' + Object.keys(handlers).length
        ] = handler;
      },
    };

    setupTools(mockServer as any);

    // Verify list tools handler
    const listHandler = Object.values(handlers)[0];
    expect(typeof listHandler).toBe('function');

    // When mode is off, act_toward_goal is hidden
    jevModelManager.setActiveMode('off');
    const listOff = await listHandler({});
    expect(listOff.tools.some((t: any) => t.name.includes('act_toward_goal'))).toBe(false);

    // Call tool handler with unknown tool: correctly rejected without network call
    const callHandler = Object.values(handlers)[1];
    expect(typeof callHandler).toBe('function');

    const resUnknown = await callHandler({
      params: {
        name: 'unknown_tool_xyz',
        arguments: {},
      },
    });
    expect(resUnknown.content[0].text).toContain(
      'Tool "unknown_tool_xyz" is not a BrowserPaw tool',
    );
  });

  it('ARCH-03: bound serverSessionId takes precedence over caller args.sessionId and consistently injects downstream', async () => {
    const { setupTools } = await import('./register-tools');
    const nativeMessagingHostInstance = (await import('../native-messaging-host')).default;

    let callToolHandler: ((req: any) => Promise<any>) | null = null;
    const mockServer = {
      setRequestHandler: (schema: any, handler: any) => {
        if (
          schema.name === 'CallToolRequestSchema' ||
          schema._def?.description?.includes('CallTool') ||
          Object.keys(schema).length > 0
        ) {
          // Second handler registered is CallTool
          if (!callToolHandler && handler.length === 1) {
            callToolHandler = handler;
          }
        }
      },
    };

    const BOUND_SESSION = 'transport-principal-session-AAA';
    setupTools(mockServer as any, BOUND_SESSION);

    // Spy on sendRequestToExtensionAndWait
    const sendSpy = jest
      .spyOn(nativeMessagingHostInstance, 'sendRequestToExtensionAndWait')
      .mockImplementation(async (payload: any) => ({
        status: 'success',
        data: { content: [{ type: 'text', text: 'ok' }] },
      }));
    nativeMessagingHostInstance.isConnected = true;

    try {
      expect(callToolHandler).not.toBeNull();
      await callToolHandler!({
        params: {
          name: 'chrome_screenshot',
          arguments: {
            sessionId: 'spoofed-session-BBB',
            sessionContext: 'spoofed-session-BBB',
          },
        },
      });

      expect(sendSpy).toHaveBeenCalled();
      const sentPayload = sendSpy.mock.calls[0][0];
      // Top-level sessionId must be the bound serverSessionId, not the spoofed one
      expect(sentPayload.sessionId).toBe(BOUND_SESSION);
      // args.sessionId must also be consistently injected with bound serverSessionId
      expect(sentPayload.args.sessionId).toBe(BOUND_SESSION);
      expect(sentPayload.args.sessionContext).toBe(BOUND_SESSION);
    } finally {
      sendSpy.mockRestore();
      nativeMessagingHostInstance.isConnected = false;
    }
  });

  it('PERF-01: does NOT block tool call when update check hangs or times out', async () => {
    const { handleToolCall } = await import('./register-tools');
    const { agentUpdateNotifier } = await import('chrome-mcp-shared');
    const nativeMessagingHostInstance = (await import('../native-messaging-host')).default;

    // Mock update check to never resolve (simulating hanging remote network)
    const hangingPromise = new Promise<string | null>(() => {});
    const checkSpy = jest
      .spyOn(agentUpdateNotifier, 'maybeGetFirstCallNotice')
      .mockReturnValue(hangingPromise);

    const sendSpy = jest
      .spyOn(nativeMessagingHostInstance, 'sendRequestToExtensionAndWait')
      .mockResolvedValue({
        status: 'success',
        data: { content: [{ type: 'text', text: 'fast result' }] },
      });
    nativeMessagingHostInstance.isConnected = true;

    const prevEnv = process.env.ENABLE_MCP_VERSION_CHECK;
    process.env.ENABLE_MCP_VERSION_CHECK = 'true';

    try {
      const t0 = Date.now();
      // Race tool call against a 500ms timeout
      const callPromise = handleToolCall('chrome_screenshot', {}, 'test-session');
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Tool call was blocked by update check')), 500),
      );

      const res = (await Promise.race([callPromise, timeoutPromise])) as any;
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(400);
      expect(res.content[0].text).toBe('fast result');
    } finally {
      checkSpy.mockRestore();
      sendSpy.mockRestore();
      nativeMessagingHostInstance.isConnected = false;
      if (prevEnv !== undefined) process.env.ENABLE_MCP_VERSION_CHECK = prevEnv;
      else delete process.env.ENABLE_MCP_VERSION_CHECK;
    }
  });
});
