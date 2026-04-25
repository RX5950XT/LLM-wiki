import { routes, type VercelConfig } from '@vercel/config/v1';

/**
 * Vercel project configuration for LLM Wiki.
 *
 * Deployed as a Next.js 16 App Router application with Fluid Compute
 * for the ingest / query / lint background functions.
 */
export const config: VercelConfig = {
  framework: 'nextjs',
  buildCommand: 'turbo run build --filter=@llm-wiki/web',
  installCommand: 'bun install',
  outputDirectory: 'apps/web/.next',

  // Weekly lint pass across every active workspace the user owns.
  crons: [
    { path: '/api/lint/cron', schedule: '0 3 * * 1' },
  ],

  headers: [
    routes.cacheControl('/_next/static/(.*)', {
      public: true,
      maxAge: '1 year',
      immutable: true,
    }),
  ],
};

export default config;
