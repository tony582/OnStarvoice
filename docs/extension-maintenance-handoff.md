# 扩展代码维护交接手册

本文面向未来的维护者和接手本仓库的 AI。目标不是推动马上重构，而是在不触碰业务代码的前提下，把 Chrome 扩展侧的大文件结构、风险边界、入口关系和回归清单写清楚。

如果很久以后再回来，先读本文。除非正在定位具体 bug，不建议一开始就完整阅读 `sidebar/sidebar-logic.js` 和 `utils/capture-sync.js`。

最后更新: 2026-07-08

## 1. 一句话结论

当前扩展侧最大的维护风险不是性能，而是两个大文件承载了太多职责:

| 文件 | 当前规模 | 角色 | 建议态度 |
|---|---:|---|---|
| `sidebar/sidebar-logic.js` | 约 18k 行 | 侧边栏业务入口, UI 事件, 采集按钮, 批量任务, 监控, 导出 | 只在明确需求下小步修改 |
| `utils/capture-sync.js` | 约 11k 行 | 采集编排, 入池去重, 同步, 详情补采, 评论客资, 批量关键词/链接 | 更高风险, 不要主动大拆 |

推荐策略:

1. 不为了“文件太大”单独大重构。
2. 先补文档和回归清单。
3. 以后改某个功能时, 只围绕该功能做小范围整理。
4. 如果要拆文件, 先保持原入口和导出兼容, 只搬代码, 不改行为。

## 2. 未来 AI 快速接手提示

可以把下面这段直接给接手的 AI:

```text
你正在维护 StarVoice Chrome 扩展。先读 docs/extension-maintenance-handoff.md, 不要一开始吞完整 sidebar/sidebar-logic.js 或 utils/capture-sync.js。

原则:
1. 不做大重构。
2. 不改 storage key, MESSAGE_TYPE, sync payload 结构, Chrome tab 导航/等待顺序。
3. 如果必须改扩展源码, 记得运行的是 extension-build/ 手动快照, 源码改完还要同步到 extension-build/ 才能给浏览器加载。
4. sidebar/sidebar-logic.js 是 sidebar.html 的业务入口。
5. utils/capture-sync.js 是采集和同步编排入口, 对外导出很多函数, 不要随意改函数签名。
6. 改动前先说明影响链路, 改动后按本文回归清单验证。
```

## 3. 仓库里扩展相关的运行关系

扩展源码主要在仓库根目录:

```text
manifest.json
background.js
content-loader.js
content-v2.js
sidebar/
utils/
extension-build/
```

重要提醒:

1. `manifest.json` 是源码清单。
2. README 已说明: 浏览器实际加载通常是 `extension-build/` 这个手动快照。
3. 修改根目录的 `utils/`, `sidebar/`, `background.js`, `content-v2.js`, `manifest.json` 后, 若要让浏览器使用, 需要同步到 `extension-build/` 并在 `chrome://extensions` Reload。
4. `deploy/deploy.sh` 部署后端和后台, 不部署扩展。

典型加载链路:

```text
manifest.json
  background.service_worker -> background.js
  side_panel.default_path   -> sidebar/sidebar.html
  content_scripts           -> content-loader.js

content-loader.js
  import(chrome.runtime.getURL("content-v2.js"))

sidebar/sidebar.html
  <script type="module" src="sidebar-logic.js">
  <script type="module" src="sidebar-ui.js">
```

`sidebar-logic.js` 和 `sidebar-ui.js` 是两个并列 module。它们通过 DOM、状态模块和少量 `window.*` 方法互相配合。

## 4. 先读顺序

为了省 token 和减少误判, 不同任务先读不同文件:

### 4.1 只改后端或后台

不用读两个万行文件。读:

1. `README.md`
2. 对应的 `server/routes/*` 或 `web/admin/src/*`
3. 必要时读 `docs/API接口文档.md`

### 4.2 改扩展 sidebar UI

先读:

1. `sidebar/sidebar.html`
2. `sidebar/sidebar.css`
3. `sidebar/sidebar-ui.js`
4. `sidebar/sidebar-logic.js` 中 `setupUIEventListeners`, `updateUI`, `updateDataPoolUI` 附近

不要先全量读 `sidebar/sidebar-logic.js`。

### 4.3 改采集按钮或批量任务

先读:

