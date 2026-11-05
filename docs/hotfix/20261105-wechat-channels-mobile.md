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
- 记录字段：`url` 为本次复制的短链；`publish_time` 由 `createtime` 换算为北京时间；`likes ← likeCountFmt`、`collects ← favCountFmt`（后台在视频号上显示为「推荐」）、`shares ← forwardCountFmt`、`comments_count ← commentCountFmt`。
- 迟到规则：只要事件属于该手机的这次尝试、采集时间在尝试期间，关键词结束或被停止后到达也入库。

### 负面巡查

计划附带负面巡查时，视频号的负面帖子（规则同抖音小红书）生成 `negative_post` 工作项，由手机节点领取：先用记录里的短链经预览页复查互动数与是否失效；计划开了评论时，手机再按文案片段搜索找回原帖（作者一致、预览 `createtime` 一致才算找到），读评论后作为一次新观测写回。找不到只冷却，连续 3 轮停止巡查。

## 设计取舍

- 识字与预览解析都在后台并行，手机只在需要定位的两步（搜索结果页、转发面板）等待识字结果；评论截图边滑边截，识字异步完成。
- 预览失败的帖子重试 3 次，仍失败不上传，计入 `previewFailed`。
