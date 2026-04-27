export default function WorkspaceLoading() {
  return (
    <div className="flex h-screen flex-col" style={{ background: 'var(--bg)', color: 'var(--fg)' }}>
      <header
        className="flex h-10 items-center justify-between border-b px-4"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}
      >
        <div className="flex items-center gap-3">
          <div className="h-4 w-4 animate-pulse rounded" style={{ background: 'var(--border)' }} />
          <div className="h-4 w-36 animate-pulse rounded" style={{ background: 'var(--border)' }} />
        </div>
        <div className="flex items-center gap-2">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="h-4 w-4 animate-pulse rounded" style={{ background: 'var(--border)' }} />
          ))}
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <aside
          className="hidden w-60 shrink-0 border-r p-3 md:block"
          style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}
        >
          <div className="space-y-5">
            {Array.from({ length: 3 }).map((_, section) => (
              <div key={section} className="space-y-2">
                <div className="h-3 w-20 animate-pulse rounded" style={{ background: 'var(--border)' }} />
                {Array.from({ length: 4 }).map((__, item) => (
                  <div key={item} className="h-6 animate-pulse rounded" style={{ background: 'var(--border)' }} />
                ))}
              </div>
            ))}
          </div>
        </aside>

        <main className="flex-1 p-8">
          <div className="mx-auto max-w-3xl space-y-4">
            <div className="h-8 w-64 animate-pulse rounded" style={{ background: 'var(--border)' }} />
            <div className="h-4 w-40 animate-pulse rounded" style={{ background: 'var(--border)' }} />
            <div className="space-y-3 pt-6">
              {Array.from({ length: 8 }).map((_, index) => (
                <div
                  key={index}
                  className="h-4 animate-pulse rounded"
                  style={{ width: `${90 - index * 6}%`, background: 'var(--border)' }}
                />
              ))}
            </div>
          </div>
        </main>

        <aside
          className="hidden w-96 shrink-0 border-l p-4 lg:block"
          style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}
        >
          <div className="space-y-4">
            <div className="h-20 animate-pulse rounded-lg" style={{ background: 'var(--border)' }} />
            <div className="h-28 animate-pulse rounded-lg" style={{ background: 'var(--border)' }} />
            <div className="mt-auto h-24 animate-pulse rounded-lg" style={{ background: 'var(--border)' }} />
          </div>
        </aside>
      </div>
    </div>
  );
}