1. `sidebar/sidebar-logic.js`
2. `utils/capture-sync.js`
3. `utils/capture/index.js`
4. 对应平台采集文件:
   - 小红书: `utils/capture/single-note.js`, `utils/capture/blogger.js`, `utils/capture/keyword-search.js`, `utils/capture/comments.js`
   - 抖音: `utils/capture/douyin-single-note.js`, `utils/capture/douyin-blogger.js`, `utils/capture/douyin-keyword-search.js`, `utils/capture/douyin-comments.js`
   - 微博: `utils/capture/weibo-single-note.js`, `utils/capture/weibo-blogger.js`, `utils/capture/weibo-keyword-search.js`

### 4.4 改同步或入库 payload

先读:

1. `utils/capture-sync.js`
2. `utils/platform/sync-router.js`
3. `utils/platform/record-envelope.js`
4. `utils/storage.js`
5. `utils/api.js`
6. `server/routes/sync.js`
7. `server/services/record-store.js`

### 4.5 改平台识别或页面类型

先读:

1. `utils/constants.js`
2. `utils/platform/page-routing.js`
3. `utils/helpers.js`
4. `background.js` 的 runtime sync 逻辑
5. `content-v2.js` 的 page state 上报逻辑

### 4.6 改导出或下载

先读:

1. `sidebar/sidebar-logic.js` 中 `handleExport`, `handleDownloadRecordMedia`, `build*CsvRows`, `download*` 系列函数
2. `sidebar/sidebar-ui.js` 中记录列表点击相关逻辑
3. `utils/storage.js` 的 record/dataPool 结构

这类功能相对独立, 如果以后真的要拆文件, 这里是低风险试点。

## 5. 核心边界和不可轻易改动项

### 5.1 `utils/constants.js`

这里定义了跨模块协议:

1. `STORAGE_KEY`: Chrome storage key。改名会造成老数据读不到。
2. `MESSAGE_TYPE`: sidebar, background, content script 之间通信协议。改动会导致消息收发断链。
3. `SYNC_TYPE`: 前端记录类型和后端同步类型。改动会影响 payload 路由、记录归类、后台数据。
4. `PAGE_TYPE`: 页面识别结果。改动会影响按钮状态和采集模式判断。
5. `API_ENDPOINT`: 扩展调用后端的接口路径。

除非要做兼容迁移, 不要直接重命名这些常量值。

### 5.2 `utils/storage.js`

这是扩展侧本地状态的主要封装, 包括:

1. runtime
2. auth
3. target
4. capture
5. sync
6. monitor
7. dataPool
8. syncHistory

风险点:

1. `dataPool.records` 是很多 UI 和同步流程的共同来源。
2. `record.payload` 和 `record.detailPayload` 的结构被导出、同步、补采、后端解析共同依赖。
3. `markRecordSynced`, `updateRecord`, `addRecords` 这类函数如果行为改变, 影响范围很大。

### 5.3 `background.js`

负责:

1. 侧边栏打开。
2. active tab runtime 同步。
3. 接收 content script 的页面变化和进度消息。
4. 转发 sidebar 到 content script 的请求。
5. 某些平台 tab 切换或创建。

风险点:

1. `chrome.runtime.onMessage.addListener` 必须在异步响应时 `return true`。
2. 任何消息返回结构变更, 都要同步改 sidebar 和 content 调用方。
3. 页面类型和当前 tab id 错误, 会让 sidebar 判断错当前平台或采集按钮状态。

### 5.4 `content-loader.js` 与 `content-v2.js`

`content-loader.js` 很小, 作用是把 `content-v2.js` 作为 module 动态加载。`content-v2.js` 负责:

1. 接收采集命令。
2. 调用 `utils/capture/*` 里的具体采集模块。
3. 向 background 上报页面状态和采集进度。

风险点:

1. content script 运行在目标网站页面环境中, DOM 和滚动非常脆弱。
2. 小红书、抖音、微博 DOM 经常变, 选择器修复要尽量局部。
3. 页面上报如果过于频繁或字段变更, 会影响 sidebar 状态。

## 6. `sidebar/sidebar-logic.js` 代码地图

这个文件是侧边栏的业务中枢, 当前混合了多个职责。不要试图靠阅读顺序理解全部, 应按功能块定位。

### 6.1 外部依赖

主要 import:

