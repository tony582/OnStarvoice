import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const load = relativePath => readFile(
  new URL(`../${relativePath}`, import.meta.url),
  'utf8',
)

const [
  creator,
  drawer,
  dispatchPage,
  monitoringTab,
  monitoringTasksTab,
  taskCard,
  taskLib,
  sidebar,
  monitoringPage,
  desktopApp,
  mobileApp,
  navigation,
  exclusionPage,
] = await Promise.all([
  load('web/admin/src/pages/dispatch/cloud-tasks/OfficialCommentPatrolTaskCreator.tsx'),
  load('web/admin/src/pages/dispatch/cloud-tasks/CreateTaskDrawer.tsx'),
  load('web/admin/src/pages/dispatch/DispatchPage.tsx'),
  load('web/admin/src/pages/monitoring/OfficialCommentPatrolTab.tsx'),
  load('web/admin/src/pages/monitoring/TasksTab.tsx'),
  load('web/admin/src/pages/dispatch/cloud-tasks/TaskCard.tsx'),
  load('web/admin/src/pages/dispatch/cloud-tasks/lib.ts'),
  load('web/admin/src/components/layout/Sidebar.tsx'),
  load('web/admin/src/pages/MonitoringPage.tsx'),
  load('web/admin/src/desktop/DesktopApp.tsx'),
  load('web/admin/src/mobile/MobileApp.tsx'),
  load('web/admin/src/lib/navigation.tsx'),
  load('web/admin/src/pages/OwnedAccountExclusionsPage.tsx'),
])

test('official comment patrol is created directly from an account homepage', () => {
  assert.match(creator, /\/capture-cloud\/official-comment-patrol\/tasks/u)
  assert.match(creator, /Agent 会从账号主页按最新顺序读取你指定数量的作品/u)
  assert.match(creator, /作品加载数量/u)
  assert.match(creator, /每篇评论采集数量/u)
  assert.match(creator, /const \[postsLimit, setPostsLimit\] = useState<number \| ''>\(''\)/u)
  assert.match(creator, /const \[commentsLimit, setCommentsLimit\] = useState<number \| ''>\(''\)/u)
  assert.equal(creator.match(/max=\{100\}/gu)?.length, 1)
  assert.match(creator, /不设 100 条固定上限/u)
  assert.match(creator, /Number\.isSafeInteger\(commentsLimit\)[\s\S]*commentsLimit < 1/u)
  assert.doesNotMatch(creator, /commentsLimit > 100/u)
  assert.match(creator, /postsLimit/u)
  assert.match(creator, /commentsLimit/u)
  assert.match(creator, /新作品会入库，已存在作品也会重新读取评论并补充更新/u)
  assert.doesNotMatch(creator, /publishDateFrom|publishDateTo|发布时间范围/u)
  assert.doesNotMatch(creator, /candidates\/preview|recordIds|selectedIds|预览作品/u)
})

