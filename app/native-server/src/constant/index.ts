import { DEFAULT_SERVER_PORT } from 'chrome-mcp-shared';

export const TIMEOUTS = {
  DEFAULT_REQUEST_TIMEOUT: 15000,
} as const;

export function getBrowserPawPort(): number {
  const value = process.env.BROWSERPAW_PORT;
  if (!value) return DEFAULT_SERVER_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('BROWSERPAW_PORT must be a port from 1 to 65535.');
  return port;
}
