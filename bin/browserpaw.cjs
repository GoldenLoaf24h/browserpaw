#!/usr/bin/env node

/**
 * BrowserPaw Thin CLI Shim
 * Ultra-fast, zero-overhead command-line proxy for BrowserPaw MCP Server (12306).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tokenPath = path.join(os.homedir(), '.chrome-mcp', 'bridge-token');
let token = '';
try {
  if (fs.existsSync(tokenPath)) {
    token = fs.readFileSync(tokenPath, 'utf8').trim();
  }
} catch {}

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
  console.log(`BrowserPaw CLI
Usage:
  browserpaw <tool_name> [json_args_or_key_val...]
  browserpaw doctor
  browserpaw nav <url>
  browserpaw click <index>
  browserpaw fill <index> <text>
  browserpaw dom [deltaOnly]

Examples:
  browserpaw nav https://example.com
  browserpaw click 5
  browserpaw fill 2 "myusername"
  browserpaw chrome_read_dom
  browserpaw doctor
`);
  process.exit(0);
}

const command = args[0];
const rest = args.slice(1);

let toolName = command;
let toolArgs = {};

// Convenience aliases
if (command === 'nav' || command === 'navigate' || command === 'goto') {
  toolName = 'chrome_navigate';
  toolArgs = { url: rest[0] || 'https://google.com' };
} else if (command === 'click') {
  toolName = 'chrome_interact_index';
  toolArgs = { index: parseInt(rest[0], 10), action: 'click' };
} else if (command === 'fill') {
  toolName = 'chrome_fill_index';
  toolArgs = { index: parseInt(rest[0], 10), text: rest[1] || '' };
} else if (command === 'dom' || command === 'read') {
  toolName = 'chrome_read_dom';
  toolArgs = { deltaOnly: rest[0] === 'true' || rest[0] === 'delta' };
} else if (command === 'doctor') {
  toolName = 'chrome_doctor';
  toolArgs = { verbose: rest.includes('--verbose') || rest.includes('-v') };
} else if (rest.length > 0) {
  try {
    toolArgs = JSON.parse(rest.join(' '));
  } catch {
    toolArgs = {};
    for (let i = 0; i < rest.length; i++) {
      const eqIdx = rest[i].indexOf('=');
      if (eqIdx > 0) {
        const k = rest[i].slice(0, eqIdx);
        const v = rest[i].slice(eqIdx + 1);
        toolArgs[k] = v;
      }
    }
  }
}

// 1. Initialize MCP Session
const postData = (payload, sessId) => {
  return new Promise((resolve, reject) => {
    const dataStr = JSON.stringify(payload);
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Content-Length': Buffer.byteLength(dataStr),
    };
    if (token) headers['x-mcp-token'] = token;
    if (sessId) headers['mcp-session-id'] = sessId;

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 12306,
        path: '/mcp',
        method: 'POST',
        headers,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          const resSess = res.headers['mcp-session-id'] || sessId;
          resolve({ status: res.statusCode, headers: res.headers, body, sessionId: resSess });
        });
      },
    );

    req.on('error', (err) => reject(err));
    req.write(dataStr);
    req.end();
  });
};

(async () => {
  try {
    // 1. Initialize
    const initRes = await postData({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'browserpaw-cli', version: '1.0.0' },
      },
    });

    if (initRes.status !== 200) {
      console.error(`Failed to initialize BrowserPaw MCP session (HTTP ${initRes.status}).`);
      console.error('Make sure Chrome is running with BrowserPaw extension loaded.');
      process.exit(1);
    }

    const sessionId = initRes.sessionId;

    // Send notifications/initialized notification as per MCP specification
    await postData(
      {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      },
      sessionId,
    ).catch(() => {});

    // 2. Call Tool
    const callRes = await postData(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: toolArgs,
        },
      },
      sessionId,
    );

    let outputText = '';
    const lines = callRes.body.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const parsed = JSON.parse(line.slice(6));
          if (parsed.result?.content) {
            if (parsed.result.isError) process.exitCode = 1;
            for (const item of parsed.result.content) {
              if (item.type === 'text') outputText += item.text + '\n';
            }
          } else if (parsed.error) {
            process.exitCode = 1;
            outputText = `Error: ${parsed.error.message}`;
          }
        } catch {}
      }
    }

    if (!outputText && callRes.body) {
      try {
        const parsed = JSON.parse(callRes.body);
        if (parsed.result?.content) {
          if (parsed.result.isError) process.exitCode = 1;
          for (const item of parsed.result.content) {
            if (item.type === 'text') outputText += item.text + '\n';
          }
        } else if (parsed.error) {
          process.exitCode = 1;
          outputText = `Error: ${parsed.error.message}`;
        }
      } catch {}
    }

    if (outputText) {
      console.log(outputText.trim());
    } else {
      console.log(callRes.body);
    }
  } catch (err) {
    console.error(`BrowserPaw CLI Error: ${err.message}`);
    console.error('Is BrowserPaw native server running on port 12306?');
    process.exit(1);
  }
})();
