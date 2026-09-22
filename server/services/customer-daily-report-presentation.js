const PLATFORMS = {xiaohongshu: '小红书', xhs: '小红书', douyin: '抖音', weibo: '微博', bilibili: '哔哩哔哩', wechat: '微信', zhihu: '知乎', kuaishou: '快手', toutiao: '今日头条', unknown: '未知平台'};

export const CUSTOMER_DAILY_SECTIONS = Object.freeze({
  summary: '一、监控汇总（本期新增）',
  heat: '二、7天内热度值≥200的负面帖子',
  cold: '三、本期冷处理负面帖',
});
export const CUSTOMER_DAILY_SUMMARY_HEADERS = Object.freeze(['日期', '监控数量', 'SDB范畴', '正向', '中性', '冷处理', '处理中', '已处理']);
export const CUSTOMER_DAILY_MONTHLY_HEADERS = Object.freeze(['舆情处理日期', '平台监控量', 'SDB范畴', '正面', '中性', '负面-冷处理', '负面-评论区留言', '负面-负面处理流程', '负面-其他']);
export const isHandlingDailyReport = snapshot => snapshot?.summary?.format === 'daily_handling_v3' && Array.isArray(snapshot.summary.rows);
export const isCollectionDailyReport = snapshot => snapshot?.summary?.format === 'daily_collection_v4' && Array.isArray(snapshot.summary.rows);
export const isCollectionHandlingDailyReport = snapshot => snapshot?.summary?.format === 'daily_collection_handling_v5' && Array.isArray(snapshot.summary.rows);
const isSingleTableDailyReport = snapshot => isCollectionDailyReport(snapshot) || isCollectionHandlingDailyReport(snapshot);
export const isGroupedDailyReport = snapshot => isHandlingDailyReport(snapshot) || isSingleTableDailyReport(snapshot);
export const isMonthlyDailyReport = snapshot => ['daily_disposition_v2', 'daily_handling_v3', 'daily_collection_v4', 'daily_collection_handling_v5'].includes(snapshot?.summary?.format) && Array.isArray(snapshot.summary.rows);
export const CUSTOMER_DAILY_HANDLING_HEADERS = Object.freeze(['舆情处理日期', '处理量', 'SDB范畴', '正面', '中性', '负面-冷处理', '负面-评论区留言', '负面-走负面处理流程', '负面-其他']);
export const CUSTOMER_DAILY_COLLECTION_HEADERS = Object.freeze(['舆情处理日期', '平台监控量', 'SDB范畴', '正面', '中性', '负面-冷处理', '负面-评论区留言', '负面-走负面处理流程', '负面-其他']);
export const customerDailySummaryBasis = snapshot => isCollectionHandlingDailyReport(snapshot) ? '采集列按采集日期统计；四项负面按实际处理日期计次数（含旧帖）；MTD 按帖去重。' : isCollectionDailyReport(snapshot) ? '首次入库采集统计' : '';
export const customerDailySections = snapshot => isSingleTableDailyReport(snapshot) ? {...CUSTOMER_DAILY_SECTIONS, summary: '一、每日舆情处理量'} : isHandlingDailyReport(snapshot) ? {summary: '一、每日舆情处理量', collection: '二、实际采集量', heat: '三、7天内热度值≥200的负面帖子', cold: '四、本期冷处理负面帖'} : CUSTOMER_DAILY_SECTIONS;
export const customerDailyCollectionSnapshot = snapshot => ({...snapshot, summary: snapshot.collectionSummary, collectionDisplay: true});
export const customerDailyTables = snapshot => [{snapshot, title: customerDailySections(snapshot).summary}, ...(isHandlingDailyReport(snapshot) && snapshot.collectionSummary ? [{snapshot: customerDailyCollectionSnapshot(snapshot), title: customerDailySections(snapshot).collection, collection: true}] : [])];
export const customerDailyTableCaption = snapshot => isSingleTableDailyReport(snapshot) ? '本月去重累计' : snapshot.collectionDisplay ? '本月采集去重累计' : '本月处理累计';
export const customerDailySummaryHeaders = snapshot => isSingleTableDailyReport(snapshot) ? CUSTOMER_DAILY_COLLECTION_HEADERS : snapshot.collectionDisplay ? ['日报日期', '采集量', 'SDB范畴', '正面', '中性', '负面'] : isHandlingDailyReport(snapshot) ? CUSTOMER_DAILY_HANDLING_HEADERS : isMonthlyDailyReport(snapshot) ? CUSTOMER_DAILY_MONTHLY_HEADERS : CUSTOMER_DAILY_SUMMARY_HEADERS;

