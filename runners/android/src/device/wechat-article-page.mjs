import {DeviceError} from './bounded.mjs';
import {findTab, hasArticleTabs} from './wechat-article-parse.mjs';
import {canonicalArticleUrl, cardMatchesHeader} from '../shared/wechat-article-identity.mjs';

const fail = (code, message) => new DeviceError(code, message, {deviceSettled: true});
/** DOM collection only needs a loaded article surface; publication metadata is verified by the preview. */
export async function waitForArticlePage({look, assertArticle, wait, now, signal, budgetMs = 14000, revealToolbar = null}) {
  const deadline = now() + Math.max(1000, Math.min(14000, budgetMs));
  let revealed = false, contentReads = 0;
  for (let attempt = 0; attempt < 9; attempt++) {
    await assertArticle({signal});
    const rows = await look({signal});
    const menu = rows.some(row => row.y >= 90 && row.y < 210 && row.x > 900 && /^[•·.⋯…]{2,}$/u.test(row.text.trim()));
    const results = (hasArticleTabs(rows) || findTab(rows, '文章'))
      && rows.some(row => row.y >= 90 && row.y < 230 && row.x > 700 && /^(?:搜索|取消)$/u.test(row.text.trim()));
    // A restored image-only page may have no OCR body text. Its copied URL and DOM still need verification.
    if (menu && !results) return;
    // The toolbar can be hidden or its gray ••• missed by OCR. After repeated reads with article content
    // and no search UI, accept the page; the
    // share menu that copyLink opens is still verified by its own labels.
    const content = !results && rows.filter(row => row.y >= 260 && row.y + row.h < 1900 && row.text.trim().length >= 2).length >= 2;
    contentReads = content ? contentReads + 1 : 0;
    if (contentReads >= 2 && attempt >= 3) return;
    if (attempt === 8 || now() >= deadline - 650) break;
    // A previously read article reopens at its old scroll position with the title bar (and its •••) hidden.
    // One short downward drag shows the bar again without leaving the article.
    if (!menu && !results && attempt >= 1 && !revealed && revealToolbar && now() < deadline - 1250) {
      await assertArticle({signal}); await revealToolbar(signal); revealed = true;
    }
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
