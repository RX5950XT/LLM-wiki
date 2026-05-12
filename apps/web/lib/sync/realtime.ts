'use client';

import { useEffect, useRef, useCallback } from 'react';
import { createBrowserClient } from '@supabase/ssr';

export interface PageChangedEvent {
  workspaceId: string;
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  slug: string;
  title?: string;
  kind?: string;
  zone?: string;
  version: number;
  updatedAt?: string;
  updatedBy?: 'llm' | 'human';
}

type PageChangedCallback = (event: PageChangedEvent) => void;

/**
 * Subscribe to page changes for a workspace via Supabase Realtime Broadcast.
 * Requires migration 0007 (broadcast_page_metadata_change trigger) to be deployed.
 * Uses a private channel with RLS authorization.
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

  useEffect(() => {
    callbackRef.current = onPageChanged;
  }, [onPageChanged]);

  const subscribe = useCallback(() => {
    const supabase = supabaseRef.current;

    const channel = supabase
      .channel(`workspace-${workspaceId}`, {
        config: { private: true },
      })
      .on('broadcast', { event: 'page_changed' }, ({ payload }) => {
        if (!payload?.slug) return;
        callbackRef.current({
          workspaceId,
          eventType: (payload.eventType as 'INSERT' | 'UPDATE' | 'DELETE') ?? 'UPDATE',
          slug: payload.slug as string,
          title: payload.title as string | undefined,
          kind: payload.kind as string | undefined,
          zone: payload.zone as string | undefined,
          version: (payload.version as number) ?? 0,
          updatedAt: payload.updatedAt as string | undefined,
          updatedBy: (payload.updatedBy as 'llm' | 'human') ?? 'llm',
        });
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [workspaceId]);

  useEffect(() => {
    return subscribe();
  }, [subscribe]);
}
