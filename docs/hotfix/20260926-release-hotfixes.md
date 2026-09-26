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

### CI

待补：推送后 GitHub Actions 的结果（run 号、各项结论）。

### 部署后

待补。

## 上线顺序

1. **服务端 + Admin + 安装包，一次完成**（人工或运维执行，agent 没有 ssh 权限）。以 `68c32ba` 发布 0.4.15 的脚本和 needs-action 发布包为模板，重新生成发布包：
   - 前置条件：上表文件为生产现值；`capture-stop-fence-release.js` 不存在；`public-downloads/` 是真实目录，不是符号链接，里面没有 0.4.17 zip，但有 0.4.15 zip；PM2 在线；`/api/health/ready` 通过；`/api/update-manifest` 为 0.4.15。
   - 执行顺序：先装 zip（`install -m 0644 … .<zip>.tmp && mv`），再加 Admin 资源，再切换 `index.html`，然后先放新模块、再用 tmp+mv 替换服务端文件，最后 `pm2 restart onstarvoice`。
   - 部署后检查：
     - 文件哈希与上表一致。
     - `/api/update-manifest` 顶层和 `data.updateManifest` 的 `latestVersion` 都是 0.4.17，`downloadUrl` 以 `/downloads/StarVoice-extension-v0.4.17-20260926.zip` 结尾。
     - 从 `127.0.0.1:3002/downloads/<zip>` 和公网 nginx 取回的 zip，SHA 都是 `c82fc024…`，解出的 `manifest.json` 版本为 0.4.17。
     - `/changelog` 包含“扩展 v0.4.17”。
     - 0.4.15 zip 仍在。
     - `/admin/` 和新资源逐字节可取。
   - 发布目录：`/opt/onstarvoice-private/releases/release-hotfixes-<短 sha>-20260926`。
2. **本机 `extension-build/` 原地替换**：必须在第 1 步之后，因为侧栏说明指向的后台按钮是第 1 步才上线的。扩展清单没有 `key`，扩展 ID 由目录决定，所以只能原地替换，不能换目录。
   1. 预检：主工作区 `extension-build/` 与 `git archive 4ed2a99` 的 7 个扩展路径一致（当前是 0.4.16 试点版）。不一致就停止。
   2. 备份：`cp -Rp extension-build extension-build.rollback-v0416pilot-before-<短 sha>`，然后用 `diff -r` 核对备份。
   3. 替换：再核对一次 zip 的 SHA，然后执行 `rsync -a --delete --delete-excluded --exclude .DS_Store <scratch>/ext/extension-build-0.4.17/ extension-build/`，再 `chmod 755 extension-build`。
   4. 核对：与解包目录 `diff -r` 无差异；共 102 个文件；版本 0.4.17；与备份相比只有 3 个文件不同。
   5. 以上步骤先写成脚本，用户同意后再执行。
3. **逐个节点重载**：在节点空闲或已停止时，在 `chrome://extensions` 里重载扩展，然后重启 Chrome。一次一个节点，成都等多窗口机器放在最后。每个节点都到后台核对 `app_version` 为 0.4.17 并带 `previousCaptureStopCheckV1` 能力位。Windows 节点从下载地址取包，在各自原目录内原地替换。
4. 0.4.17 铺开、没有节点还在 0.4.15 或更早版本之后，再评估单独发布 `17351b2`。

## 回滚

- **服务端与 Admin**：用发布目录 `backup/` 下的 6 个服务端文件和 `backup/admin/index.html` 覆盖回原位置，删除 `server/services/capture-stop-fence-release.js`，然后 `pm2 restart onstarvoice`。`update-manifest.js` 回到 0.4.15 后，更新提示不再指向 0.4.17 zip。zip 留在 `public-downloads/` 里，但不再被引用。
- **已放行的记录不回退**：它们的格式与历史对账相同，并且有事件和审计记录。
- **只想停掉自动核对**：设置 `CAPTURE_STOP_FENCE_AUTO_CHECK=off` 后重启服务。
- **本机扩展**：`rsync -a --delete extension-build.rollback-v0416pilot-before-<短 sha>/ extension-build/`，然后重载扩展。要回到 0.4.15，就用 0.4.15 zip（`d7422afc9aab6c6e27971a19d7e89537b87cd2420c19875913e3660182fe50af`）解包后同样原地替换。
