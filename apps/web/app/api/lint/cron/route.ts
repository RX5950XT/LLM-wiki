import { NextRequest } from 'next/server';

/** Vercel Cron hits GET /api/lint/cron every Monday at 03:00 UTC. */
export async function GET(request: NextRequest) {
  return fetch(new URL('/api/lint', request.url), {
    method: 'GET',
    headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? ''}` },
  });
}
