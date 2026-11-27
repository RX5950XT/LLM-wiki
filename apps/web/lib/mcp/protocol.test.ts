import { describe, expect, test } from 'bun:test';
import { handleRpcMessage } from './protocol';
import { bearerToken, generateMcpToken, hashMcpToken } from './tokens';

const noTools = async () => null;

describe('mcp protocol', () => {
  test('initialize echoes a supported version and falls back to the latest', async () => {
    const ok = await handleRpcMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, noTools);
    expect((ok?.result as { protocolVersion: string }).protocolVersion).toBe('2025-03-26');
    const odd = await handleRpcMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, noTools);
    expect((odd?.result as { protocolVersion: string }).protocolVersion).toBe('2025-11-25');
  });

  test('notifications get no response', async () => {
    expect(await handleRpcMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, noTools)).toBeNull();
  });

  test('tools/list returns read-only tools', async () => {
    const res = await handleRpcMessage({ jsonrpc: '2.0', id: 'a', method: 'tools/list' }, noTools);
    const tools = (res?.result as { tools: { name: string; annotations: { readOnlyHint: boolean } }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual(['list_workspaces', 'list_pages', 'search_pages', 'read_page']);
    expect(tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
  });

  test('tools/call passes arguments and reports unknown tools', async () => {
    const calls: unknown[] = [];
    const caller = async (name: string, args: unknown) => {
      calls.push([name, args]);
      return name === 'read_page' ? { content: [{ type: 'text' as const, text: 'page' }] } : null;
    };
    const hit = await handleRpcMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_page', arguments: { slug: 'index.md' } } }, caller);
    expect(hit?.result).toEqual({ content: [{ type: 'text', text: 'page' }] });
    expect(calls[0]).toEqual(['read_page', { slug: 'index.md' }]);
    const miss = await handleRpcMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'writePage' } }, caller);
    expect(miss?.error?.code).toBe(-32602);
  });

  test('unknown method and bad envelope are JSON-RPC errors', async () => {
    expect((await handleRpcMessage({ jsonrpc: '2.0', id: 5, method: 'nope' }, noTools))?.error?.code).toBe(-32601);
    expect((await handleRpcMessage('x', noTools))?.error?.code).toBe(-32600);
  });
});

describe('mcp tokens', () => {
  test('generated tokens parse back from a bearer header and hash stably', () => {
    const { token, hash, prefix } = generateMcpToken();
    expect(bearerToken(`Bearer ${token}`)).toBe(token);
    expect(hashMcpToken(token)).toBe(hash);
    expect(token.startsWith(prefix)).toBe(true);
    expect(bearerToken('Bearer sk-other')).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });
});
