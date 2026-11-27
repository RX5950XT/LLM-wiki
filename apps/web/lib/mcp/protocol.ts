import { MCP_TOOLS, type McpToolResult } from './wiki-tools';

/**
 * A stateless MCP server over Streamable HTTP, tools only: every POST carries one
 * JSON-RPC message (or a batch) and gets a plain JSON answer, no SSE stream and no
 * session. That is all a read-only tool server needs, and it avoids pulling the
 * SDK's express/hono stack into a Next.js route.
 */

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
const LATEST = SUPPORTED_PROTOCOL_VERSIONS[0];

const SERVER_INSTRUCTIONS =
  'LLM Wiki is the user\'s personal knowledge base, kept as markdown pages per workspace. ' +
  'Call list_workspaces first, then search_pages or read the workspace\'s index.md with read_page. ' +
  'Pages link to each other with [[wikilinks]]. Read-only: this server cannot change the wiki.';

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;
const RPC_INTERNAL = -32603;

export function rpcError(id: JsonRpcResponse['id'], code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export type ToolCaller = (name: string, args: unknown) => Promise<McpToolResult | null>;

/**
 * One message in, at most one response out. Notifications (no id) and responses
 * from the client produce nothing — the route answers those with 202.
 */
export async function handleRpcMessage(message: unknown, callTool: ToolCaller): Promise<JsonRpcResponse | null> {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return rpcError(null, RPC_INVALID_REQUEST, 'Invalid request');
  }
  const msg = message as JsonRpcMessage;
  const isRequest = typeof msg.method === 'string' && msg.id !== undefined && msg.id !== null;
  if (!isRequest) return null; // notification or a client response
  const id = typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : null;
  if (msg.jsonrpc !== '2.0' || id === null) return rpcError(id, RPC_INVALID_REQUEST, 'Invalid request');
  const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>;

  switch (msg.method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : LATEST;
      const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : LATEST;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'llm-wiki', title: 'LLM Wiki', version: '1.0.0' },
          instructions: SERVER_INSTRUCTIONS,
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
    case 'tools/call': {
      if (typeof params.name !== 'string') return rpcError(id, RPC_INVALID_PARAMS, 'tools/call needs a tool name');
      try {
        const result = await callTool(params.name, params.arguments ?? {});
        if (!result) return rpcError(id, RPC_INVALID_PARAMS, `Unknown tool: ${params.name}`);
        return { jsonrpc: '2.0', id, result };
      } catch (err) {
        console.error('[mcp] tool failed', { tool: params.name, message: err instanceof Error ? err.message : err });
        return rpcError(id, RPC_INTERNAL, 'Tool failed');
      }
    }
    // Empty lists keep clients that probe every capability quiet.
    case 'resources/list':
      return { jsonrpc: '2.0', id, result: { resources: [] } };
    case 'prompts/list':
      return { jsonrpc: '2.0', id, result: { prompts: [] } };
    default:
      return rpcError(id, RPC_METHOD_NOT_FOUND, `Method not found: ${String(msg.method)}`);
  }
}
