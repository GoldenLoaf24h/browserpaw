import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/** Profiles control schema visibility, not permission to call a known tool. */
export type ToolProfile = 'core' | 'crawl' | 'full';

/** Stable default surface; additional schemas are discovered by name. */
export const CORE_TOOL_NAMES: Set<string> = new Set([
  'chrome_task',
  'chrome_skill',
  'chrome_navigate',
  'chrome_switch_tab',
  'get_windows_and_tabs',
  'chrome_read_dom',
  'chrome_interact_index',
  'chrome_fill_index',
  'chrome_tool_docs',
]);

/**
 * Resolve the active profile. Accepts the env value verbatim so callers can
 * pass process.env.CHROME_MCP_TOOL_PROFILE directly.
 *
 * Default is now "core" to drastically reduce token overhead and avoid decision paralysis.
 * Set CHROME_MCP_TOOL_PROFILE=full to expose all canonical tools, or crawl for crawl workflows.
 * Aliases "compact" and "minimal" are safely mapped to "core".
 */
export function resolveToolProfile(raw?: string | null): ToolProfile {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (v === 'full') return 'full';
  if (v === 'crawl') return 'crawl';
  if (v === 'compact' || v === 'minimal' || v === 'core') return 'core';
  return 'core';
}

/**
 * Crawl-focused profile: page fetch/extract + scroll + storage + network.
 * For batch site-reading workflows without interaction-heavy tools.
 */
export const CRAWL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'chrome_navigate',
  'chrome_get_markdown',
  'chrome_inspect_media',
  'chrome_read_dom',
  'chrome_grep',
  'chrome_smart_scroll',
  'chrome_javascript',
  'chrome_storage',
  'chrome_cdp_execute',
  'chrome_network_request',
  'chrome_screenshot',
  'chrome_tool_docs',
]);

/**
 * Tool categories, space-separated name lists. chrome_tool_docs reads this
 * so agents can inspect names before requesting individual schemas.
 */
export const TOOL_CATEGORIES: Record<string, string> = {
  navigate: [
    'chrome_navigate',
    'chrome_switch_tab',
    'chrome_close_tabs',
    'chrome_move_tab',
    'chrome_attach_tab',
    'chrome_detach_tab',
    'get_windows_and_tabs',
  ].join(' '),
  perceive: [
    'chrome_read_dom',
    'chrome_get_markdown',
    'chrome_inspect_media',
    'chrome_grep',
    'chrome_get_dropdown_options',
    'chrome_tool_docs',
  ].join(' '),
  act: [
    'chrome_act_toward_goal',
    'chrome_interact_index',
    'chrome_fill_index',
    'chrome_keyboard',
    'chrome_upload_file',
    'chrome_insert_media',
    'chrome_handle_dialog',
    'chrome_handle_download',
    'chrome_batch_actions',
    'chrome_computer',
    'chrome_cdp_execute',
    'chrome_request_human_intervention',
    'chrome_undo_last_action',
    'chrome_form_pipeline',
    'chrome_dismiss_overlay',
  ].join(' '),
  observe: [
    'chrome_screenshot',
    'chrome_smart_scroll',
    'chrome_scroll_until_found',
    'chrome_console',
  ].join(' '),
  manage: [
    'chrome_history',
    'chrome_bookmark_search',
    'chrome_bookmark_add',
    'chrome_bookmark_delete',
    'chrome_tab_group_create',
    'chrome_tab_group_update',
    'chrome_tab_group_list',
    'chrome_tab_group_ungroup',
    'chrome_tab_group_close',
  ].join(' '),
  workflow: ['chrome_task', 'chrome_skill'].join(' '),
  diagnose: [
    'chrome_doctor',
    'chrome_javascript',
    'chrome_storage',
    'chrome_intercept_api',
    'chrome_console',
    'performance_start_trace',
    'performance_stop_trace',
    'performance_analyze_insight',
  ].join(' '),
  network: ['chrome_network_request', 'chrome_network_capture'].join(' '),
  crawl: Array.from(CRAWL_TOOL_NAMES).join(' '),
};

/**
 * Reverse mapping from tool name to its primary functional category.
 * Used for discovery and compatibility guidance.
 */
export const TOOL_NAME_TO_CATEGORY: Record<string, string> = {};
for (const [category, toolList] of Object.entries(TOOL_CATEGORIES)) {
  if (category === 'crawl') continue;
  for (const name of toolList.split(' ').filter(Boolean)) {
    if (!TOOL_NAME_TO_CATEGORY[name]) {
      TOOL_NAME_TO_CATEGORY[name] = category;
    }
  }
}

/**
 * Check whether a valid TypeSafe / Jev API key is present in environment
 */
export function hasJevApiKey(): boolean {
  const env = typeof process !== 'undefined' ? process.env : undefined;
  if (!env) return false;
  const key = (env.TYPESAFE_API_KEY || env.JEV_API_KEY || '').trim();
  return key.length > 0;
}

/**
 * Check whether Jev should be automatically disabled when no API key is present
 */
export function isJevDisabledWithoutKey(): boolean {
  const env = typeof process !== 'undefined' ? process.env : undefined;
  if (!env) return false;
  const flag = String(
    env.BROWSERPAW_DISABLE_JEV_WITHOUT_KEY ??
      env.CHROME_MCP_DISABLE_JEV_WITHOUT_KEY ??
      env.DISABLE_JEV_WITHOUT_KEY ??
      '',
  )
    .trim()
    .toLowerCase();
  return flag === 'true' || flag === '1';
}

/** Filter the schema list for a profile. Unknown names are simply not exposed. */
export function filterToolSchemas(schemas: Tool[], profile: ToolProfile): Tool[] {
  const hasKey = hasJevApiKey();
  const shouldDisableWithoutKey = isJevDisabledWithoutKey();
  const shouldPurgeJev = !hasKey && shouldDisableWithoutKey;

  if (profile === 'full') {
    return shouldPurgeJev ? schemas.filter((t) => t.name !== 'chrome_act_toward_goal') : schemas;
  }

  const allow = new Set(profile === 'crawl' ? CRAWL_TOOL_NAMES : CORE_TOOL_NAMES);
  // Optional promotion: promote chrome_act_toward_goal to core profile when key is set and promotion is enabled
  const autoPromote =
    typeof process !== 'undefined' &&
    (process.env.CHROME_MCP_AUTO_PROMOTE_JEV === 'true' ||
      process.env.CHROME_MCP_AUTO_PROMOTE_JEV === '1');
  if (autoPromote && profile === 'core') {
    allow.add('chrome_act_toward_goal');
  } else if (shouldPurgeJev) {
    allow.delete('chrome_act_toward_goal');
  }

  return schemas.filter((tool) => allow.has(tool.name));
}

/**
 * Message returned when a known tool is called outside the active profile.
 * Returning "not found" would be misleading — the tool exists, it is just not
 * exposed — and it would hide the fix from the caller.
 */
export function profileBlockedMessage(name: string, profile: ToolProfile): string {
  const cat = TOOL_NAME_TO_CATEGORY[name];
  const catHint = cat ? ` (in category "${cat}")` : '';
  return `Tool "${name}"${catHint} is hidden under the "${profile}" profile but remains callable. Use chrome_tool_docs with names:["${name}"] to inspect its schema; activateForSession:true replaces the temporary visible selection.`;
}
