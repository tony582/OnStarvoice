# 停止保护 hotfix 合集与 Extension 0.4.17 发布记录（20260926）

分支 `codex/release-hotfixes-20260926`，基线 `2a99bb1`（生产 `9b836f6` + 文档）。生产现状：服务端为 `9b836f6`，其中 `server/services/android-control/leases.js` 已换成 `97b3765`（2026-09-25 23:40:58 上线）；Admin `index.html` 为 `8161b52f…`；`/api/update-manifest` 宣告 0.4.15（`StarVoice-extension-v0.4.15-20260924.zip`）。无数据库迁移。

## 本次上线

合并顺序（均为 `--no-ff`，全部无冲突）：

| 提交 | 来源 | 内容 |
|---|---|---|
| `3088ac7` 合并 `97b3765` + `69bbd90` | `codex/hotfix-elastic-retry-stall-20260925` | 已在生产。合并进来只是让分支与线上一致，`leases.js` 与生产逐字节相同，不重新部署 |
| `798996b` 合并 `a6e17d3` + `5c9d4ae` | `codex/hotfix-needs-action-fence-20260925` | 服务端 + Admin：「确认旧页面已停止」也能放行停在「需要处理」（`PREVIOUS_CAPTURE_STOP_UNCONFIRMED`）的批次子任务，弹性批次的关键词回任务池，固定分配批次可「重试失败关键词」；有在途停止/继续指令的行跳过，这类任务的远程「继续」返回 409。扩展：侧栏「继续」不再只报 `checkpoint_flush_not_ready`，改为给出去后台确认的说明。说明见 [20260925-needs-action-fence.md](20260925-needs-action-fence.md) |
| `8587790` 合并 `0c1f0a8` | 本地分支 `codex/hotfix-elastic-handoff-disposition-20260926` | 「停止整个任务」后，带 `terminalDisposition` 的关键词子任务按状态结清，批次不再一直停在「等待设备确认」。只有 5 种巡查任务仍要等终态回执。说明见 [20260926-elastic-handoff-disposition.md](20260926-elastic-handoff-disposition.md) |
| `d250a7b` | 摘取 `4ed2a99`（`-x`），**不含** `17351b2` | 0.4.16 的版本文件：版本号、更新清单、更新日志、运维基线。这 5 个文件在 `17351b2` 和 `0c1f0a8` 上逐字节相同，摘取无冲突 |
| `893070c` | 本分支 | 版本号改为 **0.4.17**，见下文「版本号」 |
| `da26be4` | 本分支 | 旧节点提示“升级到 0.4.16”改为“0.4.16 或更高版本”：Admin 围栏说明两处，以及 `agent_stop_fence_check_unsupported` 的 409 文案。只改文字 |

### 版本号：0.4.17，不发 0.4.16

本机所有 Chrome 配置（成都、北京、上海、重庆等）加载的主工作区 `extension-build/`，已在 2026-09-25 19:53 换成 `4ed2a99` 的扩展树，即 0.4.16 试点版，不含 `5c9d4ae`。最终版如果还叫 0.4.16，心跳里的版本号就分不出试点版和正式版，所以正式版定为 0.4.17。

- `manifest.json`、`update-manifest.js`（`latestVersion`、`releases[0]`、`releaseDate` 2026-09-26、`downloadUrl` 指向 `StarVoice-extension-v0.4.17-20260926.zip`）、`about.html`、`OPS_CONTROL_RUNTIME_BASELINE_VERSION` 都是 0.4.17，`minSupportedVersion` 仍为 0.3.51。
- 更新日志只有一条 0.4.17，内容是 0.4.16 试点的改动加上 `5c9d4ae`。没有单独的 0.4.16 条目，因为 0.4.16 从未公开发布。侧栏显示的是 (本机版本, 最新版本] 区间内的条目，0.4.15 节点和 0.4.16 试点节点看到的都是这一条。测试会锁定这一点。
- 没有逻辑依赖版本号字面值。自动核对看的是能力位 `previousCaptureStopCheckV1`，0.4.17 照常声明它。运维基线只做精确比较，只影响计数，所以发布后 0.4.16 试点节点会显示为“非基线版本”，这是预期结果。
- 试点包 `StarVoice-extension-v0.4.16-20260925.zip`（`11034af1…eca4`）缺少 `5c9d4ae`，作废，从未上传。

### Extension 0.4.17 安装包

