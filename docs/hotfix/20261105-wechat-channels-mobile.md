# 视频号手机采集（同一台 DE106 与抖音轮流）

分支 `codex/feat-wechat-channels-mobile-20261105`，基线为生产代码 9e65be0 + `detail-lifecycle.js` 热修复（8aef9ba）。

## 已实测的约束（2026-11-05，DE106 / Android 8.1 / 微信 8.0.80）

- 微信 8.0.80 不向 UiAutomation 暴露页面结构：`uiautomator dump` 与 Appium 都只读到一个空的 FrameLayout，开多窗口也只读到状态栏。8.0.48 能读，但转发面板没有「复制链接」；手机无法降级。因此视频号**不使用读屏接口、不建 Appium 会话**，只用 adb 截图、Mac 本机文字识别（Apple Vision，不调用 AI 模型）、固定坐标点击，并以 `dumpsys window` 的当前 Activity 确认所在页面。不尝试绕过微信的限制。
- 中文输入：临时启用并切换到手机上已安装的 `io.appium.settings/.UnicodeIME`，`input text` 发送修改版 UTF-7，然后立即切回原输入法并禁用 UnicodeIME。空闲探测发现输入法不是原值时恢复。
- 剪贴板：`am broadcast -a io.appium.settings.clipboard.get` 读出 base64，不需要 UiAutomation。
- 「复制链接」：转发面板第二行横向滑到末尾，识字定位后点击。每次复制得到**不同**的短链 `https://weixin.qq.com/sph/<id>`，短链不能当作品编号。
- 短链在普通浏览器打开公开预览页 `channels.weixin.qq.com/finder-preview/pages/sph?id=`，页面自己请求 `feed/get_feed_info`，返回完整文案、`createtime`（秒）、作者昵称与头像、`likeCountFmt / favCountFmt / forwardCountFmt / commentCountFmt`、封面。直接调用该接口返回 401，因此由 Runner 主机上的无界面 Chrome 打开页面并读取页面自己的响应，每条 0.3–0.6 秒。预览页没有评论。
- 搜索结果是两列卡片：时长行（左下 `mm:ss`、右下点赞数）、两行文案、作者 + 时间行（时间常被截成「1 小时…」）。缩略图上的文字也会被识别，解析时以时长行为锚点只取其下方固定范围。
- 评论面板：表头「评论 N」，首行「作者名 作者 地区 时间」+完整文案；每条评论为「昵称 [地区] 时间」行 + 内容行 + 右侧点赞数；楼中楼缩进；「N条回复」可展开。输入框在底部（y≥2100），任何点击都不能落在这一带。
- 页面 Activity：主界面 `.ui.LauncherUI`（`am start -f 0x04000000` 回到主界面）、视频号首页 `FinderHomeAffinityUI`、搜索 `MMFTSSearchTabWebViewUI`、作品 `FinderShareFeedRelUI`。`SelectConversationUI`（选择聊天）出现即立刻返回并停止。
- 隐私：经过主界面时截图里有聊天列表。识字结果只在内存里用于定位，不写入诊断、不上传。

## 协议

### 平台与工作流

- 平台值 `wechat_channels`，显示为「视频号」。
- 手机子任务的 `metadata.workflow`：抖音 `douyin_mobile_discovery`（不变），视频号 `wechat_channels_mobile_capture`。
- 轮询体增加 `platforms: string[]`：Runner 本次确认可用的 App（版本与校准配置一致）。缺省按 `['douyin']`。领取只在这些平台里选工作项。

### 下发任务（视频号新增字段）

`platform: 'wechat_channels'`、`mode: 'keyword' | 'patrol'`、`filters: {sort: 'all'|'latest'|'hot', publishWindowHours: number|null}`、`comments: {enabled, limit}`、`patrolTarget`（仅巡查）。计划时间窗口映射为 day 24、week 168、month 720、halfyear 4320、all null；设了窗口时排序强制 `latest`。

