function text(value, max = 320) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compactContentRow(row = {}) {
  return {
    id: row.id || row.record_id || '',
    title: text(row.title || row.record_title, 180),
    content: text(row.content, 320),
    ai_summary: text(row.ai_summary, 320),
    url: String(row.url || row.record_url || ''),
    cover_url: String(row.cover_url || row.record_cover_url || ''),
    platform: String(row.platform || 'unknown'),
    author_name: String(row.author_name || row.record_author_name || ''),
    likes: number(row.likes),
    comments_count: number(row.comments_count),
    collects: number(row.collects),
    shares: number(row.shares),
    negative_comment_count: number(row.negative_comment_count),
  };
}

function compactCommentRow(row = {}) {
  return {
    id: row.id || '',
    record_id: row.record_id || '',
    author_name: String(row.author_name || ''),
    content: text(row.content, 320),
    like_count: number(row.like_count),
    risk_level: String(row.risk_level || ''),
    record_title: text(row.record_title, 180),
  };
}

function compactPrevious(previous = {}) {
  return {
    total: number(previous.total),
    newRecords: number(previous.newRecords),
    negativeRate: number(previous.negativeRate),
    sentimentMap: previous.sentimentMap || {},
  };
}

/**
 * The report generator also powers email/archive reports and therefore carries
 * raw payloads and sample pools. The interactive dashboard only needs the
 * presentation fields below. Keeping this boundary explicit avoids repeatedly
 * sending multi-megabyte platform payloads to the browser.
 */
export function compactAnalyticsDashboard(snapshot = {}) {
  const riskItems = snapshot.riskItems || snapshot.topNegative || [];
  const commentRisks = snapshot.commentRisks || snapshot.negativeComments || [];
  return {
    timeBasis: snapshot.timeBasis === 'published' ? 'published' : 'captured',
    total: number(snapshot.total),
    newRecords: number(snapshot.newRecords),
    updatedRecords: number(snapshot.updatedRecords),
    negativeRate: number(snapshot.negativeRate),
    sentimentMap: snapshot.sentimentMap || {},
    sentimentStructure: snapshot.sentimentStructure || [],
    platformMatrix: snapshot.platformMatrix || [],
    triagePeriod: snapshot.triagePeriod || [],
    category: snapshot.category || [],
    volumeTrend: snapshot.volumeTrend || [],
    mediaDistribution: snapshot.mediaDistribution || [],
    regionDistribution: snapshot.regionDistribution || [],
    commentRegionDistribution: snapshot.commentRegionDistribution || [],
    topInteraction: (snapshot.topInteraction || []).map(compactContentRow),
    riskItems: riskItems.map(compactContentRow),
    commentRisks: commentRisks.map(compactCommentRow),
    topAuthors: snapshot.topAuthors || [],
    commentStats: snapshot.commentStats || {},
    issueStats: snapshot.issueStats || {},
    officialPeriod: snapshot.officialPeriod || {},
    opinionIndex: snapshot.opinionIndex || {},
    negativePatrol: snapshot.negativePatrol || {},
    hotTerms: snapshot.hotTerms || [],
    actionItems: snapshot.actionItems || snapshot.actionRecommendations || [],
    previous: compactPrevious(snapshot.previous),
  };
}
