# 手机节点并入普通调度 + 一键启动（20260924，总记录）

分支 `codex/feat-android-unified-scheduling-20260924`，基线 `a9e5cb1`（Runner 0.2.1 openCard hotfix）。契约见 [实施契约](20260924-android-unified-scheduling-design.md)，三条工作线各自的改动清单与测试见 [服务端](20260924-android-unified-scheduling-server.md)、[后台](20260924-android-unified-scheduling-admin.md)、[Runner](20260924-android-unified-scheduling-runner.md)。未推送、未部署、未触碰生产手机与生产任务。

## 交付了什么

- **手机是普通抖音节点**：调度中心节点栏、选节点、无人值守计划/一次性任务编辑器、任务详情、历史里都直接出现手机（带“手机”标识和就绪文案：可执行搜索 / 抖音未在前台 / 需解锁 / 手机息屏 / 未连接 / 执行器未就绪）。旧“手机发现”弹窗、`CreateMobileRun`（1–2 词、每词 20 条）已删除。
- **同一套调度**：无人值守计划到点生成的关键词工作项，手机按弹性节点池逐词领取，或按固定分配领取属于自己的那一组；关键词上限沿用 1–300；每词数量跟计划“帖子上限”（不填=翻到结果到底），另有“手机每词最长时间”（默认 15 分钟，1–120）作为唯一时间兜底；排序/发布时间/内容形式直接取计划的搜索条件。停止计划会一并停止手机子任务；手机完成后父任务进度与浏览器子任务一样聚合；失败项按弹性池语义可再领取。
- **手机发现 → 浏览器补详情**：链路不变；任务详情里每个手机子任务显示“手机发现 N · 待补详情 N · 已入库 N · 失败 N”，可展开候选并重处理，停稳/恢复状态复用原面板。
- **一键启动**：`node runners/android/cli.mjs up --state-dir <目录>`，或双击 `runners/android/launcher/StarVoice 手机采集.command`：自动 `adb start-server`、按 `connection.json.appiumLaunch` 拉起 Appium 并等就绪、首次运行提示输入激活码完成注册（激活码只读一次、不落盘）、运行 Runner 并用人话显示状态；关窗口/Ctrl-C 依次停 Runner、停 Appium 并打印停稳结果。不做常驻服务。

## 执行模型要点

- 手机 run = 编排的**子任务**（`metadata.workflow='douyin_mobile_discovery'`，`parent_task_id` 指向编排），run id = `execution_task_id`；旧独立 run（`execution_task_id=task_id`）不受影响。
- 领取在手机 `poll` 里完成：先领已分配给本机的项，再按浏览器弹性领取的同一套规则（执行槽锁、`attempt_count<3`、安全码栅栏、eligible/pinned）领取弹性池项，建 1 词子任务，不建 create 命令；同机再领 `retryable` 项自动 `resumeAuthorized`。
- 硬隔离保留：手机不领浏览器专属任务（补详情、巡查、手动采集），浏览器不领手机 run；关键词工作项两者都可执行。
- 父任务投影 `refreshOrchestrationParentTask` 仍在路由层；服务通过 `services/android-control/parent-refresh.js` 的注册器调用（路由加载时注册），不违反“服务不得引用路由”的边界规则。

## 验证（Node 24.12.0，Node 18.20.8 为生产服务端版本）

| 项目 | 结果 |
| --- | --- |
| 服务端单元（android、discovery、orchestration、cloud 契约共 12 文件） | Node 24：196/196；Node 18：196/196 |
| 隔离 PostgreSQL 集成（android×3、discovery×2、编排/停止/负面巡查等共 16 文件，串行） | 180/180（含新增 `android-unified-scheduling`、`android-manual-dispatch-mobile`） |
| 服务端全量 PG 集成（服务端工作线执行） | 355/355 |
| Runner 全套（串行） | 162/162（新增 19 项） |
| 模块边界 | 85 个模块通过，最大 288 行 |
| Admin `tsc -b && vite build` | 通过；lint 基线 281 ≤ 288，0 警告 |

## 尚存风险（合并三线）

- 手机侧 `up`/Appium 拉起、筛选新组合（最多点赞/评论/收藏、半年内、图文/视频）、前台/锁屏解析、`MainActivity` 组件均**未接真机验证**；读回逐组核对失败会停稳而不是误采。
- 手机长时间离线时，已占用设备的手机子任务在父任务停止后停在 `waiting_device`，需手机回来 poll/complete 或运营 `close` 兜底（与浏览器占用子任务同语义）。
- 一次性固定分配仍沿用“单节点最多 30 词”的浏览器约束；大批词请用弹性池。
- 手机 complete 与浏览器 dispatch 锁序相反，靠 `SKIP LOCKED` 与 1 s 锁超时（映射 503 重试）规避，未做高并发压测。
- `appiumLaunch` 由 `run-appium.sh` 静态解析得到；该脚本或 node 版本变更后需重跑 `setup --appium-launch-file`。Windows `.cmd` 与真实终端的激活码回显抑制未实测。
- `daemon-integration` 存在既有 60 ms 截止窗口时序 flake（并行负载下偶发），串行/单文件复跑通过。

## 上线顺序建议

1. 服务端与 Admin 按白名单增量发布（无新增迁移），`ANDROID_DISCOVERY_INGEST_TENANTS` 保持现值。
2. 手机电脑替换 Runner 目录为本分支 `runners/android`，用现有 `state-829d89` 状态目录先 `node cli.mjs setup ... --appium-launch-file ~/.local/share/starvoice/android-toolchain/run-appium.sh`（写入 `appiumLaunch`，不改凭据），停掉手工起的 Appium/Runner 后改用 `up`。
3. 在调度中心用一次性关键词任务、单选手机、1 个词做首个真机验证；通过后再把手机加入现有无人值守计划的节点池。
