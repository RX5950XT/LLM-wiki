import { NextRequest, NextResponse, after } from 'next/server';
import {
  loadRunnableIngestJobs,
  recoverDeadIngestJobs,
  runPendingIngestJob,
} from '@/lib/ai/ingest-job-runner';
import { createAdminClient } from '@/lib/supabase/admin';

export const maxDuration = 300;

/** Each runs for minutes in this invocation; anything further waits for the next tick. */
const JOBS_PER_TICK = 3;

/**
 * Called by pg_cron once a minute while a job is due, so imports finish with every
 * client closed. It can only move queued jobs along, never start new work; the token
 * is compared inside Postgres and never leaves it.
 */
export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  const token = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
  if (!token) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, { status: 401 });

  const supabase = createAdminClient();
  const { data: valid, error } = await supabase.rpc('verify_ingest_worker_token', { token });
  if (error) {
    console.error('[ingest-worker] token check failed', { message: error.message });
    return NextResponse.json({ error: { code: 'WORKER_UNAVAILABLE', message: 'Unavailable' } }, { status: 500 });
  }
  if (valid !== true) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, { status: 401 });

  try {
    await recoverDeadIngestJobs(supabase);
    const jobs = await loadRunnableIngestJobs(supabase, JOBS_PER_TICK);
    for (const job of jobs) {
      after(async () => {
        try {
          await runPendingIngestJob({ jobId: job.id, ownerId: job.owner_id, startedAt });
        } catch (runError) {
          console.error('[ingest-worker] unable to start job', { jobId: job.id, error: runError });
        }
      });
    }
    return NextResponse.json({ started: jobs.length });
  } catch (tickError) {
    console.error('[ingest-worker] tick failed', { error: tickError });
    return NextResponse.json({ error: { code: 'WORKER_TICK_FAILED', message: 'Tick failed' } }, { status: 500 });
  }
}
