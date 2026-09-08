import { describe, expect, it } from 'bun:test';
import { loadInventoryRows } from './organize-pipeline';

function stubSupabase(results: Array<{ data: unknown; error: { message: string } | null }>) {
  let call = 0;
  type QueryResult = { data: unknown; error: { message: string } | null };
  type QueryBuilder = {
    select: (...columns: string[]) => QueryBuilder;
    in: (column: string, values: string[]) => QueryBuilder;
    eq: (column: string, value: string) => QueryBuilder;
    order: (column: string, options: { ascending: boolean }) => QueryBuilder;
    limit: (count: number) => Promise<QueryResult>;
  };
  const supabase = {
    from(): QueryBuilder {
      const builder: QueryBuilder = {
        select() { return builder; },
        in() { return builder; },
        eq() { return builder; },
        order() { return builder; },
        limit() {
          return Promise.resolve(results[call++] ?? { data: [], error: null });
        },
      };
      return builder;
    },
  };
  return { supabase, calls: () => call };
}

describe('organize inventory loading', () => {
  it('fails instead of treating a failed fallback query as an empty workspace', async () => {
    const db = stubSupabase([
      { data: null, error: { message: 'search_text column is unavailable' } },
      { data: null, error: { message: 'database unavailable' } },
    ]);

    await expect(loadInventoryRows(db.supabase as never, ['workspace-1'])).rejects.toThrow(
      'page inventory lookup failed: database unavailable',
    );
    expect(db.calls()).toBe(2);
  });
});