1. `./state.js`: sidebar 内存状态和 storage refresh。
2. `../utils/capture-sync.js`: 采集和同步主流程。
3. `../utils/capture-settings.js`: 采集配置。
4. `../utils/storage.js`: dataPool 和 syncHistory 等本地数据。
5. `../utils/api.js`: 后端接口, 包括授权、目标配置、关键词分析、监控。
6. `../utils/constants.js`: 页面类型、同步类型、消息类型、错误码。
7. `../utils/scroll.js`: 取消标记和等待。
8. `../utils/diagnostics.js`: 诊断日志。
9. `../utils/task-context.js`: 任务上下文。
10. `./platform-registry.js`: 平台能力和文案。

### 6.2 公开入口

`sidebar/sidebar.html` 直接加载 `sidebar-logic.js`。文件公开导出:

```js
export async function initSidebar()
```

底部还有自动初始化:

```js
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initSidebar);
} else {
  initSidebar();
}
```

风险点:

1. 不要重复调用 `initSidebar`, 否则可能重复绑定事件。
2. 如果以后拆初始化, 要保证事件绑定只执行一次。
3. `beforeunload` 里有取消/清理逻辑, 不要漏掉。

### 6.3 主要功能块

按当前文件中的大致顺序:

| 区域 | 代表函数 | 职责 | 风险 |
|---|---|---|---|
| 批量操作弹窗 | `openBatchModal`, `handleRunBatchLinks`, `handleRunBatchBloggers` | 批量链接/博主/关键词入口和草稿 | 中 |
| 关键词计划/洞察 | `handleSaveKeywordPlan`, `handleExpandKeywords`, `handleRunKeywordOpportunity`, `handleRunBenchmarkDiscovery` | 关键词裂变、机会分析、对标发现、卡片导出 | 中 |
| 初始化 | `initSidebar`, `setupStateSubscriptions`, `setupUIEventListeners` | 初始化状态、绑定事件、启动 timers | 高 |
| 更新提示/版本 | `checkExtensionUpdate`, `renderUpdateNoticeModal` | 版本检查和更新弹窗 | 低到中 |
| 主采集动作 | `handleCaptureNoteData`, `handleCaptureBloggerData`, `handleCaptureSearchData`, `runCaptureAction` | 单笔记、博主、搜索页采集按钮 | 高 |
| 监控 | `handleAddCurrentMonitor`, `handleRunMonitorNow`, `executeMonitorRunItem` | 监控订阅、立即运行、执行记录 | 高 |
| 授权/目标配置 | `handleVerify`, `handleSaveTarget`, `syncTargetConfigAfterVerify` | 激活码、飞书/同步目标配置 | 中到高 |
| 采集设置 | `initCaptureSettingsUI`, `handleSaveCaptureSettings`, `sync*Controls` | 采集偏好、评论、详情补采、客资规则 | 高 |
| 同步 | `handleSyncAll`, `repairInterruptedDetailCaptureRecordsBeforeSync`, `maybeRunAutoSyncAfterDetailCapture` | 同步全部/选中, 自动同步, 中断补偿 | 高 |
| 数据池动作 | `handleRecordListClick`, `handleRetryCommentsCapture`, `handleRetryDetailCapture`, `handleDeleteRecord` | 记录列表交互、重试、删除、下载 | 高 |
| 导出/下载 | `handleExport`, `handleDownloadRecordMedia`, `build*CsvRows` | CSV 导出和媒体下载 | 中 |
| UI 更新 | `updateUI`, `updateAuthUI`, `updateDataPoolUI`, `showMessage`, `showProgress` | 渲染状态和提示 | 中到高 |

### 6.4 与 `sidebar-ui.js` 的关系

`sidebar-ui.js` 更偏展示和交互小组件, 但两者并不是完全隔离。常见桥接:

1. `window.showMessage`
2. `window.showStatusFeedback`
3. `window.clearStatusFeedback`
4. `window.renderPlatformCaptureTabs`
5. `window.activateSidebarTab`
6. `window.getSidebarAuthState`
7. `window.getSidebarRuntimeState`
8. `window.getSidebarMonitorState`
9. `window.requestMonitorRefresh`
10. `window.requestExecutionDetailRefresh`
11. `window.requestAuthRefresh`

风险点:

