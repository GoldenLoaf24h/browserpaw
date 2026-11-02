import type {
  InteractionExecutionStatus,
  InteractionOutcome,
  InteractionVerificationStatus,
} from 'chrome-mcp-shared';
import type { ToolResult } from '@/common/tool-handler';

export function makeInteractionOutcome(
  executionStatus: InteractionExecutionStatus,
  verificationStatus: InteractionVerificationStatus = 'not_requested',
  reason?: string,
  dispatchedCount?: number,
): InteractionOutcome {
  return {
    execution: {
      status: executionStatus,
      ...(reason ? { reason } : {}),
      ...(typeof dispatchedCount === 'number' ? { dispatchedCount } : {}),
    },
    verification: {
      status: verificationStatus,
      ...(verificationStatus === 'failed' && reason ? { reason } : {}),
    },
  };
}

export function inferFillInteraction(result: {
  success?: boolean;
  committed?: boolean;
  status?: string;
  pressEnterDispatched?: boolean;
  submitted?: boolean;
  error?: string;
}): InteractionOutcome {
  const executionStatus =
    result.status === 'unknown'
      ? 'unknown'
      : result.committed || result.success || result.pressEnterDispatched || result.submitted
        ? 'dispatched'
        : 'not_dispatched';
  const verificationStatus =
    result.committed || result.success
      ? 'verified'
      : result.status === 'unknown' || result.status === 'blocked'
        ? 'not_requested'
        : 'failed';
  return makeInteractionOutcome(
    executionStatus,
    verificationStatus,
    result.error,
    executionStatus === 'dispatched' ? 1 : 0,
  );
}

export function createInteractionErrorResponse(
  message: string,
  interaction: InteractionOutcome,
  details: Record<string, unknown> = {},
): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: false,
          ...details,
          error: message,
          interaction,
        }),
      },
    ],
    isError: true,
  };
}
