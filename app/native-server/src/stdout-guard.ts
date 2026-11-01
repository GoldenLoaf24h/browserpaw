import { Console } from 'node:console';

// Native messaging and MCP stdio own stdout; any console output there corrupts the protocol.
export function reserveStdoutForProtocol(): void {
  Object.assign(console, new Console(process.stderr));
}
