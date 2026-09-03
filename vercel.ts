import { routes, type VercelConfig } from '@vercel/config/v1';

/**
 * Vercel project configuration for LLM Wiki.
 *
 * Deployed as a Next.js 16 App Router application with Fluid Compute
 * for the ingest / query / organize background functions.
 */
export const config: VercelConfig = {
  framework: 'nextjs',
  buildCommand: 'turbo run build --filter=@llm-wiki/web',
  installCommand: 'bun install',
  outputDirectory: 'apps/web/.next',

  /**
   * Every request reads Supabase (ap-southeast-1) several times, so running the
   * functions in the US default put a Pacific crossing in front of each page
   * read. Singapore sits next to the database and near the user.
   */
  regions: ['sin1'],

  headers: [
    routes.cacheControl('/_next/static/(.*)', {
      public: true,
      maxAge: '1 year',
      immutable: true,
    }),
  ],
};

export default config;
