import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { RPC_PARSE_ERROR, handleRpcMessage, rpcError, type JsonRpcResponse } from '@/lib/mcp/protocol';
import { bearerToken, resolveMcpTokenOwner } from '@/lib/mcp/tokens';
import { callMcpTool } from '@/lib/mcp/wiki-tools';

/**
 * MCP endpoint (Streamable HTTP, stateless): other agents read the wiki with
 * `Authorization: Bearer llmw_…`, a token created in Settings → MCP.
 */
export const maxDuration = 60;

/** Plenty for JSON-RPC; tool arguments are a slug or a search query. */
const MAX_BODY_BYTES = 256 * 1024;

function unauthorized() {
  return NextResponse.json(
    { error: 'Unauthorized: send Authorization: Bearer <token from LLM Wiki Settings → MCP>' },
    { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="llm-wiki"' } },
  );
}

export async function POST(request: NextRequest) {
  const token = bearerToken(request.headers.get('authorization'));
  if (!token) return unauthorized();
  const userId = await resolveMcpTokenOwner(token);
  if (!userId) return unauthorized();

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return NextResponse.json(rpcError(null, -32600, 'Request too large'), { status: 413 });
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json(rpcError(null, RPC_PARSE_ERROR, 'Parse error'), { status: 400 });
  }

  const ctx = { admin: createAdminClient(), userId };
  const callTool = (name: string, args: unknown) => callMcpTool(ctx, name, args);

  if (Array.isArray(payload)) {
    if (payload.length === 0 || payload.length > 20) {
      return NextResponse.json(rpcError(null, -32600, 'Invalid batch'), { status: 400 });
    }
    const responses = (await Promise.all(payload.map((m) => handleRpcMessage(m, callTool)))).filter(
      (r): r is JsonRpcResponse => r !== null,
    );
    return responses.length ? NextResponse.json(responses) : new NextResponse(null, { status: 202 });
  }

  const response = await handleRpcMessage(payload, callTool);
  return response ? NextResponse.json(response) : new NextResponse(null, { status: 202 });
}

/** No server-initiated stream: a stateless server answers GET/DELETE with 405 per spec. */
export function GET() {
  return new NextResponse(null, { status: 405, headers: { Allow: 'POST' } });
}

export function DELETE() {
  return new NextResponse(null, { status: 405, headers: { Allow: 'POST' } });
}
