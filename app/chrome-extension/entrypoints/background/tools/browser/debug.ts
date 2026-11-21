import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { BaseBrowserToolExecutor } from '../base-browser';
import {
  performanceAnalyzeInsightTool,
  performanceStartTraceTool,
  performanceStopTraceTool,
} from './performance';
import { cancelFileOperation, sendFileOperationToNative } from '../../native-host';

interface PdfOutputFile {
  path: string;
  name?: string;
  bytes?: number;
  mimeType: 'application/pdf';
  outputPath?: string;
}

export interface PdfReceipt {
  success: true;
  tabId: number;
  url: string;
  filePath: string;
  fileName?: string;
  bytes?: number;
  mimeType: 'application/pdf';
  file: PdfOutputFile;
}

interface DebugParams {
  action:
    | 'perf_metrics'
    | 'perf_trace_start'
    | 'perf_trace_stop'
    | 'perf_trace_analyze'
    | 'emulate'
    | 'emulate_reset'
    | 'pdf';
  tabId?: number;
  sessionId?: string;
  sessionContext?: string;
  reload?: boolean;
  autoStop?: boolean;
  durationMs?: number;
  insightName?: string;
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  mobile?: boolean;
  userAgent?: string;
  colorScheme?: 'light' | 'dark' | 'no-preference';
  timezoneId?: string;
  locale?: string;
  cpuRate?: number;
  offline?: boolean;
  latency?: number;
  downloadThroughput?: number;
  uploadThroughput?: number;
  landscape?: boolean;
  printBackground?: boolean;
  paper?: string;
  margin?: number;
  scale?: number;
  displayHeaderFooter?: boolean;
  outputPath?: string;
}

const PAPERS: Record<string, { width: number; height: number }> = {
  a4: { width: 8.27, height: 11.69 },
  letter: { width: 8.5, height: 11 },
  legal: { width: 8.5, height: 14 },
};

