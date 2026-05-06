import type { SupabaseClient } from '@supabase/supabase-js';

type SupabaseErrorLike = {
  code?: string | null;
  details?: string | null;
  hint?: string | null;
  message?: string | null;
};

export type WorkspaceListRow = {
  id: string;
  name?: string | null;
  description?: string | null;
  drive_folder_id?: string | null;
  default_profile_id?: string | null;
  sort_order?: number | null;
  created_at?: string | null;
};

type OrderedWorkspaceOptions = {
  select?: string;
  ownerId?: string;
  limit?: number;
};

type OrderedWorkspaceResult = {
  data: WorkspaceListRow[];
  error: SupabaseErrorLike | null;
};

export function isMissingSortOrderError(error: SupabaseErrorLike | null | undefined): boolean {
  if (!error) return false;
  const text = [
    error.code,
    error.message,
    error.details,
    error.hint,
  ].filter(Boolean).join(' ');

  return text.includes('sort_order') && (
    text.includes('42703') ||
    text.includes('PGRST204') ||
    text.toLowerCase().includes('column') ||
    text.toLowerCase().includes('schema cache')
  );
}

export async function fetchOrderedWorkspaces(
  supabase: SupabaseClient,
  { select = 'id, name, sort_order, created_at', ownerId, limit }: OrderedWorkspaceOptions = {},
): Promise<OrderedWorkspaceResult> {
  const sorted = await runWorkspaceQuery(supabase, {
    select,
    ownerId,
    limit,
    sortBySortOrder: true,
  });

  if (!isMissingSortOrderError(sorted.error)) {
    return sorted;
  }

  return runWorkspaceQuery(supabase, {
    select: stripSortOrderFromSelect(select),
    ownerId,
    limit,
    sortBySortOrder: false,
  });
}

export async function getNextWorkspaceSortOrder(
  supabase: SupabaseClient,
  ownerId: string,
): Promise<number | null> {
  const { data, error } = await supabase
    .from('workspaces')
    .select('sort_order')
    .eq('owner_id', ownerId)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (isMissingSortOrderError(error)) return null;
  if (error) throw new Error(`Failed to load workspace order: ${error.message}`);

  const lastWorkspace = data as { sort_order?: number | null } | null;
  return (lastWorkspace?.sort_order ?? -1) + 1;
}

function stripSortOrderFromSelect(select: string): string {
  const fields = select
    .split(',')
    .map((field) => field.trim())
    .filter((field) => field !== 'sort_order');

  return fields.length > 0 ? fields.join(', ') : 'id';
}

async function runWorkspaceQuery(
  supabase: SupabaseClient,
  {
    select,
    ownerId,
    limit,
    sortBySortOrder,
  }: OrderedWorkspaceOptions & { select: string; sortBySortOrder: boolean },
): Promise<OrderedWorkspaceResult> {
  let query = supabase.from('workspaces').select(select);
  if (ownerId) query = query.eq('owner_id', ownerId);
  if (sortBySortOrder) query = query.order('sort_order', { ascending: true });
  query = query.order('created_at', { ascending: true });
  if (limit != null) query = query.limit(limit);

  const { data, error } = await query;
  return {
    data: (data ?? []) as unknown as WorkspaceListRow[],
    error,
  };
}
