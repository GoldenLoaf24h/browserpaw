import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { tabGroupManager } from './tab-group-manager';

export interface TabGroupCreateParams {
  tabIds: number[];
  groupId?: number;
  title?: string;
  color?: 'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange';
  collapsed?: boolean;
  windowId?: number;
}

export interface TabGroupUpdateParams {
  groupId: number;
  title?: string;
  color?: 'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange';
  collapsed?: boolean;
}

export interface TabGroupListParams {
  windowId?: number;
  title?: string;
}

export interface TabGroupUngroupParams {
  tabIds: number[];
}

/**
 * Tool for creating tab groups or adding tabs to a group.
 */
export class TabGroupCreateTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.TAB_GROUP_CREATE;

  async execute(args: TabGroupCreateParams): Promise<ToolResult> {
    if (!Array.isArray(args?.tabIds) || args.tabIds.length === 0) {
      return createErrorResponse('tabIds must be a non-empty array of tab IDs');
    }

    try {
      const groupOptions: any = {
        tabIds: args.tabIds,
      };
      if (typeof args.groupId === 'number' && args.groupId > 0) {
        groupOptions.groupId = args.groupId;
      }
      if (typeof args.windowId === 'number' && args.windowId > 0) {
        groupOptions.createProperties = { windowId: args.windowId };
      }

      const groupId = await chrome.tabs.group(groupOptions);

      // Update group styling/title if specified
      if (args.title !== undefined || args.color !== undefined || args.collapsed !== undefined) {
        const updateProps: chrome.tabGroups.UpdateProperties = {};
        if (args.title !== undefined) updateProps.title = args.title;
        if (args.color !== undefined) updateProps.color = args.color;
        if (args.collapsed !== undefined) updateProps.collapsed = args.collapsed;

        await chrome.tabGroups.update(groupId, updateProps);
      }

      await tabGroupManager.registerManagedGroup(groupId, args.title);
      for (const tid of args.tabIds) {
        tabGroupManager.registerAgentTab(tid);
      }

      const group = await chrome.tabGroups.get(groupId);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message: `Successfully grouped tabs into group ${groupId}`,
                group,
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    } catch (error) {
      return createErrorResponse(
        `Error executing chrome_tab_group_create: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * Tool for updating a tab group's title, color, or collapsed state.
 */
export class TabGroupUpdateTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.TAB_GROUP_UPDATE;

  async execute(args: TabGroupUpdateParams): Promise<ToolResult> {
    if (typeof args?.groupId !== 'number' || args.groupId <= 0) {
      return createErrorResponse('groupId must be a valid positive integer');
    }

    try {
      const updateProps: chrome.tabGroups.UpdateProperties = {};
      if (args.title !== undefined) updateProps.title = args.title;
      if (args.color !== undefined) updateProps.color = args.color;
      if (args.collapsed !== undefined) updateProps.collapsed = args.collapsed;

      const group = await chrome.tabGroups.update(args.groupId, updateProps);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message: `Successfully updated group ${args.groupId}`,
                group,
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    } catch (error) {
      return createErrorResponse(
        `Error executing chrome_tab_group_update: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * Tool for listing browser tab groups.
 */
export class TabGroupListTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.TAB_GROUP_LIST;

  async execute(args: TabGroupListParams = {}): Promise<ToolResult> {
    try {
      const query: chrome.tabGroups.QueryInfo = {};
      if (typeof args.windowId === 'number' && args.windowId > 0) {
        query.windowId = args.windowId;
      }
      if (args.title) {
        query.title = args.title;
      }

      const groups = await chrome.tabGroups.query(query);
      const enrichedGroups = await Promise.all(
        groups.map(async (group) => {
          const tabs = await chrome.tabs.query({ groupId: group.id });
          const tabIds = tabs.map((t) => t.id).filter((id): id is number => typeof id === 'number');
          const tabDetails = tabs.map((t) => ({
            id: t.id,
            index: t.index,
            title: t.title,
            url: t.url,
            active: t.active,
            pinned: t.pinned,
            favIconUrl: t.favIconUrl,
          }));
          return {
            ...group,
            tabIds,
            tabs: tabDetails,
          };
        }),
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                count: enrichedGroups.length,
                groups: enrichedGroups,
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    } catch (error) {
      return createErrorResponse(
        `Error executing chrome_tab_group_list: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * Tool for removing tabs from groups.
 */
export class TabGroupUngroupTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.TAB_GROUP_UNGROUP;

  async execute(args: TabGroupUngroupParams): Promise<ToolResult> {
    if (!Array.isArray(args?.tabIds) || args.tabIds.length === 0) {
      return createErrorResponse('tabIds must be a non-empty array of tab IDs');
    }

    try {
      await chrome.tabs.ungroup(args.tabIds);
      await tabGroupManager.cleanupEmptyOrOrphanGroups().catch(() => {});
      setTimeout(() => {
        tabGroupManager.cleanupEmptyOrOrphanGroups().catch(() => {});
      }, 150);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message: `Successfully ungrouped ${args.tabIds.length} tab(s)`,
                tabIds: args.tabIds,
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    } catch (error) {
      return createErrorResponse(
        `Error executing chrome_tab_group_ungroup: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export interface TabGroupCloseParams {
  groupId: number;
}

/**
 * Tool for closing an entire tab group (closing all tabs in the group).
 */
export class TabGroupCloseTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.TAB_GROUP_CLOSE;

  async execute(args: TabGroupCloseParams): Promise<ToolResult> {
    if (typeof args?.groupId !== 'number' || args.groupId <= 0) {
      return createErrorResponse('groupId must be a valid positive integer');
    }

    try {
      try {
        await chrome.tabGroups.get(args.groupId);
      } catch {
        return createErrorResponse(`Tab group with ID ${args.groupId} does not exist`);
      }

      const tabs = await chrome.tabs.query({ groupId: args.groupId });
      const tabIds = tabs.map((t) => t.id).filter((id): id is number => typeof id === 'number');

      await tabGroupManager.closeManagedGroup(args.groupId);
      setTimeout(() => {
        tabGroupManager.cleanupEmptyOrOrphanGroups().catch(() => {});
      }, 150);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message: `Successfully closed tab group ${args.groupId} (${tabIds.length} tab(s) closed)`,
                groupId: args.groupId,
                closedTabCount: tabIds.length,
                closedTabIds: tabIds,
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    } catch (error) {
      return createErrorResponse(
        `Error executing chrome_tab_group_close: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const tabGroupCreateTool = new TabGroupCreateTool();
export const tabGroupUpdateTool = new TabGroupUpdateTool();
export const tabGroupListTool = new TabGroupListTool();
export const tabGroupUngroupTool = new TabGroupUngroupTool();
export const tabGroupCloseTool = new TabGroupCloseTool();
