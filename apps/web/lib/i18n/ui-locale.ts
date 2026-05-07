import type { NextRequest } from 'next/server';
import { normalizeUiLocale, type UiLocale } from '@llm-wiki/drive-schema';

export function resolveUiLocaleFromRequest(request: NextRequest): UiLocale {
  const headerLocale = request.headers.get('x-llm-wiki-locale');
  const cookieLocale = request.cookies.get('NEXT_LOCALE')?.value;
  return normalizeUiLocale(headerLocale ?? cookieLocale);
}
