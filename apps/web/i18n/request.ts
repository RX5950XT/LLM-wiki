import { getRequestConfig } from 'next-intl/server';
import { cookies } from 'next/headers';

const SUPPORTED_LOCALES = ['en', 'zh-TW'] as const;
type Locale = (typeof SUPPORTED_LOCALES)[number];

function isValidLocale(value: string): value is Locale {
  return SUPPORTED_LOCALES.includes(value as Locale);
}

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const raw = cookieStore.get('NEXT_LOCALE')?.value ?? 'zh-TW';
  const locale: Locale = isValidLocale(raw) ? raw : 'zh-TW';

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
