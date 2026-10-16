#!/usr/bin/env node
import serverInstance from './server';
import nativeMessagingHostInstance from './native-messaging-host';
import { registerRuntimeExtensionId } from './constant';

// Chrome launches the native host with the calling extension origin as the first
// argument (for example `chrome-extension://<id>/`). Trusting that argument keeps the
// origin allow-list honest for unpacked builds whose ID differs from the published one.
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
  // Ensure Fastify HTTP bridge is listening on 12306 immediately
  serverInstance.start(12306, nativeMessagingHostInstance).catch((error) => {
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