### 上传事件 `eventKind: 'wechat_post'`

```
{eventKind, eventId, discoveryRunId, taskId, itemId, attemptId, assignmentRevision, requestHash, agentId,
 keyword, mode, rank, capturedAt,
 card: {snippet, author, timeLabel, likeLabel},
 link: {shareUrl},
 preview: {description, createtime, nickname, avatarUrl, likeCountFmt, favCountFmt, forwardCountFmt, commentCountFmt,
           coverUrl, isImage, exportId},
 comments: {status: 'captured'|'partial'|'disabled'|'empty', headerCount, items: [{author, location, timeLabel, content,
            likeCount, reply, parentIndex}]}}
```

- `POST /api/capture-cloud/android/agent/posts {uploadBatchId, events}`（1–5 条）→ `{uploadBatchId, receipts:[{eventId, status, receiptId, recordId}]}`；`GET /agent/post-receipts?batchId=`。回执幂等，同一事件不同内容返回 409。
- 作品编号（服务端计算）：`wxc_` + sha256(`createtime|昵称`) 前 24 位。评论编号：sha256(作品编号、父评论序号对应的作者+内容、作者、规范化内容)。
- 记录字段：`url` 为本次复制的短链；`publish_time` 由 `createtime` 换算为北京时间；按 8.0.80 的图标标签，`likes ← favCountFmt`（大拇指「喜欢」，也是搜索卡片上的数）、`collects ← likeCountFmt`（心形「推荐」，后台在视频号上显示为「推荐」）、`shares ← forwardCountFmt`、`comments_count ← commentCountFmt`；四个原始数另存在记录内容里。
- 迟到规则：只要事件属于该手机的这次尝试、采集时间在尝试期间，关键词结束或被停止后到达也入库。

### 负面巡查

计划附带负面巡查时，视频号的负面帖子（规则同抖音小红书）生成 `negative_post` 工作项，由手机节点领取：先用记录里的短链经预览页复查互动数与是否失效；计划开了评论时，手机再按文案片段搜索找回原帖（作者一致、预览 `createtime` 一致才算找到），读评论后作为一次新观测写回。找不到只冷却，连续 3 轮停止巡查。

## 手机端使用

1. 停掉正式 Runner（窗口里 Ctrl-C，等「手机已释放」）。
2. 在 Runner 目录执行 `node cli.mjs enable-wechat --state-dir <状态目录>`：用本机 `swiftc` 编译识字工具到 `<状态目录>/bin/starvoice-ocr`，并在 `connection.json` 记下微信校准配置。需要 Xcode 命令行工具和 Google Chrome。
3. 照常双击启动器。窗口显示「手机已连接 · 可采 抖音、视频号」即可接两种任务；轮询带上 `platforms`，服务端据此只派可用 App 的任务。
4. 手机微信要保持 8.0.80、关闭自动更新；升级后视频号报 `profile_version_mismatch` 暂停，抖音不受影响。

## 验证（2026-11-05）

- 解析：用真机识字结果做的夹具覆盖结果卡片（时长行锚点、缩略图文字排除、截断的时间标签、繁简 OCR 变体）、评论面板（表头、作者行、楼中楼缩进、「N条回复」）、转发面板「复制链接」、预览页答复、修改版 UTF-7。
- Runner 全套 305 项、服务端单元 3459 项、模块边界 114 个模块通过；隔离 PostgreSQL 新增 7 项集成检查（按平台领取、上传与回执、迟到上传、浏览器不领视频号、负面巡查成功与未找回冷却到停止）通过。
- 真机 + 本地服务端到端（`onstarvoice_e2e_wechat_20261105`，未连生产）：
  - 「别克车机升级」24 小时：读 3 张卡、打开 2 张，1 条入库；1 条卡片写「22 小时」但预览页精确时间已超 24 小时，被丢弃；随后「前天」的卡片触发窗口截止。用时 85 秒。
  - 「别克昂科威」一周、上限 3 条：3 条入库，发布时间到秒。
  - 「别克车机升级」最热、不限时间、上限 2 条：2 条热门帖各读入 20 条评论（作者、地区、日期、点赞数、内容）。
  - 同一手机同时启用两个 App：先跑抖音「别克壁纸」（从微信切到抖音，找到 2 条链接，70 秒），再跑视频号「别克君越」（从抖音切回微信，入库 2 条，60 秒）；结束后手机释放、输入法恢复为锤子输入法。