1. 如果重命名这些 `window.*` 方法, 要同时改两个文件。
2. 如果把 UI 函数拆模块, 要确认全局方法仍在 sidebar 生命周期内注册。
3. `sidebar-ui.js` 中也有事件绑定, 不要以为所有事件都在 `sidebar-logic.js`。

## 7. `utils/capture-sync.js` 代码地图

这是扩展侧最敏感的文件。它连接:

```text
sidebar action
  -> capture-sync 编排
  -> chrome tab/content script
  -> utils/capture/* 平台采集
  -> utils/storage.js 入池
  -> utils/api.js 同步后端
```

### 7.1 公开导出

当前常用导出包括:

1. `captureAndSync`
2. `captureNoteWithOptionalComments`
3. `retryCommentsForRecord`
4. `retryDetailCaptureForRecord`
5. `batchCaptureDetailsForRecords`
6. `resolveSyncInputForRecord`
7. `syncRecord`
8. `syncRecordBatch`
9. `checkBeforeSync`
10. `captureAndSyncSingleNote`
11. `captureAndSyncBloggerProfile`
12. `captureAndSyncBloggerNotes`
13. `captureAndSyncKeywordNotes`
14. `captureAndSyncComments`
15. `captureOnly`
16. `resetCaptureAndSyncState`
17. `buildCommentLeadsConfigFromSettings`
18. `buildCommentLeadsPayloadForRecord`
19. `evaluateDetailKeywordFilter`
20. `repairInterruptedDetailCaptureRecords`
21. `batchCaptureByUrls`
22. `batchCaptureByKeywords`
23. `lightSampleByKeywords`
24. `captureTabContent`

不要随意改这些函数的:

1. 函数名。
2. 参数结构。
3. 返回值结构。
4. `onProgress` 回调字段。
5. 错误对象字段。

### 7.2 主要功能块

| 区域 | 代表函数 | 职责 | 风险 |
|---|---|---|---|
| 入池和去重 | `saveRecordsWithCacheDedupe`, `saveCaptureResultRecords`, `buildDataPoolIdentityIndex` | 采集结果写入 dataPool, 去重, 刷新互动数 | 高 |
| 前端同步失败记录 | `appendFrontendSyncFailureHistory`, `buildFrontendFailureItems` | 同步失败历史和错误展示 | 中 |
| 采集并同步 | `captureAndSync`, `captureAndSaveInTab` | 主采集流程, 可自动同步 | 高 |
| 单笔记和评论 | `captureNoteWithOptionalComments`, `retryCommentsForRecord` | 单笔记正文和评论合并 | 高 |
| 详情补采 | `batchCaptureDetailsForRecords`, `retryDetailCaptureForRecord` | 逐条打开详情页补正文/评论/博主指标 | 最高 |
| payload 归一化 | `normalizeDetailPayloadAgainstRecord`, `mergeHydratedDetailIntoRecordPayload`, `sanitizeMediaFieldsForStorage` | 存储前清洗和合并 | 高 |
| 同步 | `syncRecord`, `syncRecordBatch`, `runSyncRecordBatch`, `syncGroupRecordsWithRetry` | 单条/批量同步, 分包, 限流, 暂停 | 最高 |
| 评论客资 | `buildCommentLeadsConfigFromSettings`, `buildCommentLeadsPayloadForRecord` | 评论客资筛选和 payload 生成 | 中到高 |
| 详情状态字段 | `ensureDetailCaptureFields`, `createDetailCapturePatch`, `classifyDetailCaptureFailure` | 详情补采状态和失败原因 | 高 |
| Chrome tab 导航 | `openUrlInTab`, `prepareDetailBatchRunnerContext`, `restoreSourcePageIfNeeded` | runner tab 导航和恢复 | 最高 |
| 可靠计时器 | `getReliableTimerWorker`, `waitMs`, `waitMsWithStop` | 避免后台 tab timer 被 Chrome 节流 | 高 |
| 批量链接 | `batchCaptureByUrls` | URL 队列逐个导航采集 | 高 |
| 批量关键词 | `batchCaptureByKeywords`, `switchDouyinKeywordSearchInTab`, `navigateToSearchUrl` | 搜索页切词、等待结果、采集 | 最高 |
| content 调用 | `captureTabContent`, `captureInActiveTab`, `captureInTab` | 对 content script 发采集消息 | 高 |

### 7.3 不要顺手改的逻辑

这些地方看起来可能“可以优化”, 但很容易造成隐性回归:

