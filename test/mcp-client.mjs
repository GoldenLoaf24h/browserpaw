// Minimal MCP Streamable-HTTP client for BrowserPaw (127.0.0.1:12306).
// Usage: node test/mcp-client.mjs <toolName> '<json-args>'  |  node test/mcp-client.mjs --list
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const BASE = 'http://127.0.0.1:12306/mcp';
const TOKEN = fs.readFileSync(os.userInfo().homedir + '/.chrome-mcp/bridge-token', 'utf8').trim();

let sessionId = process.env.BC_SESSION || null;
let nextId = 1;

function parseSse(text) {
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      try { return JSON.parse(line.slice(6)); } catch { /* keep scanning */ }
    }
  }
  return null;
}

async function rpc(method, params) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer ' + TOKEN,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const text = await res.text();
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + text.slice(0, 300));
  const msg = parseSse(text) ?? JSON.parse(text);
  if (msg.error) throw new Error('RPC ' + JSON.stringify(msg.error));
  return msg.result;
}

async function ensureSession() {
  if (sessionId) return sessionId;
  await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'codex-cli', version: '1.0' },
  });
  await rpc('notifications/initialized', {}).catch(() => {});
  return sessionId;
}

export async function listTools() {
  await ensureSession();
  const r = await rpc('tools/list', {});
  return r.tools.map((t) => ({ name: t.name, schema: t.inputSchema }));
}

export async function callTool(name, args = {}) {
  await ensureSession();
  const r = await rpc('tools/call', { name, arguments: args });
  const first = r.content?.filter((c) => c.type === 'text' && !c.text?.startsWith('[System Note:')).at(-1) ?? r.content?.[0];
  const textOut = first?.type === 'text' ? first.text : JSON.stringify(r);
  try { return { structured: JSON.parse(textOut), raw: r }; } catch { return { text: textOut, raw: r }; }
}

// Preferred high-level API: mcpCall(toolName, args) -> parsed JSON result.
// Throws when the tool reports isError; returns parsed content[0].text.
export async function mcpCall(tool, args = {}) {
  await ensureSession();
  const r = await rpc('tools/call', { name: tool, arguments: args });
  if (r.isError) {
    const detail = r.content?.map((c) => c.text).join('\n') || JSON.stringify(r);
    throw new Error('Tool ' + tool + ' failed: ' + detail);
  }
  const textOut = r.content?.filter((c) => c.type === 'text' && !c.text?.startsWith('[System Note:')).at(-1)?.text ?? r.content?.find((c) => c.type === 'text')?.text;
  try { return JSON.parse(textOut); } catch { return textOut ?? r; }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [, , cmd, ...rest] = process.argv;
  if (cmd === '--list') {
    const tools = await listTools();
    for (const t of tools) console.log('==', t.name, '\n', JSON.stringify(t.schema).slice(0, 600));
  } else if (cmd) {
    const args = rest[0] === '-' ? JSON.parse(fs.readFileSync(0, 'utf8')) : (rest[0] ? JSON.parse(rest[0]) : {});
    const r = await callTool(cmd, args);
    console.log(typeof r.text === 'string' ? r.text : JSON.stringify(r.structured ?? r, null, 2));
  } else {
    console.log('usage: node mcp-client.mjs <toolName> [jsonArgs] | --list');
  }
}
