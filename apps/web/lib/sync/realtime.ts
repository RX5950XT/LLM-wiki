'use client';

import { useEffect, useRef, useCallback } from 'react';
import { createBrowserClient } from '@supabase/ssr';

export interface PageChangedEvent {
  workspaceId: string;
  slug: string;
  updatedBy: 'llm' | 'human';
  version: number;
}

type PageChangedCallback = (event: PageChangedEvent) => void;

/**
 * Subscribe to real-time page changes for a workspace.
 * When the LLM or another device writes a page, all connected clients receive
 * a notification and can re-fetch the content from Drive.
 *
 * Uses Supabase Realtime postgres_changes on the `pages` table.
 */
export function useRealtimePages(
  workspaceId: string,
  onPageChanged: PageChangedCallback,
) {
  const supabaseRef = useRef(
    createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    ),
  );
  const callbackRef = useRef<PageChangedCallback>(onPageChanged);

  // Keep the callback ref current without re-subscribing on every render
  useEffect(() => {
    callbackRef.current = onPageChanged;
  }, [onPageChanged]);

  const subscribe = useCallback(() => {
    const supabase = supabaseRef.current;

    const channel = supabase
      .channel(`workspace-pages-${workspaceId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'pages',
          filter: `workspace_id=eq.${workspaceId}`,
        },
        (payload) => {
          const row = (payload.new ?? payload.old) as Record<string, unknown>;
          if (!row?.slug) return;

          callbackRef.current({
            workspaceId,
            slug: row.slug as string,
            updatedBy: (row.updated_by as 'llm' | 'human') ?? 'llm',
            version: (row.version as number) ?? 0,
          });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [workspaceId]);

  useEffect(() => {
    return subscribe();
  }, [subscribe]);
}
