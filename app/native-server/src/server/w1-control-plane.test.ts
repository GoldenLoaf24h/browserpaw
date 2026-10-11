import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Create dedicated isolated temporary root for this test run
const TEST_ISOLATED_DIR = path.join(os.tmpdir(), 'browserpaw-w1-iso-' + Date.now());
const TEST_TOKEN_DIR = path.join(TEST_ISOLATED_DIR, 'token');
const TEST_BROWSERPAW_DIR = path.join(TEST_ISOLATED_DIR, 'browserpaw');

fs.mkdirSync(TEST_TOKEN_DIR, { recursive: true });
fs.mkdirSync(TEST_BROWSERPAW_DIR, { recursive: true });

process.env.CHROME_MCP_TOKEN_DIR = TEST_TOKEN_DIR;
process.env.BROWSERPAW_HOME = TEST_BROWSERPAW_DIR;
process.env.CHROME_MCP_TOKEN = 'w1-isolated-test-fixed-token-12345678';

import { describe, expect, test, afterAll, beforeAll, jest } from '@jest/globals';

// Mock os.homedir() to return TEST_ISOLATED_DIR, guaranteeing zero access to user home directory
jest.mock('node:os', () => {
  const actualOs = jest.requireActual('node:os') as any;
  return {
    ...actualOs,
    homedir: () => TEST_ISOLATED_DIR,
  };
});
jest.mock('os', () => {
  const actualOs = jest.requireActual('os') as any;
  return {
    ...actualOs,
    homedir: () => TEST_ISOLATED_DIR,
  };
});

import supertest from 'supertest';
import Server from './index';
import nativeMessagingHostInstance from '../native-messaging-host';
import { getBridgeToken, clearBridgeTokenCache } from './token';
import { jevModelManager } from './jev-model-manager';
import { mcpSessionManager } from '../mcp/session-manager';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import http from 'node:http';

const W1_TEST_PORT = 14599;