| 项目 | 值 |
|---|---|
| 文件 | `StarVoice-extension-v0.4.17-20260926.zip`（会话 scratch：`hotfixes0926/ext/`） |
| SHA-256 | `c82fc024379e6ec6b8b72d6f18f8bfffdbbc07de0ac6293619725d3ff2f01018` |
| 大小 | 1,347,494 字节。共 115 个条目：102 个文件，13 个目录 |
| 构建 | 在本工作区对干净的 `da26be4` 执行 `TMPDIR=<scratch> zsh scripts/package-extension.zsh <输出路径>` |
| 核对 | 解包后与 `git archive da26be4` 的 7 个扩展路径（`manifest.json background.js content-loader.js content-v2.js images sidebar utils`）执行 `diff -r` 无差异。版本 0.4.17；`runtime-config.js` 为 production，指向 `https://voice.minilife.online`，无 localhost；包内无 pem、crx、zip、.env、.DS_Store |
| 与本机试点版的差异 | 与主工作区 `extension-build/`（0.4.16 试点）相比，只有 `background.js`、`manifest.json`、`sidebar/sidebar-logic.js` 3 个文件不同。前两个 js 文件的差异与 `5c9d4ae` 的 patch-id 相同 |
| 解包目录 | `hotfixes0926/ext/extension-build-0.4.17/`，由上面的 zip 解出，与 zip 逐字节一致，目录权限 755，供本机 `extension-build/` 原地替换 |

zip 里记录了文件修改时间，所以每次重新打包 SHA 都会变。以上面这一次构建为准，不要重打。如果源码再有改动，必须重新打包，并同时更新本表和发布包。

### 服务端与 Admin 替换清单

前置条件是生产现值（`9b836f6`；`leases.js` 为 `97b3765`，本次不动）：

| 文件 | 生产现值 | 新值 |
|---|---|---|
| `server/routes/capture-cloud.js` | `a799cbbc…af425` | `3be625a26ede80eb9f749901ce02a24af5cc2a8dfae870d2549f774acd69f64a` |
| `server/routes/capture-orchestrations.js` | `fffac8b9…48874` | `2ffa4f96e8b79a421cbd8f5dcc4821d2b9153ff25324dc33a0fad2095378363b` |
| `server/services/capture-stop-fence.js` | `a1324184…7a97b` | `f292651b4a9fbee55bf14130294eb9f049de7fa2dc425eda4a646362fedc8703` |
| `server/services/capture-stop-fence-release.js` | 必须不存在 | `973ddc05a0af308ccc2bf6a325175ce604ab576e484dca561bc3f0f56f3ea1ae` |
| `server/services/ops-control.js` | `a6f40d60…c7e84` | `5ae6c2cb7e1acc454f75dd0bf2915894846d63b2daee66355eb0535a6f407636` |
| `server/routes/update-manifest.js` | `d0373253…50667` | `3c915164c46313941efe3e062dce2bcac4b826ff58a57ad58b9eddc90ccef273` |
| `server/public/about.html` | `6da04cb3…fdeed6` | `ad05f1980f30a461d64bff06f14416a5ec7c22b2b644ee3d48787561d1a4951d` |
| `server/services/android-control/leases.js` | `c331fe2d…af1ed`（`97b3765`） | 不变 |
| `public-downloads/StarVoice-extension-v0.4.17-20260926.zip` | 必须不存在；0.4.15 zip 必须仍在 | `c82fc024…01018`，普通文件，权限 0644 |
| `web/admin/dist/index.html` | `8161b52f…72491` | 本地构建为 `476f8e19c5fd6240453a0cc30ae9bc8004d0bf94b252c87d283a0ddaced87750`（主脚本 `index-Cwwa3jG6.js`）。以发布包为准 |

`capture-cloud.js` 的新值与 needs-action 发布包里的 `bc6012ca…` 和 `0c1f0a8` 的 `eaa2d6a5…` 都不同，因为它同时包含 `0c1f0a8` 和 `da26be4`。那两个旧发布包已被本次取代，不再单独部署。

Admin 本地构建：`tsc -b && vite build`，Node 24.12.0。`node_modules` 取自 `OnStarvoice-release-v048-20260910`，它的 `package-lock.json` 与本分支相同（`38d615a0…`）。

