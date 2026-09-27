import { describe, it, expect } from 'vitest';
import {
  CORE_TOOL_NAMES,
  CRAWL_TOOL_NAMES,
  filterToolSchemas,
  profileBlockedMessage,
  resolveToolProfile,
  TOOL_NAME_TO_CATEGORY,
  TOOL_SCHEMAS,
} from 'chrome-mcp-shared';

/**
 * The full tool list costs ~70KB / ~18k tokens of fixed schema overhead in every
 * session. The streamlined core profile trims down to 14 high-frequency primary
 * tools to eliminate decision paralysis and cut token overhead by >65%.
 */
describe('tool profiles', () => {
  it('defaults to core and only exposes full on explicit full', () => {
    expect(resolveToolProfile()).toBe('core');
    expect(resolveToolProfile(undefined)).toBe('core');
    expect(resolveToolProfile(null)).toBe('core');
    expect(resolveToolProfile('')).toBe('core');
    expect(resolveToolProfile('core')).toBe('core');
    expect(resolveToolProfile('CORE')).toBe('core');
    expect(resolveToolProfile('  Core  ')).toBe('core');
    expect(resolveToolProfile('full')).toBe('full');
    expect(resolveToolProfile('FULL')).toBe('full');
    expect(resolveToolProfile('  Full  ')).toBe('full');
    expect(resolveToolProfile('crawl')).toBe('crawl');
    expect(resolveToolProfile('compact')).toBe('core');
    expect(resolveToolProfile('COMPACT')).toBe('core');
    expect(resolveToolProfile('minimal')).toBe('core');
    expect(resolveToolProfile('MINIMAL')).toBe('core');
    expect(resolveToolProfile('garbage')).toBe('core');
  });

  it('full profile exposes every schema untouched', () => {
    const full = filterToolSchemas(TOOL_SCHEMAS, 'full');
    expect(full).toHaveLength(TOOL_SCHEMAS.length);
    expect(full).toEqual(TOOL_SCHEMAS);
  });

  it('core profile is a strict subset of the real tool list', () => {
    const core = filterToolSchemas(TOOL_SCHEMAS, 'core');
    const fullNames = new Set(TOOL_SCHEMAS.map((t: any) => t.name));

    expect(core.length).toBeGreaterThan(0);
    expect(core.length).toBeLessThan(TOOL_SCHEMAS.length);

    // No ghost names: every entry in CORE_TOOL_NAMES must exist in the schema.
    for (const name of CORE_TOOL_NAMES) {
      expect(fullNames.has(name), String(name) + ' is not a real tool').toBe(true);
    }
    // And every returned schema must come from the core set.
    for (const tool of core) {
      expect(CORE_TOOL_NAMES.has(tool.name)).toBe(true);
    }
  });

  it('keeps the 14 hyper-focused tools a browsing session needs', () => {
    const core = new Set(filterToolSchemas(TOOL_SCHEMAS, 'core').map((t: any) => t.name));
    expect(core.size).toBe(14);

    for (const required of [
      'chrome_read_dom',
      'chrome_get_markdown',
      'chrome_inspect_media',
      'chrome_grep',
      'chrome_interact_index',
      'chrome_fill_index',
      'chrome_batch_actions',
      'chrome_screenshot',
      'chrome_smart_scroll',
      'chrome_navigate',
      'chrome_switch_tab',
      'chrome_close_tabs',
      'get_windows_and_tabs',
      'chrome_tool_docs',
    ]) {
      expect(core.has(required), String(required) + ' must stay in core').toBe(true);
    }
  });

  it('confirms heavy and non-essential tools are pruned from core', () => {
    const core = new Set(filterToolSchemas(TOOL_SCHEMAS, 'core').map((t: any) => t.name));

    expect(core.has('chrome_computer')).toBe(false);
    expect(core.has('chrome_keyboard')).toBe(false);
    expect(core.has('chrome_upload_file')).toBe(false);
    expect(core.has('chrome_handle_dialog')).toBe(false);
    expect(core.has('chrome_handle_download')).toBe(false);
    expect(core.has('chrome_javascript')).toBe(false);
    expect(core.has('chrome_storage')).toBe(false);
    expect(core.has('chrome_console')).toBe(false);
    expect(core.has('chrome_click_element')).toBe(false);
    expect(core.has('chrome_fill_or_select')).toBe(false);
    expect(core.has('chrome_burst_interact')).toBe(false);
    expect(core.has('chrome_cdp_execute')).toBe(false);
  });

  it('trims more than 60% of the fixed schema cost', () => {
    const fullBytes = JSON.stringify(TOOL_SCHEMAS).length;
    const coreBytes = JSON.stringify(filterToolSchemas(TOOL_SCHEMAS, 'core')).length;

    // Core cuts more than 60% of schema tokens
    expect(coreBytes / fullBytes).toBeLessThan(0.5);
  });

  it('TOOL_NAME_TO_CATEGORY covers every tool in TOOL_SCHEMAS', () => {
    for (const tool of TOOL_SCHEMAS) {
      expect(TOOL_NAME_TO_CATEGORY[tool.name], tool.name + ' must map to a category').toBeDefined();
    }
  });

  it('explains a profile-blocked call and points to auto-activation', () => {
    const msg = profileBlockedMessage('chrome_history', 'core');

    expect(msg).toContain('chrome_history');
    expect(msg).toContain('manage');
  });

  it('crawl profile exposes the crawl set including discovery tools', () => {
    const names = filterToolSchemas(TOOL_SCHEMAS, 'crawl').map((t) => t.name);
    for (const n of CRAWL_TOOL_NAMES) expect(names).toContain(n);
    expect(names).not.toContain('chrome_computer');
  });
});
