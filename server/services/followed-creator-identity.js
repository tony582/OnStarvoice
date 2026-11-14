export function canonicalProfileUrl(rawUrl, platform) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl ?? '').trim());
  } catch {
    return '';
  }
  const normalizedPlatform = String(platform ?? '').trim().toLowerCase();
  const host = parsed.hostname.toLowerCase().replace(/\.$/u, '');
  const base =
    normalizedPlatform === 'xiaohongshu'
      ? 'xiaohongshu.com'
      : normalizedPlatform === 'douyin'
        ? 'douyin.com'
        : normalizedPlatform === 'weibo'
          ? 'weibo.com'
          : '';
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== '443') ||
    !base ||
    !(host === base || host.endsWith(`.${base}`))
  ) return '';
  const validPath =
    normalizedPlatform === 'xiaohongshu'
      ? /^\/user\/profile\/[A-Za-z0-9_-]+\/?$/iu.test(parsed.pathname)
      : normalizedPlatform === 'douyin'
        ? /^\/user\/[A-Za-z0-9._-]+\/?$/iu.test(parsed.pathname)
        : /^\/(?:u\/)?[A-Za-z0-9._-]+\/?$/iu.test(parsed.pathname);
  if (!validPath) return '';
  const allowedQueryKeys =
    normalizedPlatform === 'xiaohongshu'
      ? new Set(['xsec_token', 'xsec_source'])
      : new Set();
  for (const key of [...parsed.searchParams.keys()]) {
    if (!allowedQueryKeys.has(key)) parsed.searchParams.delete(key);
  }
  parsed.hash = '';
  parsed.hostname = host;
  return parsed.toString();
}


export function creatorProfileId(url, platform) {
  const canonical = canonicalProfileUrl(url, platform);
  return canonical ? new URL(canonical).pathname.split('/').filter(Boolean).at(-1) : '';
}

export function normalizeCreatorNickname(value) {
  return String(value ?? '').toWellFormed().normalize('NFKC')
    .replace(/[0-9#*]\uFE0F?\u20E3/gu, '')
    .replace(/[^\p{L}\p{M}\p{N}]/gu, '')
    .replace(/[\uFE0E\uFE0F\u20E3]/gu, '').toLowerCase();
}

export function matchFollowedCreator(record, subscriptions) {
  if (['blogger_profile', 'official_content'].includes(record.record_type)) return null;
  const candidates = subscriptions.filter(s => s.status === 'active' && s.platform === record.platform);
  const unique = matches => matches.length === 1 ? matches[0].id : null;
  if (record.platform === 'wechat_channels') {
    const name = normalizeCreatorNickname(record.author_name);
    return name ? unique(candidates.filter(s => s.match_nicknames?.includes(name))) : null;
  }
  const ids = new Set([record.author_id, creatorProfileId(record.blogger_profile_url, record.platform)].filter(Boolean));
  const exact = candidates.filter(s => ids.has(s.keyword));
  if (exact.length) return unique(exact);
  if (record.platform !== 'douyin' || !record.author_account_no) return null;
  return unique(candidates.filter(s => s.account_no === record.author_account_no));
}

export async function loadCreatorCandidates(db, tenantId, platform) {
  return db.queryAll(`SELECT id, platform, keyword, account_no, match_nicknames, status
    FROM monitor_subscriptions WHERE tenant_id=$1 AND platform=$2
      AND subject_type='creator' AND status='active'`, [tenantId, platform]);
}

export async function identifyFollowedCreator(db, record, tenantId) {
  if (!['xiaohongshu','douyin','weibo','wechat_channels'].includes(record.platform)
    || ['blogger_profile','official_content'].includes(record.record_type)) return null;
  return matchFollowedCreator(record, await loadCreatorCandidates(db, tenantId, record.platform));
}