function count(value) { return Number(value) || 0; }

export function customerDailySummaryRows(snapshot, {hideRestDays = isGroupedDailyReport(snapshot)} = {}) {
  if (snapshot.collectionDisplay) {
    const values = (label, counts = {}) => [label, ...['monitor', 'sdb', 'positive', 'neutral', 'negative'].map(field => count(counts[field]))];
    return [...snapshot.summary.rows.filter(row => row.isWorkingDay !== false || count(row.counts?.monitor) > 0).map(row => {
      const [year, month, day] = row.date.split('-');
      return values(`${year}/${Number(month)}/${Number(day)}`, row.counts);
    }), values('MTD', snapshot.summary.mtd)];
  }
  if (isMonthlyDailyReport(snapshot)) {
    const values = (label, counts = {}, working = true) => [label, ...['monitor', 'sdb', 'positive', 'neutral', 'cold', 'comment', 'negativeProcess', 'negativeOther'].map(field => working ? counts[field] : null)];
    // v5 handling can concern older posts on a day with no new collection.
    const hasActivity = row => count(row.counts?.monitor) > 0 || (isCollectionHandlingDailyReport(snapshot) && ['cold', 'comment', 'negativeProcess', 'negativeOther'].some(field => count(row.counts?.[field]) > 0));
    return [...snapshot.summary.rows.filter(row => !hideRestDays || row.isWorkingDay !== false || hasActivity(row)).map(row => {
      const [year, month, day] = row.date.split('-');
      return values(`${year}/${Number(month)}/${Number(day)}`, row.counts, hideRestDays || row.isWorkingDay !== false);
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
  if (post.heatIsLowerBound) return '较昨日 暂无可比数据';
  const comparison = String(post.comparisonText || '暂无对比').replace(/^较昨日\s*[:：]?\s*/, '').trim();
  return `较昨日 ${comparison || '暂无对比'}`;
}

export function customerDailyPostHeat(post) {
  if (typeof post.heat !== 'number' || !Number.isFinite(post.heat) || post.heat < 0) return '待核实';
  // Xiaohongshu heat is the total of its visible likes, comments, and collects.
  const visibleXiaohongshuHeat = ['xiaohongshu', 'xhs'].includes(post.platform)
    && post.missingMetrics?.length === 1 && post.missingMetrics[0] === 'shares';
  if (!post.heatIsLowerBound || visibleXiaohongshuHeat) return String(post.heat);
  return `至少 ${post.heat}`;
}

export function customerDailyColdEmpty(snapshot) {
  return snapshot.evidence?.cold?.coverageComplete ? '本期无冷处理负面帖子。' : '暂未检出。';
}

export function customerDailyColdTitle(snapshot) {
  const posts = Array.isArray(snapshot.coldMarked) ? snapshot.coldMarked : [];
  const historicalCount = posts.filter(post => post?.isHistorical === true).length;
  // Saved reports created before cohort flags existed cannot prove a historical split.
  const knownSplit = posts.every(post => typeof post?.isHistorical === 'boolean');
  return `${customerDailySections(snapshot).cold}：${posts.length} 条${knownSplit && historicalCount > 0 ? `（含历史帖 ${historicalCount} 条）` : ''}`;
}

export function customerDailyColdPostLabel(post) {
  return post?.isHistorical === true ? '历史帖' : '';
}

const POST_STATUS_LABELS = Object.freeze({unhandled: '待处理', reviewed: '已复核', reviewed_non_monitor: '已复核-非监控内容', replied: '已回复', unavailable: '已不可见', privacy_unreachable: '隐私设置无法触达', negative_feishu: '飞书表', negative_cold: '冷处理', negative_comment: '评论区留言'});
export function customerDailyPostStatus(post) {
  const label = POST_STATUS_LABELS[post?.status];
  if (!post?.status) return '状态未记录';
  if (!label) return '状态待核对';
  const number = String(post.feishuTableNo ?? '').replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();
  return post.status === 'negative_feishu' && number ? `${label} · ${number}` : label;
}