| 资源 | SHA-256 |
|---|---|
| `index-Cwwa3jG6.js` | `790d5dc3…4bcb` |
| `DesktopApp-CLdJMi4f.js` | `acc4fa27…6bac` |
| `MobileApp-JFTD4r_j.js` | `ad5afb10…640f` |
| `ChinaMap-JjzoIThq.js` | `49d9f82a…f4ae` |
| `ThemeToggle-Bg7uWSek.js` | `57f2c78a…b98c` |

`ThemeToggle-KozaqHdl.css`、`index-BVaxzkpi.css`、`officialCommentPatrolPreview-7eK_DOcv.js`、`favicon.svg`、`icons.svg` 与现有资源名相同。

## 本次不上线

- **`17351b2`**（关键词节点覆盖不再无证据放行停止保护）：只有在 each_agent 节点都换上新扩展后才安全。现在上线，还在跑 0.4.15 的节点会因为没有证据而一直挡着。等 0.4.17 铺开、各节点心跳都带 `previousCaptureStopCheckV1` 后再单独发布。本分支与它无关：`git merge-base --is-ancestor 17351b2 HEAD` 为假，`keyword-node-coverage.js` 与生产相同。
- **`02e9210`**（`codex/hotfix-douyin-explicit-empty-20260911`，抖音“搜索结果为空”按确认的空结果结算）：内容已随 `5a4358c`（v0.4.10）进入生产，同样的正则和测试都在。模拟摘取到 `2a99bb1` 上，得到的树与生产完全相同。不需要合入。
- **`7dd1fc0`**（`codex/hotfix-douyin-android-discovery-20260922`，Android 发现试点 0.4.13，166 个文件）：已被 `3043c9c`（0.4.14）取代，后续又经 `7bf253b`、`a9e5cb1`、`0ade11e` 等提交演进，生产没有缺它的任何内容。强行摘取会在 46 个文件上冲突，还会把 `7bf253b` 有意删掉的 5 个 Admin 文件带回来。不合入。
- 以上两条旧分支以后可以标注为已被取代（`02e9210` 被 `5a4358c` 取代；`7dd1fc0` 被 `3043c9c`/`7bf253b` 取代），不属于本次发布。

## 已知情况（评审 `0c1f0a8`，不改代码）

`0c1f0a8` 的说明文档列了 4 处写 `terminalDisposition` 的位置，还漏了第 5 处：两条运营停止路径里的兜底，即 `capture-orchestrations.js` 约 4052 的 `terminalNoticeFallback` 和 `capture-cloud.js` 的 `cascadeStopNegativePatrolParent`。停止指令排不进去时（节点不在线、授权码过期、节点不支持远程停止、没有绑定），这两处会给任意类型的子任务写 `terminalDisposition:'canceled'`，不带 `stopPending`。

`0c1f0a8` 之后，这类**关键词**子任务按状态结清：

- 弹性批次：节点长时间不回来，租约回收（约 10 分钟）把子任务置为 `failed`，父任务随即变成 `canceled`（“整个任务已停止…”），节点没有交任何停止回执。修复前父任务会一直停在「等待设备确认」。
- 固定分配批次：不跑租约回收，行为不变。

评审在临时库上复现了这条路径。停止保护的准入不看父任务状态，所以不会因此放行被挡的节点，影响只在父任务的状态、文案和计划的上次运行状态。这也可以算修掉了同类的另一条死路。停止路由里的注释（“离线节点不能让父任务显得已停止”）和子任务文案（“等待设备确认终态通知”）对关键词子任务已不准确，留待后续文档和注释修订，本次不改代码。

## 验证

### 本地（2026-09-26，Node 18.20.8 为主）

环境：服务端依赖通过 scratch 的只读解析垫片 `register18.mjs` 加载，`@resvg/resvg-js` 用桩代替；Admin 测试用的 `typescript` 来自 eas-cli（`NODE_PATH`）；PostgreSQL 17.9 用一次性实例（`--locale=C`，只监听 127.0.0.1）。

