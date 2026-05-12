import * as cheerio from 'cheerio';

export function squish(s) {
  if (s == null || s === '') return '';
  return String(s).replace(/\s+/g, ' ').trim();
}

export function htmlText(fragment) {
  if (fragment == null || fragment === '') return '';
  try {
    return squish(cheerio.load(String(fragment), null, false).root().text());
  } catch {
    return squish(String(fragment));
  }
}
