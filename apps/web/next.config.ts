import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

const nextConfig: NextConfig = {
  transpilePackages: [
    '@llm-wiki/ui',
    '@llm-wiki/shared-types',
    '@llm-wiki/prompts',
    '@llm-wiki/drive-schema',
  ],
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