| 检查 | 结果 |
|---|---|
| `node --check`（Node 18） | 7 个改动的服务端文件按模块通过；`background.js` 按经典脚本通过；`sidebar/sidebar-logic.js` 按模块通过 |
| 改动相关的单元测试（16 个文件：capture-stop-fence、server-capture-cloud-contract、admin-stop-fence-{confirm-contract,panel,presentation}、cloud-task-center-wiring、background-capture-lock、background-stop-confirmation、unattended-keyword-run、capture-recovery-intents、server-capture-orchestration-route、update-manifest、ops-control、ops-control-wakeup、android-mobile-tasks、android-recovery） | 724/724 |
| `update-manifest` + `ops-control`，Node 18 与 Node 24.12.0 | 31/31 |
| 完整回归 `scripts/run-node-regression-tests.mjs`，Node 18 | 共 2769 项，2752 通过，17 失败。17 项全部是已知的环境失败（垫片与桩导致）：5 个整文件失败（`admin-navigation-public-filters`、`android-control-route`、`capture-discovery-route`、`customer-assistant-boundary`、`public-downloads`）、7 个报表 PNG/Excel 测试、4 个进程角色测试、1 条汇总。与 09-25 发布前的名单相同；`douyin-blogger-profile-scope` 这次有 `extension-build/`，已通过 |
| PostgreSQL 目标套件：stop-fence-closure、historical-stop-fence、orchestration-retry-waiting、android-unified-scheduling、keyword-account-coverage、manual-keyword-dispatch | 88/88。stop-fence-closure 32/32（含 `0c1f0a8` 新增的 2 个）；historical 21/21；android-unified-scheduling 8/8（含 `97b3765` 的“剩余词不被卡住”） |
| PostgreSQL 集成全套（46 个文件，`--test-concurrency=1`） | 共 331 项，314 通过，17 失败。失败名单与 needs-action 验收时的环境失败名单逐项相同，原因是子进程或 CJS 找不到 `pg`、`dotenv`、`express`、`exceljs` |
| Admin `tsc -b && vite build` | 通过，index 为 `476f8e19…` |
| 安装包 | 见上文「Extension 0.4.17 安装包」 |

### 集成验收：与基线 `2a99bb1` 逐项对照（2026-09-26）

两边都用 `git archive` 出的干净副本（scratch `hotfixes0926/int/base` 与 `int/cand`），`server/node_modules`、`web/admin/node_modules` 链到主工作区，用同一个解析垫片和同一个一次性 PostgreSQL 17.9（`--locale=C`，只监听 127.0.0.1:55741，已停）。

| 套件 | 基线 `2a99bb1` | 本分支 `bc4622c` | 失败名单 |
|---|---|---|---|
| 完整回归，Node 24.12.0 | 2738 项，2720 通过，18 失败 | 2765 项，2747 通过，18 失败 | 17 个名字，与右列逐字相同 |
| 完整回归，Node 18.20.8 | 2738 项，2720 通过，18 失败 | 2765 项，2747 通过，18 失败 | 同上；四次运行名单完全一致 |
| PostgreSQL 集成全套（46 个文件，Node 18.20.8，`--test-concurrency=1`） | 318 项，301 通过，17 失败 | 331 项，314 通过，17 失败 | 17 个名字逐字相同 |

- 失败全部是环境原因，两边一样：副本没有根目录 `node_modules`，子进程或 CJS 找不到 `dotenv`、`express`、`exceljs`、`pg`、`react/jsx-runtime`；副本里也没有 `extension-build/`，所以 `douyin-blogger-profile-scope` 整文件失败（在工作区里跑时通过，见上表）。回归报告的“18 失败”含 1 条汇总，名单是 17 个。名单与 09-26 needs-action 验收时的候选名单相同。
- 新增的测试都通过：回归多出 27 项；PostgreSQL 多出 13 项，其中 stop-fence-closure 20 → 32，android-unified-scheduling 7 → 8，其余每个文件的通过数与基线相同。

Admin 构建（Node 24.12.0，vite 8.0.16，`node_modules` 从 `OnStarvoice-release-v048-20260910` 只读复制，`package-lock.json` 两边都是 `38d615a0…`）：

| 构建 | `index.html` | 结论 |
|---|---|---|
| 对照：`2a99bb1` | `8161b52f…72491` | 与生产现值相同，资源名 `index-BUinIx_i.js` 等与生产一致 |
| 本分支 `bc4622c`，第 1 次 | `476f8e19c5fd6240453a0cc30ae9bc8004d0bf94b252c87d283a0ddaced87750` | |
| 本分支 `bc4622c`，第 2 次（另一份干净副本） | 同上 | 11 个文件逐字节相同 |

安装包复核：zip `c82fc024…` 解开后与 `git archive bc4622c` 的 7 个扩展路径、与 `ext/extension-build-0.4.17/` 都 `diff -r` 无差异；主工作区 `extension-build/` 仍与 `4ed2a99` 完全一致（0.4.16 试点，未动）。

