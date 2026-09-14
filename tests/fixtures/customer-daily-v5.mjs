export function collectionHandlingSnapshot() {
  const empty = {monitor: 0, sdb: 0, positive: 0, neutral: 0, negative: 0, cold: 0, comment: 0, negativeProcess: 0, negativeOther: 0};
  // Collection and handling are different cohorts: these counts deliberately
  // cannot be reconciled as a single sentiment partition or a daily MTD sum.
  const day = {monitor: 280, sdb: 198, positive: 65, neutral: 122, negative: 11, cold: 0, comment: 2, negativeProcess: 9, negativeOther: 2};
  const mtd = {monitor: 1243, sdb: 932, positive: 357, neutral: 515, negative: 60, cold: 19, comment: 2, negativeProcess: 35, negativeOther: 5};
  return {
    schemaVersion: 5, tenantName: '测试客户', reportDate: '2026-09-14', mode: 'formal',
    cutoffAt: '2026-09-14T10:00:00Z', assessedAt: '2026-09-14T10:00:00Z',
    summary: {format: 'daily_collection_handling_v5', mtdBasis: 'distinct_records',
      negativeDailyBasis: 'status_transition_events', negativeMtdBasis: 'distinct_records_last_status',
      dayDate: '2026-09-14', day, mtd, rows: [
        {date: '2026-09-12', isWorkingDay: false, counts: {...empty, cold: 2, comment: 3}},
        {date: '2026-09-13', isWorkingDay: false, counts: empty},
        {date: '2026-09-14', isWorkingDay: true, counts: day},
      ]},
    highHeat: [{title: '旧帖今天处理', platform: 'xiaohongshu', url: 'https://example.test/old-post', heat: 320, status: 'negative_feishu', feishuTableNo: '202609-007'}],
    coldMarked: [], evidence: {cold: {coverageComplete: true}},
  };
}