- 未在真机跑过的部分：负面巡查找回（与关键词共用同一组手机动作，已有单元与集成测试）；长时间连续运行。

## 设计取舍

- 识字与预览解析都在后台并行，手机只在需要定位的两步（搜索结果页、转发面板）等待识字结果；评论截图边滑边截，识字异步完成。
- 预览失败的帖子重试 3 次，仍失败不上传，计入 `previewFailed`。

## 上线（2026-11-05）

- 服务端与后台：用户回复「部署到 47.103.125.200」后按文件清单发布（31 个服务端文件，其中新增 4 个；迁移 094；后台静态文件只增加新资源、最后切换 index.html）。预检确认 27 个已有文件与 0.4.29 基线逐字一致、`detail-lifecycle.js` 热修复保留、无执行中任务。
  - 第一次 19:44：迁移 094 已执行，重启 API 后健康检查在端口监听前就请求，判为失败并自动回滚代码（迁移是纯新增，保留）；回滚后三进程在线、就绪 200。发布脚本改为最多等 30 秒就绪后重做预检。
  - 第二次 19:49:44 发布成功：api / scheduler / ai-media 三进程重启在线，就绪 200，后台入口已切到新版本；回滚备份 `web/admin/dist.before-6f71d5b`，发布记录在 `/opt/onstarvoice-private/releases/wechat-channels-6f71d5b-20261105`。生产服务端 = 本分支 `6f71d5b` 的服务端代码。
- 手机：`runtime-0.4.0-6f71d5b` 已放在 `~/Documents/claude/StarVoice-Android`，正式状态目录已执行 `enable-wechat`（`connection.json` 与状态库发布前备份在 `backups/`）。由用户双击该目录 `launcher/StarVoice 手机采集.command` 启动；首次轮询后后台节点显示可采视频号，才能在计划里选它。

## OnStar 首轮试跑与 Runner 0.4.1（2026-11-05 / 11-06）

- 试跑放在租户 OnStar（安吉星客户在用，不碰）：线上 `ANDROID_DISCOVERY_INGEST_TENANTS` 加入 OnStar 后只重启 api；DE106 以 OnStar 激活码另注册一个只开视频号的节点（状态目录 `state-829d89-onstar`）；计划「视频号手机采集（试运行）」11-05 21:12 跑 13 个词（一天内、最新、每词 10 条、评论 20）。结果 10 成 3 败，入库 6 条，其中 1 条带 5 条评论。
- 暴露的问题与处理：
  - 任务刚结束时，一次在它运行期间发出的轮询才返回，仍带着服务端尚未关闭的租约，Runner 又启动了同一任务，第二遍报 `resume_authorization_required`，并用 `needs_action` 覆盖了已保存的「完成」结果（别克OTA、ibuick）。基线就有，抖音同样受影响。0.4.1：有未送达的完成结果，或与上一个任务同一 attempt 时不再启动（`daemon-relaunch-20261105.test.mjs`，修复前失败）。
  - `video_tab_missing`（上汽通用客服、别克远控、ibuick 各 3 次）：结果页顶部有服务号卡片时，识字把标签读成一行「视频 账号」，精确匹配找不到「视频」。0.4.1 新增 `findWord`：精确行优先，否则在合并行里按整词定位（夹具 `results-service-card-20261105`）。11-06 真机重搜 ibuick、别克远控各通过。
  - 「评论 1」却读到 0 条：真机打开该帖确认唯一一条评论是图片（作者行「那年夏天 湖北 1天前」下面 400 px 没有文字），原解析把没有文字的评论丢掉。用户定为保留：0.4.2 起作者行下 200 px 内没有任何文字的评论记为「[图片]」；靠近屏幕底部、文字还在下一屏的作者行不算（夹具 `comments-image-only-20261106`）。11-06 真机重读该帖：表头 1、读到 1 条「[图片]」。

