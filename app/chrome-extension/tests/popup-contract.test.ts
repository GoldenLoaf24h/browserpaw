import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const popupDir = path.resolve(__dirname, '../entrypoints/popup');
const appSource = fs.readFileSync(path.join(popupDir, 'App.vue'), 'utf8');
const cssSource = fs.readFileSync(path.join(popupDir, 'style.css'), 'utf8');

describe('Extension popup v5 contract', () => {
  it('removes retired Jev UI and MCP wording', () => {
    expect(appSource).not.toMatch(/\bjev\b/i);
    expect(appSource).not.toMatch(/MCP on|MCP off/);
  });

  it('wires all active extension controls and storage keys', () => {
    expect(appSource).toContain('agentControlEnabled');
    expect(appSource).toContain('agentCursorMode');
    expect(appSource).toContain('agentWindowMode');
    expect(appSource).toContain('BACKGROUND_MESSAGE_TYPES.GET_SERVER_STATUS');
    expect(appSource).toContain('BACKGROUND_MESSAGE_TYPES.SERVER_STATUS_CHANGED');
    expect(appSource).toContain('checkExtensionVersionUpdate');
  });

  it('keeps the popup viewport compact and leaves room for its contents', () => {
    expect(cssSource).toMatch(/body\s*\{\s*width:\s*224px/);
    expect(cssSource).not.toMatch(/(?:html|body)\s*\{[^}]*\bheight:\s*\d+px/);
  });

  it('keeps the established control labels, cursor icon and motion', () => {
    expect(appSource).toContain('Agent Control');
    expect(appSource).toContain('Agent Cursor');
    expect(appSource).toContain('Window Mode');
    expect(appSource).not.toContain('Browser access');
    expect(appSource).toContain('images/cursor-chat.png');
    expect(appSource).toContain('Star BrowserPaw on GitHub');
    expect(cssSource).toMatch(/\.indicator\s*\{[^}]*transition:\s*transform/);
    expect(cssSource).toMatch(/\.knob\s*\{[^}]*transition:\s*transform/);
    expect(cssSource).toContain('prefers-reduced-motion');
  });

  it('leaves the current version inert until an update is available', () => {
    expect(appSource).toContain('<span v-else class="version">v{{ version }}</span>');
    expect(appSource).not.toMatch(/class="version"[^>]*title=/);
  });
});
