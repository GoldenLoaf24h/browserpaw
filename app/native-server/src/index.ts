#!/usr/bin/env node
import serverInstance from './server';
import nativeMessagingHostInstance from './native-messaging-host';
import { getChromeMcpPort, registerRuntimeExtensionId } from './constant';

// Chrome launches the native host with the calling extension origin as the first
// argument (for example `chrome-extension://<id>/`) after checking allowed_origins.
// Registration must already include an unpacked ID; this admits that caller for HTTP.
for (const arg of process.argv.slice(1)) {
  const match = /^chrome-extension:\/\/([a-p]{32})\/?$/i.exec(arg);
  if (match) {
    registerRuntimeExtensionId(match[1]);
  }
}

try {
  serverInstance.setNativeHost(nativeMessagingHostInstance); // Server needs setNativeHost method
  nativeMessagingHostInstance.setServer(serverInstance); // NativeHost needs setServer method
  nativeMessagingHostInstance.start();
  // Ensure Fastify HTTP bridge is listening on the configured port immediately
  // (CHROME_MCP_PORT > MCP_HTTP_PORT > 12306), matching the clients that
  // resolve the same environment variables.
  serverInstance.start(getChromeMcpPort(), nativeMessagingHostInstance).catch((error) => {
    console.error('Native bridge startup failed:', error);
  });
} catch (error) {
  process.exit(1);
}

process.on('error', (error) => {
  process.exit(1);
});

// Handle process signals and uncaught exceptions
process.on('SIGINT', () => {
  process.exit(0);
});

process.on('SIGTERM', () => {
  process.exit(0);
});

process.on('exit', (code) => {});

process.on('uncaughtException', (error) => {
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  // Don't exit immediately, let the program continue running
});
