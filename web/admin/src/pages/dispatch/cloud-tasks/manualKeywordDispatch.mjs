export function splitManualKeywords(keywordText, agentIds) {
  const keywords = [...new Set(String(keywordText || '').split(/\r?\n/).map(word => word.trim()).filter(Boolean))];
  const ids = [...new Set(agentIds)];
  if (!ids.length || !keywords.length) return [];
  if (keywords.length > ids.length * 30) throw new Error('每个节点最多 30 个关键词，请增加节点或减少关键词');
  let offset = 0;
  return ids.map((agentId, index) => {
    const count = Math.floor(keywords.length / ids.length) + (index < keywords.length % ids.length ? 1 : 0);
    const group = {agentId, keywords: keywords.slice(offset, offset + count)};
    offset += count;
    return group;
  }).filter(group => group.keywords.length);
}

export const MANUAL_SEARCH_FILTERS = [
  {key: 'contentType', label: '内容类型', options: [['all', '不限'], ['image', '图文'], ['video', '视频']]},
  {key: 'searchScope', label: '搜索范围', options: [['all', '不限'], ['followed', '已关注'], ['viewed', '已看过'], ['unviewed', '未看过']]},
  {key: 'distance', label: '位置距离', options: [['all', '不限'], ['city', '同城'], ['nearby', '附近']]},
  {key: 'videoDuration', label: '视频时长', platform: 'douyin', options: [['all', '不限'], ['under_1m', '1 分钟以下'], ['1_5m', '1–5 分钟'], ['over_5m', '5 分钟以上']]},
];
