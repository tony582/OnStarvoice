import {DeviceError} from './bounded.mjs';
import {findTab, hasArticleTabs} from './wechat-article-parse.mjs';
import {canonicalArticleUrl, cardMatchesHeader} from '../shared/wechat-article-identity.mjs';

const fail = (code, message) => new DeviceError(code, message, {deviceSettled: true});
/** DOM collection only needs a loaded article surface; publication metadata is verified by the preview. */
export async function waitForArticlePage({look, assertArticle, wait, now, signal, budgetMs = 7000}) {
  const deadline = now() + Math.max(1000, Math.min(7000, budgetMs));
  for (let attempt = 0; attempt < 5; attempt++) {
    await assertArticle({signal});
    const rows = await look({signal});
    const menu = rows.some(row => row.y >= 90 && row.y < 210 && row.x > 900 && /^[•·.⋯…]{2,}$/u.test(row.text.trim()));
    const results = (hasArticleTabs(rows) || findTab(rows, '文章'))
      && rows.some(row => row.y >= 90 && row.y < 230 && row.x > 700 && /^(?:搜索|取消)$/u.test(row.text.trim()));
    // A restored image-only page may have no OCR body text. Its copied URL and DOM still need verification.
    if (menu && !results) return;
    if (attempt === 4 || now() >= deadline - 650) break;
    await wait(650, signal);
  }
  throw fail('article_unavailable', 'A loaded article page and its menu were not confirmed');
}

/** Copy proof and the preview header belong to this one article. No caller-supplied body/UI state is used. */
export function verifiedPageHeader(value, copiedUrl, card = null) {
  const url = canonicalArticleUrl(value?.url);
  if (!url || url !== canonicalArticleUrl(copiedUrl) || value?.source !== 'page_dom' || value?.headerVerified !== true
    || typeof value.title !== 'string' || !value.title.trim() || typeof value.account !== 'string' || !value.account.trim()
    || (card && !cardMatchesHeader(card, value))) {
    throw fail('article_identity_unverified', 'Supplemental reading requires the matching preview header and a fresh copied link');
  }
  const fields = ['title', 'account', 'author', 'publishedAt', 'timeLabel', 'timePrecision', 'location', 'capturedAt', 'timeSource'];
  return {...Object.fromEntries(fields.filter(key => value[key] !== undefined).map(key => [key, value[key]])),
    url, source: 'page_dom', headerVerified: true};
}
