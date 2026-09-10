const PLATFORMS = {xiaohongshu: '小红书', xhs: '小红书', douyin: '抖音', weibo: '微博', bilibili: '哔哩哔哩', wechat: '微信', zhihu: '知乎', kuaishou: '快手', toutiao: '今日头条', unknown: '未知平台'};

export const CUSTOMER_DAILY_SECTIONS = Object.freeze({
  summary: '一、监控汇总（本期新增）',
  heat: '二、7天内热度值≥200的负面帖子',
  cold: '三、本期冷处理负面帖',
});
export const CUSTOMER_DAILY_SUMMARY_HEADERS = Object.freeze(['日期', '监控数量', 'SDB范畴', '正向', '中性', '冷处理', '处理中', '已处理']);
export const CUSTOMER_DAILY_MONTHLY_HEADERS = Object.freeze(['舆情处理日期', '平台监控量', 'SDB范畴', '正面', '中性', '负面-冷处理', '负面-评论区留言', '负面-负面处理流程', '负面-其他']);
export const isMonthlyDailyReport = snapshot => snapshot?.summary?.format === 'daily_disposition_v2' && Array.isArray(snapshot.summary.rows);
export const customerDailySummaryHeaders = snapshot => isMonthlyDailyReport(snapshot) ? CUSTOMER_DAILY_MONTHLY_HEADERS : CUSTOMER_DAILY_SUMMARY_HEADERS;

function count(value) { return Number(value) || 0; }

export function customerDailySummaryRows(snapshot) {
  if (isMonthlyDailyReport(snapshot)) {
    const values = (label, counts = {}, working = true) => [label, ...['monitor', 'sdb', 'positive', 'neutral', 'cold', 'comment', 'negativeProcess', 'negativeOther'].map(field => working ? counts[field] : null)];
    return [...snapshot.summary.rows.map(row => {
      const [year, month, day] = row.date.split('-');
      return values(`${year}/${Number(month)}/${Number(day)}`, row.counts, row.isWorkingDay !== false);
    }), values('MTD', snapshot.summary.mtd)];
  }
  const [, month, day] = String(snapshot.reportDate || '').split('-');
  const handling = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const values = (label, counts = {}) => [label, count(counts.monitor), count(counts.sdb), count(counts.positive), count(counts.neutral), count(counts.cold), handling(counts.inProgress), handling(counts.processed)];
  // Missing customer-maintained values stay blank; explicitly saved zero is meaningful.
  return [values(`${Number(month)}月${Number(day)}日`, snapshot.summary?.day), values('MTD', snapshot.summary?.mtd)];
}

export function customerDailySummaryNote(snapshot) {
  return `负面总数：当日 ${count(snapshot.summary?.day?.negative)} 条；MTD ${count(snapshot.summary?.mtd?.negative)} 条。`;
}

export function customerDailyPostPlatform(post) {
  return PLATFORMS[post.platform] || post.platform || '未知平台';
}

export function customerDailyPostComparison(post) {
  const comparison = String(post.comparisonText || '暂无对比').replace(/^较昨日\s*[:：]?\s*/, '').trim();
  return `较昨日 ${comparison || '暂无对比'}`;
}

export function customerDailyColdEmpty(snapshot) {
  return snapshot.evidence?.cold?.coverageComplete ? '本期无冷处理负面帖子。' : '暂未检出。';
}

export function customerDailyColdTitle(snapshot) {
  const posts = Array.isArray(snapshot.coldMarked) ? snapshot.coldMarked : [];
  const historicalCount = posts.filter(post => post?.isHistorical === true).length;
  // Saved reports created before cohort flags existed cannot prove a historical split.
  const knownSplit = posts.every(post => typeof post?.isHistorical === 'boolean');
  return `${CUSTOMER_DAILY_SECTIONS.cold}：${posts.length} 条${knownSplit && historicalCount > 0 ? `（含历史帖 ${historicalCount} 条）` : ''}`;
}

export function customerDailyColdPostLabel(post) {
  return post?.isHistorical === true ? '历史帖' : '';
}
