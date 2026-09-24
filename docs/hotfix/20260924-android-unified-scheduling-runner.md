# 手机节点并入普通调度：Runner 交付（20260924）

分支 `codex/feat-android-unified-scheduling-20260924`，只改 `runners/android/**`（未碰 `server/**`、`web/admin/**`、生产 Runner、真机、端口 4723）。本文对应契约 [20260924-android-unified-scheduling-design.md](20260924-android-unified-scheduling-design.md) §4。保留既有担保：单动作 60s、租约 90s、闭环日志、deviceSettled、resumeAuthorized、单击一次、安全返回跳过。

## 改动文件

代码：
- `runners/android/src/core/budget.mjs` — 预算 0=不限。
- `runners/android/src/device/douyin-profile.mjs` — `filtersMatch` 逐组核对（含内容形式）。
- `runners/android/src/calibration/douyin-flow.mjs` — 放开 `search()`/`adoptCurrentSearch()` 白名单、选择内容形式、读回按请求逐组核对。
- `runners/android/src/device/profile-adapter.mjs` — 新增 `mapSearchFilters()`：公有筛选→校准中文标签，`search()` 在触碰界面前拒绝不支持的值。
- `runners/android/src/device/adb.mjs` — 新增 `startServer()`（`adb start-server`，只读、不选设备）。
- `runners/android/src/daemon/runtime.mjs` — poll 请求体新增 `reason` 与有界 `probe`（`pollProbe()`）。
- `runners/android/src/daemon/appium-launch.mjs` —（新）解析 `run-appium.sh` 为 `{node, entry, args, env}`；从文件或本机默认路径 `~/.local/share/starvoice/android-toolchain/run-appium.sh` 推导，绝不执行 .sh。
- `runners/android/src/daemon/appium-process.mjs` —（新）`ensureAppium()`（/status 不通时直接 spawn node，不经 shell，60s 内轮询就绪）、`stopAppium()`（SIGTERM→10s 后 SIGKILL）。
- `runners/android/src/daemon/setup.mjs` — 新增 `appiumLaunchFile`/`appiumLaunch` 参数，装有 profile 时把 `appiumLaunch` 写入 `connection.json`。
- `runners/android/src/cli/up-command.mjs` —（新）`runUp()` 一键编排 + `describeReadiness()` 人话状态。
- `runners/android/src/cli/arguments.mjs` — 新增 `up` 命令、`--appium-launch-file` 选项、`up` 要求 `--state-dir`、HELP。
- `runners/android/src/cli/index.mjs` — 路由 `up`。

启动器与文档：
- `runners/android/launcher/StarVoice 手机采集.command`（macOS 双击，已 `chmod +x`）。
- `runners/android/launcher/StarVoice 手机采集.cmd`（Windows）。
- `runners/android/README.md`、`runners/android/src/core/README.md` — 一键启动首次用法、筛选/预算说明。

测试（新增/追加）：
- `runners/android/test/appium-launch.test.mjs`（3）
- `runners/android/test/search-filters.test.mjs`（5）
- `runners/android/test/up-command.test.mjs`（7）
- `runners/android/test/core-budget.test.mjs`（+3）
- `runners/android/test/daemon-readiness.test.mjs`（+1）

## 行为

### 1. 预算 0=不限
`maxLinks/maxCards/maxSwipes/batchMs` 允许 `0`（safe integer ≥0）表示不限，`BudgetLedger` 的 `assertAllowed/beforeCard/beforeSwipe` 对该维度跳过上限校验；`keywordMs/maxPending` 仍必须 >0。`summary()`/统计不变。`limitsHash` 计算未变，故所有正数上限的旧 checkpoint 仍能加载；服务端下发可缺省键（走 DEFAULTS）。运行循环无需改动——0 预算下会一直翻到「结果到底」（`results_end`）或「无新卡片」（`no_new_cards`）或 keyword/batch 时间/deadline 结束。

### 2. 筛选
- `mapSearchFilters()`：`sort` comprehensive/latest/likes/comments/collects→综合排序/最新发布/最多点赞/最多评论/最多收藏；`publishTime` all/day/week/halfyear→不限/一天内/一周内/半年内；`contentType` all/image/video→不限/图文/视频。旧 `{sort, range:'day'}` 兼容（time=一天内、content=不限）。任何不支持的取值（含 `publishTime='month'`）在 `flow.search` 前抛 `unsupported_search_filters`。
- `flow.search()`/`adoptCurrentSearch()` 白名单放开到 `FILTER_OPTIONS` 的排序（5）/发布时间（4）/内容形式（3）；筛选选择循环把「内容形式」设为请求值。
- 读回校验 `filtersMatch()` 逐组核对排序、发布时间、内容形式，其余组（视频时长、搜索范围、位置距离）仍须为「不限」。`returnToResults`/`recoverResults` 经 `verifyFilters()` 用同一请求集合（flow 级 `context.filters` 含 content）重新核对。

### 3. 节点信息（poll 请求体）
`poll` body 追加 `reason`（= `deviceReason`，无则 null）与有界 `probe`（`{foreground:{package,activity,launched}, checkedAt}`，字符串截断 120，无探测则 null）。daemon status 其余不变。

