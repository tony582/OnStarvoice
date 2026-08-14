import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function source(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

test('analytics dashboard follows the tenant comment-risk scope without losing the historical default', async () => {
  const dashboard = await source('web/admin/src/pages/insights/DashboardTab.tsx');

  assert.match(dashboard, /import \{ useBadges \} from '@\/lib\/badges'/u);
  assert.match(dashboard, /features\?: \{[\s\S]*commentRiskAttentionEnabled\?: boolean/u);
  assert.match(
    dashboard,
    /data\?\.snapshot\?\.commentRiskAttentionEnabled[\s\S]*data\?\.features\?\.commentRiskAttentionEnabled[\s\S]*workspaceFeatures\.loaded \? workspaceFeatures\.commentRiskAttentionEnabled : true/u,
  );

  assert.match(
    dashboard,
    /includeCommentRisk \? G\.risk : G\.riskWithoutComments/u,
  );
  assert.match(
    dashboard,
    /riskWithoutComments: '舆情风险指数\(0~100\)=负面率\/高危未关闭问题\/告警[\s\S]*不将评论纳入风险统计/u,
  );
});

test('negative comment risk panel is tenant-gated while enabled tenants keep the two-column view', async () => {
  const dashboard = await source('web/admin/src/pages/insights/DashboardTab.tsx');

  assert.match(
    dashboard,
    /commentRiskAttentionEnabled \? 'xl:grid-cols-2' : ''/u,
  );
  assert.match(
    dashboard,
    /\{commentRiskAttentionEnabled && \([\s\S]*title="负面评论与风险"[\s\S]*<CommentRisks rows=/u,
  );
  assert.doesNotMatch(
    dashboard,
    /!commentRiskAttentionEnabled[\s\S]*负面评论与风险/u,
  );
});

test('comment raw-data and triage entrances remain available outside risk statistics', async () => {
  const [dashboard, dataPage, mobile] = await Promise.all([
    source('web/admin/src/pages/insights/DashboardTab.tsx'),
    source('web/admin/src/pages/DataPage.tsx'),
    source('web/admin/src/mobile/MobileApp.tsx'),
  ]);

  assert.match(dashboard, /<RegionPanel content=\{s\.regionDistribution \|\| \[\]\} comment=\{s\.commentRegionDistribution \|\| \[\]\} \/>/u);
  assert.match(dataPage, /key: 'comment_leads'/u);
  assert.match(dataPage, /navigate\('workbench', \{ queue: 'leads' \}\)/u);
  assert.match(mobile, /title="评论分诊"[\s\S]*queue: 'leads'/u);
});
