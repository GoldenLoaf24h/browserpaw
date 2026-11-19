#!/usr/bin/env node
import { reserveStdoutForProtocol } from './stdout-guard';
import server from './server';
import host from './native-messaging-host';
import { getBrowserPawPort } from './constant';

reserveStdoutForProtocol();
host.setServer(server);
host.start();

void Promise.resolve()
  .then(() => server.start(getBrowserPawPort(), host))
  .catch((error: unknown) => {
    console.error('BrowserPaw host startup failed:', error);
  });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void server.stop().finally(() => process.exit(0));
  });
}
