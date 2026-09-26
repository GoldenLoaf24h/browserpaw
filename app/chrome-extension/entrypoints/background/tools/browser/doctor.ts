import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { STORAGE_KEYS, NATIVE_HOST } from '@/common/constants';

interface DoctorParams {
  verbose?: boolean;
}

class DoctorTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.DOCTOR;

  async execute(args: DoctorParams): Promise<ToolResult> {
    try {
      const windowMode =
        (await chrome.storage.local.get('agentWindowMode'))?.agentWindowMode || 'tab';
      const cursorMode =
        (await chrome.storage.local.get('agentCursorMode'))?.agentCursorMode || 'always';
      const controlEnabled =
        (await chrome.storage.session.get('agentControlEnabled'))?.agentControlEnabled !== false;

      // Check Native Server port connectivity
      let serverPort: number = NATIVE_HOST.DEFAULT_PORT;
      try {
        const stored = await chrome.storage.local.get([
          STORAGE_KEYS.SERVER_STATUS,
          STORAGE_KEYS.NATIVE_SERVER_PORT,
        ]);
        const candidatePort =
          stored?.[STORAGE_KEYS.SERVER_STATUS]?.port || stored?.[STORAGE_KEYS.NATIVE_SERVER_PORT];
        const numPort = Number(candidatePort);
        if (Number.isInteger(numPort) && numPort > 0 && numPort <= 65535) {
          serverPort = numPort;
        }
      } catch {}

      let serverStatus = 'unknown';
      let serverLatencyMs = 0;
      try {
        const start = performance.now();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1200);
        const res = await fetch(`http://127.0.0.1:${serverPort}/ping`, {
          signal: controller.signal,
        });
        clearTimeout(timeout);
        serverLatencyMs = Math.round(performance.now() - start);
        serverStatus = res.ok ? 'connected' : 'unreachable';
      } catch {
        serverStatus = 'offline';
      }

      // Query active tabs and windows
      const tabs = await chrome.tabs.query({});
      const allWindows = await chrome.windows.getAll().catch(() => []);
      const windowCount = Math.max(1, allWindows.length);

      const checks = [
        {
          name: `Native Server Port (${serverPort})`,
          status: serverStatus === 'connected' ? 'pass' : 'fail',
          detail:
            serverStatus === 'connected'
              ? `Online (ping: ${serverLatencyMs}ms)`
              : 'Server unreachable or offline',
        },
        {
          name: 'Agent Automation Switch',
          status: controlEnabled ? 'pass' : 'warn',
          detail: controlEnabled ? 'Enabled' : 'Disabled via popup toggle',
        },
        {
          name: 'Virtual Cursor Engine',
          status: cursorMode === 'off' ? 'warn' : 'pass',
          detail: `Mode: ${cursorMode}`,
        },
        {
          name: 'Window Isolation Mode',
          status: 'pass',
          detail: `Mode: ${windowMode} (${windowMode === 'window' ? 'Dedicated OS Window' : 'Current Window Tab Group'})`,
        },
        {
          name: 'Chrome Tabs Managed',
          status: 'pass',
          detail: `${tabs.length} tabs open across ${windowCount === 1 ? '1 window' : `${windowCount} windows`}`,
        },
      ];

      const allPassed = checks.every((c) => c.status === 'pass');

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                healthy: allPassed,
                summary: allPassed
                  ? 'All BrowserPaw core components healthy'
                  : 'Some environment warnings detected',
                checks,
                ...(args?.verbose
                  ? {
                      extensionId: chrome.runtime.id,
                      manifestVersion: chrome.runtime.getManifest().version,
                    }
                  : {}),
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    } catch (error) {
      return createErrorResponse(
        `Doctor check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const doctorTool = new DoctorTool();