async function savePdfTemp(base64: string, fileName: string) {
  const requestId = `pdf-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise<{ filePath: string; fileName: string; size?: number }>((resolve, reject) => {
    const timer = setTimeout(() => {
      cancelFileOperation(requestId);
      reject(new Error('Native PDF save timed out.'));
    }, 60000);
    const sent = sendFileOperationToNative(
      {
        type: 'file_operation',
        requestId,
        payload: { action: 'prepareFile', base64Data: base64, fileName },
      },
      (message: any) => {
        clearTimeout(timer);
        if (message?.payload?.success && message.payload.filePath)
          resolve(message.payload as { filePath: string; fileName: string; size?: number });
        else reject(new Error(message?.payload?.error || 'Native PDF save failed.'));
      },
    );
    if (!sent) {
      clearTimeout(timer);
      reject(new Error('Native host is not connected for PDF output.'));
    }
  });
}

class DebugTool extends BaseBrowserToolExecutor {
  name = 'chrome_debug';

  async execute(args: DebugParams): Promise<ToolResult> {
    const sessionId = args?.sessionId || args?.sessionContext;
    if (args?.action === 'perf_trace_stop')
      return performanceStopTraceTool.execute({
        ...args,
        sessionId,
        saveToDownloads: false,
      });
    if (args?.action === 'perf_trace_analyze') return performanceAnalyzeInsightTool.execute(args);
    const tab = await this.resolveAffinityTab({ tabId: args?.tabId, sessionId }).catch(() => null);
    if (!tab?.id) return createErrorResponse('No target tab.');
    const tabId = tab.id;

    if (args.action === 'pdf') {
      const paper = PAPERS[String(args.paper || 'a4').toLowerCase()];
      if (!paper) return createErrorResponse('Paper must be a4, letter, or legal.');
      try {
        await cdpSessionManager.attach(tabId, 'debug');
        const margin = args.margin ?? 0.4;
        const result = (await cdpSessionManager.sendCommand(tabId, 'Page.printToPDF', {
          landscape: args.landscape === true,
          printBackground: args.printBackground !== false,
          paperWidth: paper.width,
          paperHeight: paper.height,
          marginTop: margin,
          marginBottom: margin,
          marginLeft: margin,
          marginRight: margin,
          scale: args.scale ?? 1,
          displayHeaderFooter: args.displayHeaderFooter === true,
        })) as { data?: string };
        if (!result.data) return createErrorResponse('Chrome returned no PDF data.');
        const saved = await savePdfTemp(
          result.data,
          `page-${new Date().toISOString().replace(/[:.]/g, '-')}.pdf`,
        );
        const pdfFile: PdfOutputFile = {
          path: saved.filePath,
          name: saved.fileName || 'page.pdf',
          bytes: saved.size,
          mimeType: 'application/pdf',
          outputPath: args.outputPath,
        };
        const response: PdfReceipt = {
          success: true,
          tabId,
          url: tab.url || '',
          filePath: saved.filePath,
          fileName: saved.fileName || 'page.pdf',
          bytes: saved.size,
          mimeType: 'application/pdf',
          file: pdfFile,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(response) }],
          structuredContent: response as unknown as Record<string, unknown>,
          isError: false,
        };
      } catch (error) {
        return createErrorResponse(
          `Debug pdf failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        await cdpSessionManager.detach(tabId, 'debug').catch(() => {});
      }
    }

    try {
      if (args.action !== 'perf_trace_start') await cdpSessionManager.attach(tabId, 'debug');
      if (args.action === 'perf_trace_start')
        return performanceStartTraceTool.execute({ ...args, tabId, sessionId });
      if (args.action === 'perf_metrics') {
        await cdpSessionManager.enableDomain(tabId, 'Performance');
        try {
          const result = (await cdpSessionManager.sendCommand(tabId, 'Performance.getMetrics')) as {
            metrics?: Array<{ name: string; value: number }>;
          };
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  tabId,
                  url: tab.url,
                  metrics: Object.fromEntries(
                    (result.metrics || []).map((metric) => [metric.name, metric.value]),
                  ),
                }),
              },
            ],
            isError: false,
          };
        } finally {
          await cdpSessionManager.disableDomain(tabId, 'Performance').catch(() => {});
        }
      }
      if (args.action === 'emulate' || args.action === 'emulate_reset') {
        const reset = args.action === 'emulate_reset';
        const sendEmulationCommand = async (
          method: string,
          params?: Record<string, unknown>,
        ) => {
          try {
            await cdpSessionManager.sendCommand(tabId, method, params);
          } catch (error) {
            if (!reset || !/only available to trusted clients/i.test(String(error))) {
              throw error;
            }
          }
        };
        if (
          reset ||
          args.width !== undefined ||
          args.height !== undefined ||
          args.deviceScaleFactor !== undefined
        ) {
          if (reset)
            await sendEmulationCommand('Emulation.clearDeviceMetricsOverride');
          else
            await sendEmulationCommand('Emulation.setDeviceMetricsOverride', {
              width: args.width ?? tab.width ?? 1280,
              height: args.height ?? tab.height ?? 720,
              deviceScaleFactor: args.deviceScaleFactor ?? 1,
              mobile: args.mobile === true,
            });
        }
        if (reset || args.colorScheme !== undefined)
          await sendEmulationCommand('Emulation.setEmulatedMedia', {
            features: reset ? [] : [{ name: 'prefers-color-scheme', value: args.colorScheme }],
          });
        if (reset || args.timezoneId !== undefined)
          await sendEmulationCommand('Emulation.setTimezoneOverride', {
            timezoneId: reset ? '' : args.timezoneId,
          });
        if (reset || args.locale !== undefined)
          await sendEmulationCommand('Emulation.setLocaleOverride', {
            locale: reset ? undefined : args.locale,
          });
        if (reset || args.userAgent !== undefined)
          await sendEmulationCommand('Emulation.setUserAgentOverride', {
            userAgent: reset ? '' : args.userAgent,
          });
        if (reset || args.cpuRate !== undefined)
          await sendEmulationCommand('Emulation.setCPUThrottlingRate', {
            rate: reset ? 1 : args.cpuRate,
          });
        if (
          reset ||
          args.offline !== undefined ||
          args.latency !== undefined ||
          args.downloadThroughput !== undefined ||
          args.uploadThroughput !== undefined
        )
          await sendEmulationCommand('Network.emulateNetworkConditions', {
            offline: reset ? false : args.offline === true,
            latency: reset ? 0 : (args.latency ?? 0),
            downloadThroughput: reset ? -1 : (args.downloadThroughput ?? -1),
            uploadThroughput: reset ? -1 : (args.uploadThroughput ?? -1),
          });
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, tabId, reset }) }],
          isError: false,
        };
      }
      return createErrorResponse('Unknown debug action.');
    } catch (error) {
      return createErrorResponse(
        `Debug ${args.action} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (args.action !== 'perf_trace_start')
        await cdpSessionManager.detach(tabId, 'debug').catch(() => {});
    }
  }
}

export const debugTool = new DebugTool();
