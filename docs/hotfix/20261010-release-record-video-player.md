# 详情抽屉直接播放视频（2026-10-10）

分支：`feat/record-video-player-20261010`，提交 `af59a57`（基于 `main` `57d326e`）。**已于 2026-10-10 13:31 发布到生产：服务端只替换 2 个文件、只重启 `onstarvoice-api`；后台静态文件随后发布。**

## 内容

- **详情抽屉「内容」里，逐字稿上方加了视频播放器**（`RecordVideoPlayer`）。打开抽屉不加载视频，点了「播放」才加载：
  1. 先让浏览器直接播平台链接（不占服务器带宽）；
  2. 平台拒绝（防盗链／过期）就自动改走服务端转发 `/api/records/:id/media-proxy?inline=1`；
  3. 转发也失败，提示「视频链接已过期或平台拒绝播放」，并给出「原文」链接。
- **服务端转发**（`server/services/media-proxy.js`、`server/routes/records.js`）：
  - `inline=1` 播放模式：不加下载头；校验浏览器的 `Range` 后转给上游，`206`／`Content-Range`／`Accept-Ranges`／`416` 原样回传（Safari 不支持分段就不播，Chrome 没有分段就拖不了进度条）。`<video>` 带不了 `x-tenant-id`，租户走已有的 `?tenantId=`。
  - 超时从「总时长 60 秒」改成「等响应头 60 秒 + 60 秒没有新数据」：原来任何超过一分钟的下载或播放都会被中途切断。
  - 中途断流时直接断开连接，不再 `end()`——否则客户端会一直等声明长度里剩下的字节；断开后播放器会按 `Range` 重新请求。
- 新测试 `tests/media-proxy-inline-playback.test.mjs`（7 项；旧实现跑同一组会挂 4 项）。

不涉及数据库、扩展、手机 Runner 和环境变量。

## 真实链接实测（生产库只读取样，本机 curl，`Range: bytes=0-1023`）

| 链接 | 浏览器直连（来源=我们的域名） | 带平台来源（=服务端转发） | 不带来源 |
| --- | --- | --- | --- |
| 小红书 `sns-video-*.xhscdn.com`（10-10 采） | 206 | 206 | 206 |
| 抖音 `www.douyin.com/aweme/v1/play/`（10-10 采） | 403 | 206 | 206 |
| 抖音 `www.douyin.com/aweme/v1/play/`（10-07 采） | 403 | 206 | 403 |
| 抖音 `aweme.snssdk.com/aweme/v1/play/`（10-10 采） | 200 但内容为空 | — | — |

- 小红书直连就能播；抖音拒绝我们的域名，会自动切到转发，3 天前的链接也还能播（`aweme/v1/play` 是播放入口，按 `video_id` 跳到新的签名地址）。生产服务器带抖音来源请求同一链接也是 206。
- `<video>` 没有 `referrerpolicy` 属性，整页改成不带来源又会让同源 POST 的 `Origin` 变成 `null`，所以抖音没有走「不带来源直连」，靠转发。转发会占服务器出口带宽，只在有人点播放时发生。
- 最近 7 天带视频链接的记录：抖音 `www.douyin.com` 117、`api-play-zjg.amemv.com` 5、`aweme.snssdk.com` 1；小红书 4 个 `sns-video-*` 域名共 346。`snssdk.com` 不在转发白名单里，返回的也不是视频，这 1 条播不了（会显示过期提示）。

## 发布前核对

| 项目 | 结果 |
| --- | --- |
| CI（运行 38027357706，提交 `af59a57`） | 五项全部通过 |
| 后台类型检查 / lint 基线 / 构建 | 通过；261 ≤ 288 |
| 相关测试（新测试 + 引用 `RecordDrawer.tsx`／`routes/records.js`／`media-proxy` 的契约测试） | 17 个文件全部通过；新测试 Node 18 / 24 均通过 |
| 本地模拟（模拟 CDN：可直连／只认抖音来源／一律 403；转发用真实的 `streamMediaToResponse`） | 可直连的直接播；有防盗链的自动转发并开始播放（上游收到抖音来源和浏览器的 Range）；视频链接只在 payload 里的也能播；过期的显示提示和「原文」；经转发按分段取数据返回 206 |
| 服务端发布脚本演练（模拟生产目录 + 真实启动的 api + 本地测试库） | 预检通过；被替换文件／引用它们的模块／三进程清单被改过时都拒绝且不改任何东西；新版启动失败、发布中 scheduler 被重启时都自动还原并恢复就绪；正常发布成功；同一目录再跑被拒绝 |
| 后台发布脚本演练 | 同 10-10 上午那套，全部符合预期 |
| 生产只读预检 | 服务端：2 个替换文件 + 17 个核对文件与 `57d326e` 一致，三进程在线；后台：线上 55 个文件就是 `e337176` 那版，210 个服务端文件与 `af59a57` 一致 |

## 过程（Asia/Shanghai）

| 时间 | 操作 | 结果 |
| --- | --- | --- |
| 13:31:35–13:31:39 | 服务端 `bash deploy.sh` | 退出码 0。替换 `records.js`、`media-proxy.js`，`onstarvoice-api` 8581 → 36247，约 2 秒就绪；scheduler 7297、ai-media 7298 未变；4 个未登录路由前后都是 401 |
| 13:31:48–13:31:57 | 后台 `python3 publish.py --deploy` | 退出码 0。55 个文件公网逐个核对一致，三个进程未变 |
| 13:32 | 外部核对 | 公网入口 = 本包 `index.html`（`47555828…`）；新的 `RecordDrawer` 分包含播放器；上一版入口资源仍返回 200；生产服务器带抖音来源取视频 206；api 在线 |

发布目录：`/opt/onstarvoice-private/releases/video-player-server-af59a57-20261010`、`/opt/onstarvoice-private/releases/video-player-admin-af59a57-20261010`。发布包、出包脚本与演练：`~/Documents/claude/releases/OnStarvoice-video-player-af59a57-20261010/`（`server-tooling/` 是按三进程拓扑改过的服务端单文件发布工具，只重启 api）。

没有在生产上登录后台点过播放（没有使用任何人的生产账号）。已打开后台的人刷新页面后才有播放器。

## 回退

- 后台：把 `video-player-admin-…/backup-admin/index.html` 放回 `/opt/onstarvoice/web/admin/dist/index.html`。
- 服务端：把 `video-player-server-…/backup/server/` 下的两个文件放回 `/opt/onstarvoice/server/` 对应位置，`pm2 restart onstarvoice-api`（不要 `pm2 update`）。旧后台只用下载模式，与新服务端兼容，所以可以只回退后台。
