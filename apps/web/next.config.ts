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
};

export default withNextIntl(nextConfig);
