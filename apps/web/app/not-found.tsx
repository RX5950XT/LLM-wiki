export const dynamic = 'force-dynamic';

export default function NotFound() {
  return (
    <html>
      <body style={{ fontFamily: 'system-ui', padding: '2rem', color: '#fff', background: '#0a0a0a' }}>
        <h1 style={{ fontSize: '1.5rem' }}>404 — Page not found</h1>
        <a href="/" style={{ color: '#888', fontSize: '0.9rem' }}>← Go home</a>
      </body>
    </html>
  );
}