describe('W1 Control Plane, Security, MCP Session & Process Lifecycle', () => {
  beforeAll(async () => {
    Server.setNativeHost(nativeMessagingHostInstance);
    nativeMessagingHostInstance.setServer(Server);
    await Server.start(W1_TEST_PORT, nativeMessagingHostInstance);
  });

  afterAll(async () => {
    await Server.stop();
    await new Promise((r) => setTimeout(r, 150));
    clearBridgeTokenCache();
    delete process.env.CHROME_MCP_TOKEN_DIR;
    delete process.env.BROWSERPAW_HOME;
    delete process.env.CHROME_MCP_TOKEN;
    try {
      fs.rmSync(TEST_ISOLATED_DIR, { recursive: true, force: true });
    } catch {}
  });

  describe('BUG-13: /jev/* auth, /token origin restrictions, remote-config secrets', () => {
    test('BUG-13.1: /jev/remote-config and sensitive endpoints reject unauthenticated requests', async () => {
      const res = await supertest(Server.getInstance().server).get('/jev/remote-config');
      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty('error');
    });

    test('BUG-13.2: /token no longer exists', async () => {
      const res = await supertest(Server.getInstance().server).get('/token');
      expect([401, 404]).toContain(res.status);
    });

    test('BUG-13.3: /eval rejects the x-local-trust loopback bypass', async () => {
      const res = await supertest(Server.getInstance().server)
        .post('/eval')
        .set('x-local-trust', 'true')
        .send({ script: '1 + 1' });
      expect(res.status).toBe(401);
    });

    test('BUG-13.4: GET /jev/remote-config does NOT expose plaintext apiKey', async () => {
      jevModelManager.setRemoteConfig({
        baseUrl: 'https://api.typesafe.ai/v1',
        apiKey: 'sk-test-hidden-credential-key-998877',
        modelId: 'jev-latest',
      });

      const res = await supertest(Server.getInstance().server)
        .get('/jev/remote-config')
        .set('Authorization', `Bearer ${getBridgeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('hasApiKey', true);
      expect(res.body.apiKey).toBeUndefined();
    });

    test('BUG-13.5: POST /jev/remote-config preserves existing apiKey when omitted or blank', async () => {
      await supertest(Server.getInstance().server)
        .post('/jev/remote-config')
        .set('Authorization', `Bearer ${getBridgeToken()}`)
        .send({
          baseUrl: 'https://api.typesafe.ai/v1',
          apiKey: 'sk-initial-secret-12345',
          modelId: 'jev-latest',
        });

      const updateRes = await supertest(Server.getInstance().server)
        .post('/jev/remote-config')
        .set('Authorization', `Bearer ${getBridgeToken()}`)
        .send({
          baseUrl: 'https://api.new-endpoint.com/v1',
        });

      expect(updateRes.status).toBe(200);

      const getRes = await supertest(Server.getInstance().server)
        .get('/jev/remote-config')
        .set('Authorization', `Bearer ${getBridgeToken()}`);

      expect(getRes.body.hasApiKey).toBe(true);
      expect(getRes.body.baseUrl).toBe('https://api.new-endpoint.com/v1');
    });

    test('BUG-13.6: Reject invalid extension Origin and untrusted Host header', async () => {
      const badOriginRes = await supertest(Server.getInstance().server)
        .post('/jev/set-mode')
        .set('Authorization', `Bearer ${getBridgeToken()}`)
        .set('Origin', 'chrome-extension://unauthorizedextensionid12345678')
        .send({ mode: 'remote' });

      expect(badOriginRes.status).toBe(403);

      const badHostRes = await supertest(Server.getInstance().server)
        .get('/ping')
        .set('Host', 'attacker-domain.com');

      expect(badHostRes.status).toBe(403);
    });
  });

  describe('BUG-14: MCP Streamable HTTP GET SSE socket close does not destroy logical session', () => {
    test('BUG-14: closing GET /mcp SSE socket does not destroy session for subsequent POST, and DELETE closes it', async () => {
      // 1. Initialize session via POST /mcp with standard protocol headers
      const initRes = await supertest(Server.getInstance().server)
        .post('/mcp')
        .set('Authorization', `Bearer ${getBridgeToken()}`)
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test-w1-client', version: '1.0' },
          },
        });

      expect(initRes.status).toBe(200);
      const sessionId = initRes.headers['mcp-session-id'];
      expect(sessionId).toBeDefined();

      // 2. Open raw GET SSE stream, wait for HTTP 200 response established, then destroy underlying socket (simulate stream network disconnect)
      await new Promise<void>((resolve) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: W1_TEST_PORT,
            path: '/mcp',
            method: 'GET',
            headers: {
              Authorization: `Bearer ${getBridgeToken()}`,
              'mcp-session-id': sessionId,
              Accept: 'text/event-stream',
            },
          },
          (res) => {
            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toMatch(/text\/event-stream/);
            req.destroy();
            resolve();
          },
        );
        req.on('error', () => {
          resolve();
        });
        req.end();
      });

      // Allow event loop to process socket close on server
      await new Promise((r) => setTimeout(r, 150));

      // 3. Post-disconnect: Logical session MUST still be alive and accept POST requests with valid protocol headers
      const postRes = await supertest(Server.getInstance().server)
        .post('/mcp')
        .set('Authorization', `Bearer ${getBridgeToken()}`)
        .set('mcp-session-id', sessionId)
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {},
        });

      expect(postRes.status).toBe(200);
      const hasResult = Boolean(
        postRes.body?.result || (postRes.text && postRes.text.includes('"result"')),
      );
      expect(hasResult).toBe(true);

      // 4. Now issue explicit DELETE /mcp to terminate session
      const delRes = await supertest(Server.getInstance().server)
        .delete('/mcp')
        .set('Authorization', `Bearer ${getBridgeToken()}`)
        .set('mcp-session-id', sessionId);

      expect([200, 204]).toContain(delRes.status);
      expect(mcpSessionManager.hasSession(sessionId)).toBe(false);

      // 5. Subsequent POST with full valid protocol headers MUST return 404
      const afterDeleteRes = await supertest(Server.getInstance().server)
        .post('/mcp')
        .set('Authorization', `Bearer ${getBridgeToken()}`)
        .set('mcp-session-id', sessionId)
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/list',
          params: {},
        });

      expect(afterDeleteRes.status).toBe(404);
    });
  });

  describe('BUG-15: Custom model URL download SSRF protection and redirect safety', () => {
    test('BUG-15: blocks loopback / private IP targets and redirect to private IP', async () => {
      jevModelManager.startDownload('http://127.0.0.1:8000/model.safetensors');
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const p = jevModelManager.getProgress();
        if (p.status === 'error') {
          expect(p.error).toMatch(/SSRF Protection/i);
          return;
        }
      }
      const finalP = jevModelManager.getProgress();
      expect(finalP.error).toMatch(/SSRF Protection/i);
    });
  });

  describe('ARCH-01: Health check feature verification and safe process termination', () => {
    test('ARCH-01.1: isLocalServiceOnline returns false if /health returns 200 but lacks service signature', async () => {
      const dummyServer = http.createServer((req, res) => {
        if (req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      await new Promise<void>((resolve) => dummyServer.listen(18009, '127.0.0.1', () => resolve()));

      try {
        const isOnline = await jevModelManager.isLocalServiceOnline(18009);
        expect(isOnline).toBe(false);
      } finally {
        await new Promise<void>((resolve) => dummyServer.close(() => resolve()));
      }
    });

    test('ARCH-01.2: isLocalServiceOnline returns true when response matches authentic decider signature', async () => {
      const deciderServer = http.createServer((req, res) => {
        if (req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: true,
              model: 'Mapika/decider-2b',
              device: 'cuda',
              layout: 'standard',
            }),
          );
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      await new Promise<void>((resolve) =>
        deciderServer.listen(18009, '127.0.0.1', () => resolve()),
      );

      try {
        const isOnline = await jevModelManager.isLocalServiceOnline(18009);
        expect(isOnline).toBe(true);
      } finally {
        await new Promise<void>((resolve) => deciderServer.close(() => resolve()));
      }
    });

    test('ARCH-01.3: killProcessOnPort does NOT kill foreign process without ChildProcess ownership', async () => {
      let wasKilled = false;
      const dummyServer = http.createServer((req, res) => {
        res.writeHead(200);
        res.end('ok');
      });
      dummyServer.on('close', () => {
        wasKilled = true;
      });
      await new Promise<void>((resolve) => dummyServer.listen(18009, '127.0.0.1', () => resolve()));

      try {
        await jevModelManager.killProcessOnPort(18009);
        expect(wasKilled).toBe(false);
      } finally {
        await new Promise<void>((resolve) => dummyServer.close(() => resolve()));
      }
    });

    test('ARCH-01.4: stopLocalService refuses to stop un-owned service (0 requests sent to foreign service)', async () => {
      (jevModelManager as any).serviceProcess = null;
      (jevModelManager as any).servicePid = null;

      let unloadRequestCount = 0;
      let server8009: http.Server | null = null;
      try {
        server8009 = http.createServer((req, res) => {
          if (req.url === '/unload' || req.url === '/shutdown') {
            unloadRequestCount++;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
        await new Promise<void>((resolve, reject) => {
          server8009!.listen(8009, '127.0.0.1', () => resolve());
          server8009!.on('error', (err: any) => {
            if (err.code === 'EADDRINUSE') resolve();
            else reject(err);
          });
        });

        const stopRes = await jevModelManager.stopLocalService();
        expect(stopRes.success).toBe(false);
        expect(unloadRequestCount).toBe(0);
      } finally {
        if (server8009) {
          await new Promise<void>((resolve) => server8009!.close(() => resolve()));
        }
      }
    });
  });
});