## 负面巡查改为按链接直开原帖（Runner 0.4.3，2026-11-06）

- 真机试巡查（本地隔离库 `onstarvoice_e2e_wechat_20261105`，生产未动）：把萧枫那条非负面帖在本地库标成负面，由真实的候选加载器选中并下发。第一次失败在搜索：搜索框只显示约 14 个字，20 个字的巡查关键词读回「忍无可忍，无须再忍！凯迪拉克/」，结果页确认不通过（b75da31 修为「框内显示的开头≥8 个字且是关键词开头即算」）。服务端把这次失败记为未找回并冷却 15 分钟，没有判删除。
- 用户在 iPhone 上发现分享链接在浏览器里可「前往微信 → 打开」直达原帖。安卓同样可行；logcat 显示浏览器最终交给微信的是 `weixin://biz/finder/openFinderFeed/exportId=<exportId>&actionType=0&commentScene=39&entryScene=64&entryCardType=48&requestScene=0`，入口 `com.tencent.mm/.plugin.base.stub.WXCustomSchemeEntryActivity`。用 `am start --user 0 -n <入口>` 直接交给主微信，0.4 秒打开原帖，不经浏览器，也不出现锤子应用分身的选择框。预览页每次给的 `dynamicExportId` 都不同，但都能打开同一条帖子。
- 0.4.3 巡查顺序：读存下的分享链接预览（发布时间到秒 + 作者核对是同一条）→ 按预览给的 exportId 直开 → 读评论 → 上传，结果 `patrol_relocated`（服务端不改）；直开失败且手机已复位时退回搜索文案开头；都不行只更新互动数或记未找回。exportId 只接受 `export/` 加 8–200 位字母数字下划线横线，链接在设备 shell 里整体单引号包住，含引号、空格、`$` 等一律拒绝。
- 直开的作品页底部常多一条「↑更多视频」，操作行上移约 180 px。0.4.3 读评论前先识字找底栏的数字行，评论图标在最右侧数字上方 65 px；读不到数字时按是否有「更多视频」条决定是否上移，否则用原固定点。关键词采集读评论也走这一步。
- 真机复跑同一巡查项：直开成功，入库 1 条，互动数更新为 喜欢 7 / 推荐 6 / 转发 9 / 评论 1，评论 1 条「那年夏天 湖北 [图片]」，巡查项 completed（patrol_relocated），巡查状态记下成功时间，手机回到微信首页。

## 评论去噪与重采不重复（Runner 0.4.4 + 服务端，2026-11-06）