1. `await` 顺序。
2. `waitMs`, `waitMsWithStop`, `DETAIL_*_WAIT_MS` 等等待时间。
3. Chrome tab 激活、导航、恢复原页的顺序。
4. 详情补采时的 `shouldStop` 检查。
5. 评论采集和单笔记 payload 合并顺序。
6. 同步分包大小和限流重试。
7. `detailPayload` 和 `payload.items[0]` 的互相补字段。
8. 小红书 `xsec_source` 补齐逻辑。
9. 抖音作品 ID 防串号逻辑。
10. 可靠 timer worker 的 fallback。

## 8. 数据和状态流

### 8.1 页面识别流

```text
Chrome tab changed
  -> background.js syncRuntimeForTabId
  -> utils/platform/page-routing.js 或 helpers.js 判断 platform/pageType
  -> storage runtime
  -> sidebar/state.js initRuntime/refresh
  -> sidebar/sidebar-logic.js updatePlatformUI/updatePageTypeUI
```

同时, content script 也会主动上报:

```text
content-v2.js
  -> chrome.runtime.sendMessage({ action: "pageChanged" 或 "pageStateChanged" })
  -> background.js
  -> writeRuntimeState
```

### 8.2 单笔记采集流

```text
用户点击 sidebar 按钮
  -> sidebar/sidebar-logic.js handleCaptureNoteData
  -> runCaptureAction
  -> utils/capture-sync.js captureNoteWithOptionalComments 或 captureAndSync
  -> captureTabContent/captureInTab
  -> background.js RELAY_TO_CONTENT
  -> content-v2.js
  -> utils/capture/index.js
  -> 平台具体 capture 文件
  -> capture-sync saveCaptureResultRecords
  -> utils/storage.js addRecord/addRecords/updateRecord
  -> sidebar/state.js refreshDataPool
  -> sidebar UI 刷新
```

### 8.3 列表采集加详情补采流

```text
搜索页/博主页采集列表
  -> 先入池为列表态记录
  -> 可选自动采集增强
  -> batchCaptureDetailsForRecords
  -> runner tab 逐条打开详情页
  -> captureTabContent 采正文/评论/博主指标
  -> detailPayload 回填到原 record
  -> 可选自动同步
```

风险点:

1. 列表态记录不一定有完整正文、评论、真实账号号。
2. 详情补采结果写回原记录, 不应创建重复记录。
3. 中断或取消时要把正在采集的记录标记为可重试或失败, 不能永久卡在 capturing。

### 8.4 同步流

```text
recordIds
  -> sidebar handleSyncAll 或 record action
  -> capture-sync syncRecordBatch
  -> resolveSyncInputForRecord
  -> buildPlatformSyncInput / sync-router
  -> chunkSyncRecordsForRequest
  -> utils/api.js syncBatch
  -> POST /api/sync/batch
  -> markRecordSynced 或写失败历史
```

风险点:

1. 批量同步有 payload 大小和评论富记录分包限制。
2. rate limit 和 indeterminate failure 有暂停/重试逻辑。
3. 不要把失败误标成成功。
4. 不要在同步前丢掉 `detailPayload`, 否则补采到的正文/评论/账号号可能无法入后端。

## 9. 功能风险分级

### 9.1 低风险

适合以后作为第一批小拆分试点:

1. 纯格式化函数。
2. CSV 单元格格式化。
3. 文件名清洗。
4. 只读展示文案。
5. 更新提示弹窗渲染。

注意: 低风险不等于不用测试, 只是影响链路比较短。

### 9.2 中风险

1. 导出 CSV。
2. 下载媒体。
3. 授权 UI 展示。
4. 设置面板控件同步。
5. 监控列表 UI 渲染。
6. 关键词分析卡片渲染。

这些通常不会破坏采集主链路, 但可能影响客户操作。

### 9.3 高风险

1. `initSidebar`。
2. `setupUIEventListeners`。
3. `runCaptureAction`。
4. `handleCaptureNoteData`, `handleCaptureBloggerData`, `handleCaptureSearchData`。
5. `handleSyncAll`。
6. `syncRecordBatch`。
7. `captureAndSync`。
8. `captureNoteWithOptionalComments`。
9. `batchCaptureDetailsForRecords`。
10. `batchCaptureByKeywords`。
11. `batchCaptureByUrls`。
12. `captureTabContent`。

