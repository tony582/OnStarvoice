# 手机回到首页后读屏超时、后面的关键词全部秒失败 hotfix（2026-10-02）

分支：`codex/hotfix-android-feed-read-timeout-20261002`，基线 `main`（`69babda`）。Android Runner `0.2.7` → `0.2.8`。只改手机 Runner，不涉及服务端、后台和扩展。

## 现象

2026-10-02 中午新下发的一批手机任务，前 4 个关键词正常，12:16 起后面的关键词全部在约 19 秒内以 `needs_action: device_timeout` 结束，停在 `inspect:login_check`（任务开始时的第一步读屏）。连续 15 次，每个词很快用到第 2、第 3 次机会。

当时手机本身正常：ADB 在线、亮屏未锁、抖音在前台（`SplashActivity`，即首页）、Appium 就绪。屏幕上是首页「推荐」信息流里的一条自动轮播的图文（「动图」）作品。

12:28:29 用 `adb shell input swipe` 把信息流滑到下一条（普通视频）后，下一个关键词（12:28:43 开始）的读屏立刻恢复，之后的关键词正常完成。

## 根因

- Runner 0.2.6（09-28）起，每个任务结束后会回到抖音首页（`parkDouyinHome`）。下一个任务的第一步 `verifyLoginAndSearchEntry` 先读当前屏幕，也就是首页信息流正在播放的那一条。
- 信息流停在自动轮播的图文作品上时，界面一直在变，UiAutomator2 取层级（`GET /source`）在 10 秒内返回不了，`ui.read` 以 `device_timeout` 结束。
- 这一步没有任何恢复：任务直接失败，随后的「回首页」同样读不了屏（`parked:false, reason: device_timeout`），信息流还停在同一条上，下一个任务重复同样的失败。直到有什么把信息流换掉为止。
- 09-26 修过同一位置的另一种情况（搜索结果页层级解析被拒，`invalid_ui_source`，按返回键退出），但读屏超时不在那次的覆盖范围内。

本机 `diagnose --hours 120` 的统计：`device_timeout` 共 61 次，全部在 30 秒内结束（都是任务的第一步读屏），最早一次是 09-28 21:11，也就是换上 0.2.6 当晚；09-29 19 次、10-01 22 次、10-02 18 次。它和上午修的「上传队列堵死」是两个互不相关的原因，叠在一起造成了「手机采集一直报错」。

## 修复

| 文件 | 改动 |
| --- | --- |
| `runners/android/src/device/douyin-readiness.mjs` | 任务开始时的第一次读屏如果 `device_timeout`，调用「滑到下一条」后等 1.2 秒重读，最多 2 次（`UNREADABLE_FEED_SKIPS`）。只对第一次读屏生效：之后的屏幕都是这一步自己点进去的（「我」页等），不滑。滑动失败或不满足条件时，照旧抛出原来的超时错误 |
| `runners/android/src/device/profile-session.mjs` | 「滑到下一条」只在抖音首页所在的 Activity（`.splash.SplashActivity`）持有焦点时执行，用 `adb` 读焦点、用 `adb` 滑动 |
| `runners/android/src/device/adb.mjs` | 新增 `swipeUp`：按 `wm size` 读到的屏幕尺寸，在屏幕中线从 67% 高度滑到 27% 高度（250 毫秒）。不点任何位置、不定位任何元素 |
| `runners/android/src/core/discovery-runner.mjs` | 发生过跳过时记一条本机诊断 `feed_unreadable_recovered`（含次数），`diagnose` 里能看到 |

为什么走 `adb` 而不是 Appium：读屏卡住的正是 UiAutomator2 这一侧，同一会话里的滑动指令会排在卡住的读屏后面（事故中「回首页」的每一步也都超时）。`adb shell input` 不经过它。

最坏情况下任务开始会多花约 25 秒（两次 10 秒读屏超时加两次滑动），仍在单步 60 秒的上限内；两次都没恢复时结果与修复前相同。

## 验证

- 新增 `runners/android/test/feed-read-timeout-20261002.test.mjs`（6 项）：首页那一条读不了时滑一次后任务正常开始，结果里带 `feedSkips: 1`；最多滑 2 次，仍读不了时按原样报 `device_timeout`（带 `inspect:login_check` 和次数）；焦点不在抖音首页（搜索结果页、桌面、读不到焦点）时不滑；这一步自己打开的屏幕超时不滑；滑动命令失败时抛出的仍是原来的超时；滑动坐标取自屏幕尺寸（含 `Override size`）、固定指定序列号、读不到尺寸时不发滑动。把恢复逻辑关掉后，前两项和第五项失败。
- Runner 全量（Node 24.12，串行）：230 / 230。模块边界检查通过。
- 真机验证与换版记录见文末。

## 已知限制

- 只处理「任务开始时停在首页信息流」这一种读屏超时。任务中途（搜索结果、作品详情）的读屏超时仍按原规则结束本次任务。
- 滑到下一条会让抖音多「看过」一条推荐内容，对账号没有其它影响。
- 没有改「任务结束回首页」本身：手机空闲时仍停在首页信息流上自动播放。
