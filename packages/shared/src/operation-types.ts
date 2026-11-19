export type TextContent = { type: 'text'; text: string };
export type ImageContent = { type: 'image'; data: string; mimeType: string };
export type AudioContent = { type: 'audio'; data: string; mimeType: string };
export type ResourceContent = {
  type: 'resource';
  resource: { uri: string; text?: string; blob?: string; mimeType?: string };
};
export type ResourceLink = { type: 'resource_link'; uri: string; name: string };
export interface CallToolResult {
  content: (TextContent | ImageContent | AudioContent | ResourceContent | ResourceLink)[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [field: string]: unknown;
}
export interface Tool {
  name: string;
  description?: string;
  annotations?: Record<string, unknown>;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}
