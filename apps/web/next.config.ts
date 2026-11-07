import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

const PDFJS_ASSET_GLOBS = [
  './node_modules/pdfjs-dist/cmaps/**/*',
  './node_modules/pdfjs-dist/standard_fonts/**/*',
];

const nextConfig: NextConfig = {
  transpilePackages: [
    '@llm-wiki/ui',
    '@llm-wiki/shared-types',
    '@llm-wiki/prompts',
    '@llm-wiki/drive-schema',
  ],
  // pdf.js reads these from disk at runtime, so tracing cannot discover them.
  outputFileTracingIncludes: {
    '/api/ingest/**/*': PDFJS_ASSET_GLOBS,
    '/api/ingest': PDFJS_ASSET_GLOBS,
    '/api/sources/**/*': PDFJS_ASSET_GLOBS,
  },
  webpack(config) {
    config.module.rules.push({ test: /\.md$/, type: 'asset/source' });
    return config;
  },
  turbopack: {
    resolveAlias: {
      'next-intl/config': './i18n/request.ts',
    },
    rules: {
      '*.md': {
        loaders: ['raw-loader'],
        as: '*.js',
      },
    },
  },
};

export default withNextIntl(nextConfig);