### 4. 一键启动
`node cli.mjs up --state-dir DIR`：① `adb start-server`；② profile 节点且 Appium `/status` 不通时，按 `connection.json.appiumLaunch`（setup 时从 `--appium-launch-file` 或本机 `run-appium.sh` 解析，config 缺失时 `up` 用 `--appium-launch-file`/默认路径兜底）**直接 spawn node**（execFile 风格、`shell:false`、env 注入 JAVA_HOME/ANDROID_HOME/APPIUM_HOME、bare `node`→`process.execPath`），60s 内轮询 `/status` 就绪；③ 无 `connection.json` 时交互式提示调度中心地址（默认取 `--cloud-url`/`STARVOICE_CLOUD_URL`）与激活码（回显屏蔽、只读一次、不落盘不打日志），未给 `--serial` 时仅当 adb 恰好一台在线设备才自动选；否则列出设备并退出；④ 前台跑 daemon，探测状态变化打印一行人话（「手机已连接 · 抖音在前台 · 已上线，可在调度中心下发任务」/按 `deviceReason` 映射的「…等待…」）；⑤ SIGINT/SIGTERM/SIGHUP → 受控停止 → 等 daemon → 结束 Appium 子进程（SIGTERM，10s 后 SIGKILL）→ 打印 `deviceClosureRequired` true/false。不安装常驻服务。
- 启动器 `launcher/StarVoice 手机采集.command`（设 PATH、切 Runner 目录、跑 `up`，状态目录可由同级 `launcher.json` 的 `stateDir` 覆盖）与 Windows `.cmd` 等价。

## 测试命令与结果（Node 24.12.0）

- 目标用例串行：`node --test --test-concurrency=1 test/appium-launch.test.mjs test/search-filters.test.mjs test/core-budget.test.mjs test/daemon-readiness.test.mjs test/up-command.test.mjs` → **29/29 通过**。
  - 覆盖：预算 0=不限（账本 + 运行循环走完 41 张卡片越过默认 40/20 上限至 `results_end`）、keywordMs/maxPending 仍须 >0；筛选映射与旧 range 兼容、非法值拒绝、逐组读回（含内容形式）核对、未校准取值触碰界面前拒绝；poll body 带 reason + 有界 probe；`up` 编排（假 adb/Appium：`ensureAppium` spawn 无 shell + 注入 env + bare node 解析到 `process.execPath`、已就绪不 spawn、`stopAppium` SIGTERM→SIGKILL、停机后结束子进程、首次注册注入 stdin 且激活码不打印、多设备时列出并拒绝自动选）。均不接触真机/端口 4723/生产 adb。
- 除 daemon-integration 外全量串行：`node --test --test-concurrency=1 <其余 24 个 test/*.test.mjs>` → **150/150 通过**（含既有 + 本轮新增）。
- `daemon-integration.test.mjs` 单文件串行：多次复跑中出现 12/12 全绿（隔离 2 连绿）；重载下 `real device without calibrated profile…`、`expired upload window…` 两条会 1–2 条时序失败。**该 flake 与本轮改动无关**：把 poll body 改动临时还原后单跑同文件仍在重载下失败（6 次中 2 次），与发布单记录的 60ms 截止窗口时序敏感一致；这两条与 daemon status/poll 路径无关，且本机模拟设备无 `probe`、`pollProbe()` 直接返回 null，对该路径零开销。
- 边界检查：`node scripts/check-android-discovery-boundaries.mjs` 仅报 `server/services/android-control/leases.js: service imports HTTP route`——那是服务端工作线按契约 §2.5 导出 `refreshOrchestrationParentTask` 的在途改动，**不属于 Runner**；Runner 侧无任何越界，新增模块最大 118 行（`up-command.mjs`），改后 `runtime.mjs` 288 行，均 <350。
- `node --check`：全部改动/新增 `.mjs`（源码 + 测试）通过；`bash -n` 通过 macOS 启动器脚本。
- 实机 `run-appium.sh` 兼容性核对（只读本机 `~/.local/share/starvoice/android-toolchain/run-appium.sh`）：解析出 `node=/Users/…/v24.12.0/bin/node`、`entry=…/appium/build/lib/main.js`、`args=[--address,127.0.0.1,--port,4723,--log-level,warn]`、三项 env 正确；shell 透传 `"$@"` 已被剔除，不会当成字面参数传给 Appium。

## 尚存风险

- **未接真机跑通 `up`**：全部 `up`/Appium 编排用假 adb/Appium 单测；生产手机、Appium 与端口 4723 遵指令未触碰。`ensureAppium` 的 60s 就绪窗口、Appium 子进程实际拉起与退出、SIGKILL 兜底均未在真机验证。
- **Appium 拉起环境**：`appiumLaunch` 从 `run-appium.sh` 静态解析（已核对本机当前文件）；若日后该脚本改用 shell 变量拼接入口、换 node 版本或改结构，需重跑一次 `setup`/`--appium-launch-file` 重新落 `appiumLaunch`。bare `node` 回落到 `process.execPath`；若脚本用相对路径 node 需改脚本给绝对路径。
- **Windows TTY 提示**：首次注册的激活码用 readline + 输出屏蔽实现回显抑制，仅在真 TTY 生效；Windows `.cmd` 双击窗口未实测，非 TTY 管道输入下不屏蔽（测试用注入 stdin 覆盖，未测真实终端）。
- **筛选组合未真机验证**：放开的 sort/publishTime/contentType 取值来自 `FILTER_OPTIONS`（实机 40.6.0 面板读得），但「最多点赞/评论/收藏 + 半年内 + 图文/视频」等组合未在真机跑过；读回逐组核对会在选择失败时报错停稳，不会误采。
- **daemon-integration 时序 flake**：非本轮引入（已 A/B 验证），重载环境下偶发；建议单文件、机器空闲时复跑确认 12/12。
- 服务端 `leases.js` 越界告警需服务端工作线完成 §2.5 的导出/搬迁后边界检查才整体转绿。