这些地方要小步改, 每次改完立刻回归。

## 10. 如果未来真的要拆文件

### 10.1 基本原则

1. 原入口文件先保留。
2. 原公开函数继续从原路径导出。
3. 第一步只移动代码, 不改逻辑。
4. 一个 PR 或一次提交只拆一个功能块。
5. 每次拆完跑手工回归。

### 10.2 推荐先拆 `sidebar/sidebar-logic.js`

优先顺序:

1. 导出/下载相关函数。
2. 更新提示弹窗。
3. 关键词分析卡片渲染。
4. 采集设置面板。
5. 监控 UI。
6. 批量任务。
7. 主采集动作。
8. 初始化和状态订阅最后拆。

不建议第一刀碰:

1. `initSidebar`
2. `setupUIEventListeners`
3. `runCaptureAction`
4. `handleSyncAll`
5. 自动详情补采和自动同步

### 10.3 推荐后拆 `utils/capture-sync.js`

优先顺序:

1. 纯工具函数, 如文本截断、数字规范化、CSV 无关则可迁移到 util。
2. 评论客资配置构建。
3. payload 清洗函数。
4. 同步分包 helper。
5. 批量链接采集。
6. 批量关键词采集。
7. 详情补采和 tab 导航最后拆。

### 10.4 拆分后的兼容形态示例

如果把 `utils/capture-sync.js` 拆到目录, 也应保留旧路径:

```js
export {
  captureAndSync,
  captureNoteWithOptionalComments,
  syncRecordBatch,
  batchCaptureDetailsForRecords,
  batchCaptureByKeywords,
  batchCaptureByUrls,
} from "./capture-sync/index.js";
```

这样现有 import 不需要同时修改。

## 11. 改动前检查清单

任何扩展侧改动前, 先回答:

1. 这次改的是 UI、采集、同步、存储、后端接口, 还是平台 DOM 适配?
2. 是否会影响 `MESSAGE_TYPE`?
3. 是否会影响 `STORAGE_KEY` 或 record 结构?
4. 是否会改变 `payload`, `detailPayload`, `items`, `commentsCleanedItems`?
5. 是否会改变 Chrome tab 打开、激活、导航、关闭、恢复顺序?
6. 是否会改变 `onProgress` 字段?
7. 是否会改变取消逻辑?
8. 是否需要同步更新 `extension-build/`?

如果以上任一答案是“是”, 就按高风险处理。

## 12. 改动后手工回归清单

### 12.1 基础启动

1. 在 `chrome://extensions` Reload 扩展。
2. 打开 side panel。
3. 控制台无 import/export 报错。
4. sidebar 能识别当前平台和页面类型。
5. tab 切换后 sidebar 平台状态能更新。

### 12.2 授权和设置

1. 激活码显示/隐藏正常。
2. 授权状态显示正常。
3. 目标配置保存正常。
4. 采集设置勾选、输入、保存后刷新仍保留。
5. 评论加载上限、客资过滤、详情补采设置正常。

### 12.3 单笔记

1. 小红书单笔记采集。
2. 抖音视频单条采集。
3. 抖音图文单条采集。
4. 微博单条采集。
5. 可选评论采集能合并到同一 record。
6. 采集中点击取消, UI 和状态能恢复。

### 12.4 列表采集

1. 小红书搜索页关键词采集。
2. 抖音搜索页关键词采集。
3. 微博搜索页关键词采集。
4. 小红书博主页采集。
5. 抖音博主页采集。
6. 微博博主页采集。
7. 重复采集不会产生明显重复记录。
8. 已有记录的互动数能按预期刷新。

### 12.5 详情补采

1. 从列表记录触发单条详情补采。
2. 批量详情补采。
3. 详情补采包含正文。
4. 详情补采包含评论。
5. 详情补采包含博主指标或账号号时, 字段能回填。
6. 取消后记录不会永久停在 capturing。
7. 浏览器 tab 能回到合理页面。
8. 中断后重新打开 sidebar, `repairInterruptedDetailCaptureRecords` 能修复卡住状态。

### 12.6 同步

1. 单条同步。
2. 选中同步。
3. 同步全部。
4. 大 payload 或评论多的记录能分包。
5. 失败时 syncHistory 有可读错误。
6. 成功时 record 标记为已同步。
7. 失败记录重试正常。
8. 前端失败历史不会吞掉真实错误原因。

