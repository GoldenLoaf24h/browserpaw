#!/usr/bin/env node
import serverInstance from './server';
import nativeMessagingHostInstance from './native-messaging-host';

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