### CI

[run 36212258163](https://github.com/tony582/OnStarvoice/actions/runs/36212258163)，head `bc4622c`，5/5 通过：Tests and builds、Production Node 18 compatibility、PostgreSQL 14 / Node 24.12.0、PostgreSQL 16 / Node 18.20.8、PostgreSQL 16 / Node 24.12.0。之后只有本条文档提交，不改 `server/`、`web/admin/` 和扩展文件，所以 CI 结论和下面的发布包仍然有效。

### 发布包

目录：会话 scratch 的 `hotfixes0926/stage/release-hotfixes-bc4622c-20260926/`，从 `bc4622c` 生成（生成脚本 `hotfixes0926/stage/build-stage.sh`）。生产位置：`/opt/onstarvoice-private/releases/release-hotfixes-bc4622c-20260926`。

| 文件 | SHA-256 | 内容 |
|---|---|---|
| `server.tar.gz` | `a86de4da67aa22e92d053a966627a262355a09734bb41cc89c049ea5d7349f77` | 上表 7 个服务端文件 + `public-downloads/StarVoice-extension-v0.4.17-20260926.zip`（ustar，属主 root） |
| `admin-dist.tar.gz` | `a9b7355c37cf2f9c935be392bdaeaf684ce4c45f42f0d657eb6f7333bd1772a8` | `dist/` 11 个文件，哈希见 `admin-files.sha256` |
| `deploy.sh` | `60e84eeedd7af136181da61ad448426a4c90f17442057b6dec0ca7e417af1d52` | 见下 |
| `release-manifest.json` | `eb7ca47ac028427704f5e9c190fa50d5ac854ae12fc44c284124e0c289c263fa` | 前置条件、新值、验证记录 |
| `local.sha256` | — | 以上 4 个文件的哈希，上传后用它核对 |

另附 `src/`、`admin-src/`（包内文件的明文副本）和 `admin-source.sha256`（构建所用 `web/admin` 源码，158 个文件）。needs-action 旧发布包 `needs-action-fence-a6e17d3-20260925` 作废，不要部署。

`deploy.sh` 要点：

- `--check` 只读：两个包的哈希；6 个待替换文件和 Admin index 为 `9b836f6` 现值，`leases.js` 为 `97b3765`（`c331fe2d…`）；`capture-stop-fence-release.js` 不存在（包括悬空链接）；`public-downloads/` 是真实目录，有 0.4.15 zip，没有 0.4.17 zip 及其 `.tmp`；PM2 在线；`/api/health/ready` 通过；`/api/update-manifest` 顶层和 `data.updateManifest` 都是 0.4.15、指向 0.4.15 zip、`minSupportedVersion` 0.3.51。
- 部署：加发布锁；同一目录只能跑一次（`backup/` 或 `candidate/` 已存在即拒绝）；解包后核对包内恰好 19 个文件及各自哈希、zip 大小，Node `--check` 6 个 js；备份。然后先装 zip（tmp+mv），再加 Admin 资源，再切 index、先放新模块、再逐个 tmp+mv 替换 6 个文件，`pm2 restart onstarvoice`。
- 部署后检查（任何一项失败都自动回滚）：30 秒内 ready；live；进程确实重启且解释器版本不变；磁盘文件与包逐字节相同；`/api/update-manifest` 两处都是 0.4.17、指向新 zip、`minSupportedVersion` 仍为 0.3.51（重启后的进程能返回它，说明包括 `capture-cloud.js` 和新模块在内的整套路由都已加载）；`/downloads/<0.4.17 zip>` 逐字节一致，0.4.15 zip 仍可下载，`public-downloads/` 只多了这一个 zip；`/changelog` 有“扩展 v0.4.17”；`/admin/` 为 `476f8e19…`，8 个资源逐字节可取。成功后再取一次公网 `https://voice.minilife.online/downloads/<zip>` 比对 SHA，只提示，不回滚。
- 自动回滚：切换后任何失败或 INT/TERM/HUP，都恢复 6 个文件（仍是旧内容的不动）、删除新模块、恢复 index、重启并等 ready；确认旧代码已就绪后再删掉 0.4.17 zip。回滚期间忽略后续信号。新 Admin 资源保留但不被引用。切换前失败（例如资源冲突）只删掉已装的 zip。

模拟（scratch `hotfixes0926/deploysim/`）：按生产现状搭建的 `/opt/onstarvoice`（服务端 `9b836f6` + `leases.js` `97b3765`；Admin 为 `68c32ba` 与 `9b836f6` 两次构建，index `8161b52f`；`public-downloads/` 有 0.4.15 zip），真实应用在 Node 18.20.8 下由 pm2 替身启动，公网地址一律拦截。

| 场景 | 结果 |
|---|---|
| 原样 `--check` | 通过，目录树不变 |
| 漂移拒绝（14 种）：`about.html`、`capture-cloud.js`、`update-manifest.js` 文件、仅运行中的 update-manifest 不同、`leases.js` 仍是 `9b836f6`、旧 needs-action 发布包已上线、新模块为悬空链接、0.4.17 zip 已存在、残留 zip `.tmp`、0.4.15 zip 缺失、`public-downloads` 为链接、Admin index 为 `68c32ba`、`server.tar.gz` 被篡改、PM2 停止 | `--check` 和部署都退出 1，目录树不变，发布目录未被使用，未重启 |
| 发布锁被占用；参数写错（`--deploy`） | 拒绝，目录树不变 |
| 正常部署 | 退出 0，全部检查通过，重启 1 次；文件、index、update-manifest 0.4.17、zip `c82fc024…`、changelog 均符合；树的变化恰好是 6 个替换文件、新模块、新 zip、index 和 5 个新资源 |
| 再跑一次 | 拒绝，目录树不变；`--check` 如实报告已不是 `9b836f6` |
| 按文档手工回滚 | 服务恢复 0.4.15，`--check` 重新通过；与原样相比只多 5 个新资源 |
| 自动回滚：ready 失败、资源取回不符、zip 取回不符、SIGTERM、SIGHUP、两次 SIGTERM（第二次落在回滚的重启上）、`routes/` 只读 | 都回到 `9b836f6` 文件和 index，zip 已删，服务 ready，`--check` 重新通过，再部署被拒绝；与原样相比只多 5 个新资源 |
| 切换前资源冲突 | 代码和 index 未动，已装的 zip 被删除 |

### 本机 `extension-build/` 同步脚本

`hotfixes0926/stage/sync-extension-build.sh`（SHA-256 `96ba5cc3f965409fe20c1e2ca905bd0b1758816e370b97e5e114ccc1f1a9788a`，只在本机运行，不上传），尚未执行：

- `--check` 只读：zip SHA 为 `c82fc024…`；`ext/extension-build-0.4.17/` 与脚本内嵌的 102 个文件哈希完全一致，且与 zip 解包 `diff -r` 相同；`extension-build/` 与内嵌的 `4ed2a99` 试点清单完全一致（多一个 `.DS_Store` 也算不一致）；备份目录不存在。
- 执行：先 `cp -Rp` 备份到 `extension-build.rollback-v0416pilot-before-bc4622c` 并逐文件核对，再原地替换（只写内容变了的文件，每个 tmp+mv，删多余文件，目录权限 755），最后逐文件核对为 0.4.17、与解包目录 `diff -r` 相同、与备份相比恰好只有 `background.js`、`manifest.json`、`sidebar/sidebar-logic.js` 不同。替换中途失败或被中断，自动从备份恢复并逐文件核对。备份已存在就拒绝。
- `--rollback`：备份必须仍是试点版，原地恢复并逐文件核对，备份保留。

模拟（对真实 `extension-build/` 的副本，scratch `hotfixes0926/syncsim/`）：`--check` 通过且不改动；正常同步后与解包目录一致、备份与试点一致；再跑和 `--check` 都拒绝；`--rollback` 后与试点一致；目标有 `.DS_Store`、目标文件被改、备份已存在、来源被篡改、没有备份时回滚，都拒绝且不改动；替换到 `sidebar/` 时失败，自动恢复为试点版。

### 部署后

2026-09-26（Asia/Shanghai），发布目录 `/opt/onstarvoice-private/releases/release-hotfixes-bc4622c-20260926/`：

- 上传后 `sha256sum --check local.sha256` 通过；`deploy.sh --check`：生产与 `9b836f6` + `leases.js`（`97b3765`）一致，`capture-stop-fence-release.js` 不存在，更新清单为 0.4.15，0.4.17 安装包尚未发布。
- 11:37:23 切换并重启 PM2 `onstarvoice`，新 PID 462857（Node 18.20.8），`health/ready` 通过；脚本内置后检全部通过，公网下载 `StarVoice-extension-v0.4.17-20260926.zip` 的 sha256 为 `c82fc024…`，与发布包一致。
- 公网复核：`/api/update-manifest` 为 0.4.17（发布日期 2026-09-26），`/admin/`、`/changelog`（含 v0.4.17）、`/api/health/ready` 均为 200。
- 本机 `extension-build/` 已由 0.4.16 试点版同步为 0.4.17（102 个文件逐个核对），备份在 `extension-build.rollback-v0416pilot-before-bc4622c`；各 Chrome 配置需逐个重载扩展后生效。
- 部署后的错误日志与节点心跳未能由本次执行人复核（生产日志/数据库只读查询被本地权限拦截），需补看：错误日志自 11:37 起是否有新增、在线节点心跳是否在 2 分钟内恢复。

## 上线顺序

1. **服务端 + Admin + 安装包，一次完成**（运维执行；agent 没有 ssh 权限）：

   ```bash
   # 本机：上传整个发布目录（目标目录必须还不存在）
   scp -r <scratch>/hotfixes0926/stage/release-hotfixes-bc4622c-20260926 <生产主机>:/opt/onstarvoice-private/releases/
   # 生产主机
   cd /opt/onstarvoice-private/releases/release-hotfixes-bc4622c-20260926
   sha256sum --check local.sha256
   bash deploy.sh --check    # 应输出 preconditions OK: production matches 9b836f6 + leases.js 97b3765, ...
   bash deploy.sh            # 成功时最后打印 runtime.json、ready 结果和公网下载核对
   ```

   `--check` 不通过就先查明原因，不要硬上；它会打印生产上的实际哈希和 update-manifest。部署失败会自动回滚并说明结果；同一目录不能再跑，重试要重新上传一份干净的发布目录。
2. **本机 `extension-build/` 原地替换**：必须在第 1 步成功之后，因为侧栏说明指向的后台按钮是第 1 步才上线的。扩展清单没有 `key`，扩展 ID 由目录决定，所以只能原地替换，不能换目录。

   ```bash
   bash <scratch>/hotfixes0926/stage/sync-extension-build.sh --check
   bash <scratch>/hotfixes0926/stage/sync-extension-build.sh
   ```
3. **逐个节点重载**：在节点空闲或已停止时，在 `chrome://extensions` 里重载扩展，然后重启 Chrome。一次一个节点，成都等多窗口机器放在最后。每个节点都到后台核对 `app_version` 为 0.4.17 并带 `previousCaptureStopCheckV1` 能力位。Windows 节点从下载地址取包，在各自原目录内原地替换。
4. 0.4.17 铺开、没有节点还在 0.4.15 或更早版本之后，再评估单独发布 `17351b2`。

## 回滚

- **服务端与 Admin**：部署中失败时 `deploy.sh` 已自动回滚。部署成功后要手工回滚：

  ```bash
  cd /opt/onstarvoice-private/releases/release-hotfixes-bc4622c-20260926
  for f in server/public/about.html server/routes/capture-cloud.js server/routes/capture-orchestrations.js server/routes/update-manifest.js server/services/capture-stop-fence.js server/services/ops-control.js; do cp -p backup/$f /opt/onstarvoice/$f; done
  rm -f /opt/onstarvoice/server/services/capture-stop-fence-release.js
  cp -p backup/admin/index.html /opt/onstarvoice/web/admin/dist/index.html
  pm2 restart onstarvoice && curl -fsS http://127.0.0.1:3002/api/health/ready
  rm -f /opt/onstarvoice/public-downloads/StarVoice-extension-v0.4.17-20260926.zip
  bash deploy.sh --check    # 重新输出 preconditions OK 即已回到 9b836f6（模拟验证过）
  ```

  `update-manifest.js` 回到 0.4.15 后更新提示不再指向 0.4.17，所以最后再删 zip。
- **已放行的记录不回退**：它们的格式与历史对账相同，并且有事件和审计记录。
- **只想停掉自动核对**：设置 `CAPTURE_STOP_FENCE_AUTO_CHECK=off` 后重启服务。
- **本机扩展**：`bash <scratch>/hotfixes0926/stage/sync-extension-build.sh --rollback`，然后逐个节点重载扩展。要回到 0.4.15，就用 0.4.15 zip（`d7422afc9aab6c6e27971a19d7e89537b87cd2420c19875913e3660182fe50af`）解包后同样原地替换。