- OnStar 3 词测试（11:46，0.4.3）3/3 完成，10 帖入库或更新，但评论有四类问题：正文吞进「首评」标记和下方广告卡（「…首评岚图汽车官方…限时18,000元」），翻屏时尾巴不同导致同一条评论在一次采集里存了 4 遍；行尾表情被识成「起」「C」「（」「@」；昵称后的徽标被识成另一个字（迷途懒猫心/凶）或地区粘在昵称上（强广西、…997200四川）；评论编号由「昵称+正文」识字结果算出，隔天重采识字差一个字就成了新评论（尼克杨那帖两天各存一份）。
- 用链接直开这 4 帖、截下评论面板做夹具后修复：
  - Runner 0.4.4：「首评 / 作者赞过 / 作者回复过」独占一行时结束上一条评论；右侧有「广告」标记的卡片整块跳过，直到下一个评论作者行；行尾孤立的「（」「(」「@」去掉；作者名末尾没有单独地区时按省级地区名拆出地区，末尾「°」等徽标符号去掉；翻屏合并改为「昵称相同或只差最后一个字（≥3 字）且正文相同、只差末尾一个字或相似度≥0.8」；第一屏没读到「评论 N」标题时再看两次，避免整帖评论被跳过。真机复读这 4 帖：1/3/2 条正确，阿哲那帖第二次打开时面板停在上次的位置，屏上 3 条全部正确。
  - 服务端：同一帖再次上传时，先取这帖已存的评论（`record_comments` 与该帖上次采集的列表），新读到的评论按同样规则和已存评论一一对上就沿用已存编号（回复跟着父评论走），对不上的才是新评论。已存的重复行不会自动合并。
- 「起」「C」这类整字误识无法可靠区分真假，保留在正文里；它们不再影响去重和编号。

## 视频号按 App 自己的筛选（Runner 0.4.5 + 服务端 + 后台，2026-11-09）

- 用户发现后台的视频号「发布时间」和视频号 App 里的筛选不一样，要求「按照视频号里面的筛选做」。真机核对（DE106 / 微信 8.0.80，关键词安吉星）：搜索结果「视频」页只有排序 不限 / 最新 / 最热，和「时长」「范围」两个按钮；点开是底部弹层，时长 = 不限 / 5分钟以下 / 5-20分钟 / 20分钟以上，范围 = 范围不限 / 已关注 / 最近看过；选中后弹层关闭，按钮文字变成所选项；每次重新搜索都回到不限。App 没有发布时间筛选。
- 后台（视频号）：排序、发布时间、时长、范围四项，叫法与 App 一致；发布时间单独一套（不限时间 / 一天内 / 一周内 / 一个月内 / 半年内），是我们按卡片右下角时间实现的；选了时间范围，排序锁成「最新」并写明原因；计划详情按这四项显示。手机节点上报没有 `wechat_search_filters` 能力（0.4.5 之前的采集器）时，选了时长或范围就不能选它，提示升级。
- 服务端：`videoDuration` 增加 `under_5m / 5_20m / over_20m`，`searchScope` 视频号只认 `followed / viewed`；取值和平台不符的回到 `all`（与未知值一致）。手机任务的 `filters` 只在选了时才带 `duration / scope`，未选的计划任务形状不变。手机轮询带 `features`，服务端记为 `capabilities.runnerFeatures`；带时长或范围的视频号关键词只派给报了该能力的采集器，避免旧版本不筛就采。
- Runner 0.4.5：排序确认后，按需点「时长」「范围」按钮，弹层标题对上才点选项（精确匹配，5-20分钟不会当成 20分钟以上），再确认按钮已显示所选项，之后重读结果；按「最新」时重新核对时间顺序。任何一步对不上报 `filter_unverified`，不会在没筛的结果上采集。
- 验证：Runner 317 项、服务端单元 3550 项、隔离 PostgreSQL 9 项通过；本地后台预览确认四个下拉的选项、时间范围锁定排序、旧采集器被挡并提示升级；真机三组搜索：安吉星 最新+5分钟以下（2 张卡片，时间递增）、凯迪拉克车机升级 最热+5-20分钟+最近看过（App 显示「暂无视频号相关结果」，0 张）、同词 最热+5-20分钟（时长 05:1x / 14:54 的卡片）。
- 顺带：11-09 上午手机插着却显示「未连接」，原因是本机另有一个 11-04 起的 adb 服务（5038 端口）占住了 USB，停掉后 5037 两秒恢复，Runner 自动上线。识字助手隔几天第一次调用要 37 秒（系统识字模型冷启动），之后 0 秒；第一次视频号任务可能因此超时一次。