test('official comment patrol only offers accounts supported by the selected Agent', () => {
  assert.match(
    creator,
    /const compatibleAccounts = useMemo\([\s\S]*accounts\.filter\(account => availablePlatforms\.includes\(account\.platform\)\)/u,
  )
  assert.match(
    creator,
    /compatibleAccounts\.find\(account => account\.id === accountId\)[\s\S]*compatibleAccounts\.find\(account => account\.id === initialOfficialAccountId\)[\s\S]*compatibleAccounts\[0\]/u,
  )
  assert.match(creator, /compatibleAccounts\.map\(account =>/u)
  assert.match(creator, /value=\{selectedAccount\?\.id \|\| ''\}/u)
  assert.match(creator, /disabled=\{disabled \|\| compatibleAccounts\.length === 0\}/u)
  assert.match(creator, /当前 Agent 暂无可巡查的/u)
})

test('official comment patrol uses the same remote profile capability bundle as the server', () => {
  assert.match(creator, /agentTaskTypeBlockReason\(agent, 'comment_patrol', 'one_time'\)/u)
  const start = taskLib.indexOf('export function agentTaskTypeBlockReason')
  const end = taskLib.indexOf('export function hasConfiguredUnattendedPlan', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  const compatibility = taskLib.slice(start, end)
  assert.match(
    compatibility,
    /\['creator_patrol', 'negative_patrol', 'comment_patrol'\]\.includes\(taskType\)[\s\S]*remoteTargetedPostCaptureV1/u,
  )
  assert.match(compatibility, /officialAccountCommentPatrolProfileV1/u)
  assert.match(compatibility, /officialAccountLatestPostsByCountV1/u)
  assert.doesNotMatch(compatibility, /officialAccountCommentPatrol !== true/u)
  assert.match(taskLib, /agentAssignmentBlockReason[\s\S]*remoteTaskCreate !== true/u)
})

test('admin navigation no longer exposes an official discovery task', () => {
  assert.doesNotMatch(drawer, /official_discovery|官方账号作品发现/u)
  assert.doesNotMatch(dispatchPage, /official_discovery/u)
  assert.doesNotMatch(monitoringTab, /official_discovery|createDiscoveryTask|创建作品发现任务|发现近期作品/u)
  assert.doesNotMatch(monitoringTasksTab, /作品发现/u)
  assert.doesNotMatch(taskLib, /official_discovery/u)
})

test('legacy official discovery tasks remain readable', () => {
  assert.match(taskCard, /official_account_post_discovery/u)
  assert.match(taskCard, /官方账号作品发现/u)
})

test('official social is one top-level navigation entry', () => {
  assert.match(sidebar, /\{ id: 'official-comments', label: '官方社媒', icon: Megaphone \}/u)
  assert.doesNotMatch(sidebar, /official-social|official-accounts|官方账号管理/u)
  assert.match(mobileApp, /title: '官方社媒', subtitle: '帖子趋势、评论情绪与运营建议'/u)
  assert.doesNotMatch(mobileApp, /official-accounts|官方账号管理|OfficialAccountsPage/u)
  assert.match(sidebar, /id: 'owned-account-exclusions', label: '自营内容排除'/u)
  assert.match(mobileApp, /title: '自营内容排除', subtitle: '避免自营发文进入内容分诊'/u)
  assert.match(desktopApp, /'official-comments': OfficialCommentPatrolTab/u)
  assert.doesNotMatch(desktopApp, /official-accounts|OfficialAccountsPage|官方账号管理/u)
  assert.match(navigation, /'official-accounts': \{ page: 'official-comments' \}/u)
  assert.match(
    desktopApp,
    /page === 'official-comments'[\s\S]*\? 'pb-0 pt-0 xl:h-dvh xl:overflow-hidden'/u,
  )
  assert.doesNotMatch(monitoringPage, /官方账号评论巡查/u)
})

test('self-owned-content exclusion stays separate from official social', () => {
  assert.match(exclusionPage, /skip_content/u)
  assert.match(exclusionPage, /自营内容排除名单/u)
  assert.match(exclusionPage, /回溯排除历史官方内容/u)
})

test('official comment workbench focuses on posts, engagement, and advice', () => {
  assert.match(monitoringTab, /帖子信息/u)
  assert.match(monitoringTab, /情感分布/u)
  assert.match(monitoringTab, /互动数据/u)
  assert.match(monitoringTab, /最近采集/u)
  assert.match(monitoringTab, /label: '点赞'/u)
  assert.match(monitoringTab, /label: '评论'/u)
  assert.match(monitoringTab, /label: '转发'/u)
  assert.match(monitoringTab, /EngagementTrend/u)
  assert.match(monitoringTab, /bg-blue-50 text-blue-700/u)
  assert.match(monitoringTab, /bg-amber-50 text-amber-700/u)
  assert.match(monitoringTab, /text-\[12px\] font-bold text-foreground/u)
  assert.match(monitoringTab, /flex h-2\.5 gap-px overflow-hidden/u)
  assert.match(monitoringTab, /text-\[11px\] font-semibold tabular-nums/u)
  assert.match(monitoringTab, /function PlatformIcon/u)
  assert.match(monitoringTab, /xiaohongshu \? BookOpen : Music2/u)
  assert.match(monitoringTab, /inline-flex h-5 w-5 shrink-0/u)
  assert.match(monitoringTab, /aria-label=\{label\}/u)
  assert.doesNotMatch(monitoringTab, /platformBadgeClass/u)
  assert.match(monitoringTab, /较上次采集/u)
  assert.match(monitoringTab, /负面评论/u)
  assert.match(monitoringTab, /正面评论/u)
  assert.match(monitoringTab, /建议：/u)
  assert.doesNotMatch(monitoringTab, /本次巡查|上次巡查|相比上次巡查|较上次巡查|风险趋势|评论覆盖|本次新增/u)
  assert.doesNotMatch(monitoringTab, /CommentActionButton|标记完成|delete_review|encourage_reply|manual_complete/u)
  assert.doesNotMatch(monitoringTab, />帖子列表</u)
  assert.doesNotMatch(monitoringTab, /CircleUserRound|authorAvatar/u)
  assert.doesNotMatch(monitoringTab, /查看原帖/u)
  assert.doesNotMatch(monitoringTab, /Sparkles/u)
  assert.doesNotMatch(monitoringTab, /巡查新鲜度|近 7 天|巡查设置|立即巡查/u)
  assert.match(monitoringTab, /aria-label="排序"/u)
  assert.match(monitoringTab, /发帖时间：新到旧/u)
  assert.match(monitoringTab, /最近采集时间：新到旧/u)
  assert.match(monitoringTab, /发起巡查/u)
  assert.doesNotMatch(monitoringTab, /官方社媒设置|登记官方账号|OfficialAccountRegistrationDrawer|registrationOpen/u)
  assert.doesNotMatch(monitoringTasksTab, /mark-official|设为官方账号|这是官方账号|登记官方账号/u)
  assert.match(
    monitoringTab,
    /<form onSubmit=\{submitSearch\}[\s\S]*aria-label="平台"[\s\S]*aria-label="官方账号"[\s\S]*aria-label="排序"/u,
  )
  assert.match(monitoringTab, /space-y-0 duration-300/u)
  assert.match(monitoringTab, /border-b border-border\/70 py-4/u)
  assert.match(monitoringTab, /flex shrink-0 gap-1 border-b border-border\/60 px-3/u)
  assert.doesNotMatch(monitoringTab, /border-b border-border\/60 px-3 pt-2/u)
})

test('official post publish times include the year for cross-year records', () => {
  const start = monitoringTab.indexOf('function formatPublish')
  const end = monitoringTab.indexOf('function comparableDate', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  const formatter = monitoringTab.slice(start, end)

  assert.match(formatter, /new Intl\.DateTimeFormat\('zh-CN'/u)
  assert.match(formatter, /year: 'numeric'/u)
  assert.match(formatter, /month: '2-digit'/u)
  assert.match(formatter, /day: '2-digit'/u)
  assert.doesNotMatch(formatter, /return formatDateTime\(value\)/u)
  assert.equal(
    monitoringTab.match(/formatPublish\(post\.publishedAt, post\.publishTime\)/gu)?.length,
    2,
  )
})

test('official comment workbench uses a dispatch-style split and complete list pagination', () => {
  assert.match(
    monitoringTab,
    /xl:grid-cols-\[minmax\(0,3fr\)_minmax\(380px,2fr\)\]/u,
  )
  assert.match(monitoringTab, /xl:min-h-0 xl:flex-1/u)
  assert.doesNotMatch(monitoringTab, /xl:h-\[calc\(100dvh-9\.5rem\)\]/u)
  assert.match(monitoringTab, /xl:border-l xl:border-border\/70 xl:pl-4/u)
  assert.match(monitoringTab, /workspace-scrollbar min-h-0 flex-1 overflow-y-auto/u)
  assert.match(monitoringTab, /<thead className="sticky top-0 z-20 bg-card">/u)
  assert.match(monitoringTab, /PAGE_SIZE_OPTIONS/u)
  assert.match(monitoringTab, /getPaginationItems/u)
  assert.match(monitoringTab, /aria-label="每页条数"/u)
  assert.match(monitoringTab, /aria-label="跳转页码"/u)
  assert.match(monitoringTab, /第 \{formatNumber\(pageStart\)\}–\{formatNumber\(pageEnd\)\} 条/u)
  assert.match(monitoringTab, /lg:flex-row lg:items-center lg:justify-between/u)
  assert.match(monitoringTab, /lg:flex-nowrap lg:justify-end/u)
})

test('every post surface provides a safe original-post link', () => {
  assert.match(monitoringTab, /查看原文/u)
  assert.match(monitoringTab, /target="_blank"/u)
  assert.match(monitoringTab, /rel="noreferrer"/u)
  assert.match(monitoringTab, /原文链接待补充/u)
})