### 12.7 批量任务

1. 批量链接采集。
2. 批量博主采集。
3. 批量关键词采集。
4. 批量过程中进度显示正常。
5. 批量取消正常。
6. 批量草稿保留正常。
7. 抖音切关键词后不会采到旧词结果。

### 12.8 导出和下载

1. 当前列表导出 CSV。
2. 评论客资导出。
3. 单笔记 CSV 字段完整。
4. 博主/搜索页 CSV 字段完整。
5. 图片下载。
6. 视频下载。
7. 抖音音频下载按设置/逻辑正常。

### 12.9 监控

1. 添加当前账号/关键词监控。
2. 保存监控设置。
3. 立即运行监控。
4. 监控执行记录刷新。
5. 监控结果同步汇总正常。

## 13. 常见故障定位入口

### 13.1 sidebar 打不开或白屏

先看:

1. 浏览器扩展页面是否 Reload。
2. `sidebar/sidebar.html` script 路径。
3. 控制台 import/export 报错。
4. `sidebar/sidebar-logic.js` 顶部 import 路径。
5. `sidebar/sidebar-ui.js` 顶部 import 路径。

### 13.2 平台识别不对

先看:

1. `background.js` 的 runtime 更新。
2. `utils/platform/page-routing.js`。
3. `utils/helpers.js`。
4. `content-v2.js` 的 page state 上报。
5. `sidebar/sidebar-logic.js` 的 `updatePlatformUI` 和 `updatePageTypeUI`。

### 13.3 点击采集无反应

先看:

1. `setupUIEventListeners` 是否绑定了按钮。
2. 按钮是否被 `setCaptureButtonsDisabled` 禁用。
3. `runCaptureAction` 是否提前因为授权/页面类型拦截。
4. `chrome.runtime.sendMessage` 是否返回错误。
5. content script 是否加载成功。

### 13.4 采集有数据但列表不显示

先看:

1. `saveCaptureResultRecords`。
2. `saveRecordsWithCacheDedupe`。
3. `utils/storage.js` 的 `addRecord/addRecords`。
4. `sidebar/state.js` 的 `refreshDataPool`。
5. `sidebar/sidebar-ui.js` 的记录列表渲染。

### 13.5 同步失败

先看:

1. `resolveSyncInputForRecord`。
2. `buildPlatformSyncInput`。
3. `syncRecordBatch`。
4. `utils/api.js` 的 `sync` 或 `syncBatch`。
5. 后端 `server/routes/sync.js`。
6. 后端 `server/services/record-store.js`。
7. syncHistory 里的 `debugUrl`, `reason`, `message`。

### 13.6 详情补采卡住

先看:

1. `batchCaptureDetailsForRecords`。
2. `prepareDetailBatchRunnerContext`。
3. `openUrlInTab`。
4. `waitMsWithStop`。
5. `captureCommentsForCurrentNote`。
6. `classifyDetailCaptureFailure`。
7. `repairInterruptedDetailCaptureRecords`。

## 14. 建议保留的本地命令

统计大文件:

```bash
rg --files -0 -g '!node_modules' -g '!dist' -g '!build' -g '!coverage' -g '!vendor' | xargs -0 wc -l | sort -nr | head -40
```

查看扩展公开导出:

```bash
rg -n '^export (async )?function|^export const|^export \\{' sidebar utils
```

查看 message 通信:

```bash
rg -n 'chrome\\.runtime\\.(onMessage|sendMessage)|MESSAGE_TYPE|RELAY_TO_CONTENT' background.js content-v2.js sidebar utils
```

查看 sidebar 事件绑定:

```bash
rg -n 'addEventListener|window\\.' sidebar/sidebar-logic.js sidebar/sidebar-ui.js
```

查看采集同步入口:

```bash
rg -n '^export async function|^export function|^async function|^function' utils/capture-sync.js
```

## 15. 文档维护规则

以后如果改了扩展侧核心流程, 请同步更新本文:

1. 新增公开导出。
2. 新增 message type。
3. 新增 storage key。
4. 改变 record/payload/detailPayload 结构。
5. 改变扩展加载方式。
6. 改变手工回归清单。

这份文档的价值在于少读代码、少猜上下文、少误动敏感链路。宁可写细一点, 也不要让接手者重新从两个万行文件里推理业务边界。
