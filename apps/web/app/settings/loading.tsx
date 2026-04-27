export default function SettingsLoading() {
  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)', color: 'var(--fg)' }}>
      <div className="mx-auto max-w-2xl space-y-10 px-6 py-10">
        <div className="h-4 w-28 animate-pulse rounded-md" style={{ background: 'var(--bg-2)' }} />
        <div className="h-7 w-14 animate-pulse rounded-md" style={{ background: 'var(--bg-2)' }} />

        <div className="space-y-4">
          <div className="h-3 w-20 animate-pulse rounded" style={{ background: 'var(--bg-2)' }} />
          <div className="flex items-center gap-4">
            <div className="h-12 w-12 shrink-0 animate-pulse rounded-full" style={{ background: 'var(--bg-2)' }} />
            <div className="space-y-2">
              <div className="h-4 w-36 animate-pulse rounded" style={{ background: 'var(--bg-2)' }} />
              <div className="h-3 w-52 animate-pulse rounded" style={{ background: 'var(--bg-2)' }} />
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="h-3 w-28 animate-pulse rounded" style={{ background: 'var(--bg-2)' }} />
          {[1, 2].map((i) => (
            <div
              key={i}
              className="h-14 w-full animate-pulse rounded-lg border"
              style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
            />
          ))}
        </div>

        <div className="space-y-4">
          <div className="h-3 w-16 animate-pulse rounded" style={{ background: 'var(--bg-2)' }} />
          <div className="h-9 w-52 animate-pulse rounded-lg" style={{ background: 'var(--bg-2)' }} />
        </div>

        <div className="space-y-4">
          <div className="h-3 w-14 animate-pulse rounded" style={{ background: 'var(--bg-2)' }} />
          <div className="h-9 w-36 animate-pulse rounded-lg" style={{ background: 'var(--bg-2)' }} />
        </div>
      </div>
    </div>
  );
}
