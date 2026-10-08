# 20261008 手机 Runner 0.3.1：手机内存不足时重启抖音

## 现象

2026-10-08 22:00 的「手机提前采集」批次 13 个词，从第 3 个词起连续「手机响应超时」（`device_timeout`）：搜索框、复制链接、返回结果页都在 5–10 秒内没有响应；重建自动化会话、换词重试都没用，到 22:48 两轮共 19 次失败，8 个词等第 3 次重试，「凯迪拉克车机升级」3 次用满。手机屏幕本身正常停在抖音首页，Appium `/status` 正常，adb 响应 30 毫秒。

## 根因

```
$ adb shell top -b -n 1
Mem:   7837720k total,  7584924k used,   252796k free
Swap:  2621436k total,  2621436k used,        0k free
  PID USER  ... RES  ... TIME+       ARGS
21522 u0_a466   2.5G    5370:20.77  com.ss.android.ugc.aweme      # ELAPSED 8-05:53:19
$ adb shell cat /proc/meminfo | grep -E 'MemAvailable|SwapFree'
MemAvailable:    1494020 kB
SwapFree:              4 kB
```

抖音进程连续运行了 8 天 6 小时，常驻 2.7 GB、PSS 4.5 GB（其中 1.5 GB 已换出），2.6 GB 交换区只剩 4 KB，系统一直在颠簸。logcat 里 uiautomator2 每次 `GET /session/*/source`（读屏）耗时 3–11 秒（正常 1–2 秒），超过 Runner 单次读屏 10 秒上限（`ui-wait.mjs` `READ_TIMEOUT_MS`）的那一次就把整个关键词判成 `device_timeout`。Runner 的前台守卫只在抖音不在前台时 `am start` 拉起，设计上从不重启、不清理这个 App，所以内存只会一直涨。

22:48 手动 `am force-stop com.ss.android.ugc.aweme` 再拉起：可用内存 1.5 GB → 4.3 GB、交换区剩 1.5 GB，读屏回到平均 1.1 秒、最长 2.6 秒，下一个词「别克车机升级」正常采到 4 条。

## 改动（Runner 0.3.1，只在 `runners/android/`，服务端不变）

- `src/device/douyin-memory.mjs`（新）：解析 `/proc/meminfo`；阈值 `MEMORY_RESTART_THRESHOLDS = {memAvailableKb: 1 GB, swapFreeRatio: 10%}`；`memoryPressure()` 判定（字段读不到不算压力；没有交换区的手机只看可用内存）；`describeMemory()` 人话读数。
- `src/device/adb.mjs`：`memInfo(serial)` 只读；`stopDouyin(serial)` 是 Runner 唯一的强停（只停抖音、不清数据、不掉登录）。
- `src/device/douyin-foreground.mjs`：拉起逻辑抽成 `start()`，`ensure()` 和新的 `relieveMemory()` 共用。`relieveMemory()`：读内存→有压力且距上次重启 ≥ 30 分钟→确认亮屏未锁→`stopDouyin`→同一个审核过的启动组件拉起→重新核对机型/版本/前台。重启算一次启动（`launches++`），所以下一个关键词会先去「我」页确认登录（0.2.9 的登录证明机制原样复用）。30 分钟内再次有压力只上报不重启；拉起失败和普通重拉一样报 `douyin_not_foreground`，30 分钟内不再强停。
- `src/device/profile-adapter.mjs`：空闲探测 `probe()` 先 `relieveMemory()` 再 `ensure()`；探测结果带 `memory`，`foreground.launched` 在重启后为 true。关键词执行中不探测（daemon 只在 `!active` 且未 blocked 时探测），会话未关闭时不可能触发。
- `src/daemon/runtime.mjs`：探测到 `memory.restarted` 就记一条本地诊断 `douyin_restart`（原因、四个读数），`deviceProbe.memory` 进 `status`；`lastMemoryRestart` 给一键窗口。上报服务端的 poll 探测摘要不变（测试锁定只有 `checkedAt`/`foreground`）。
- `src/cli/up-command.mjs`：窗口打印「【已重启抖音】手机内存不足（可用 1.4 GB · 交换区剩 0 MB / 2.5 GB）· 已强停并重新拉起抖音，下一个关键词会先确认登录」。
- `src/daemon/diagnose.mjs`：`summary.douyinRestarts`；`problems` 自然列出每次 `douyin_restart`。
- 测试 `test/douyin-memory-restart-20261008.test.mjs` 8 项：读数解析、阈值判定、adb 命令形状、守卫重启/限频/锁屏不重启/拉起失败不重试、适配器探测后下个任务重新证明登录、daemon 诊断+状态+窗口文案+poll 契约不变。全套 Node 24.12.0 串行 270/270 通过。

## 发布

见本文末尾「上线记录」。换版步骤同 0.3.0：Runner 空闲时 SIGINT 受控停止 → 备份状态库 → 从提交 `git archive` 生成 `runtime-0.3.1-<hash>` → 一键启动器启动。回退：换回 `runtime-0.3.0-12d09bc` 的启动器，没有数据需要回退。

## 核对

- 一键窗口出现「【已重启抖音】…」行；`cli.mjs status` 的 `deviceProbe.memory`；`cli.mjs diagnose --hours 24` 的 `summary.douyinRestarts` 和 `problems` 里的 `douyin_restart`。
- 读屏耗时：`adb logcat -d -v threadtime | grep -E "I appium  : (channel read: GET /session/[^/]+/source|AppiumResponse)"` 按分钟算 request→response 间隔，正常 1–2 秒。
- 抖音进程年龄：`adb shell ps -o PID,ETIME,RSS,NAME -A | grep ugc.aweme$`。

## 已知限制（没做，留给后续）

- 阈值是常量，不能从后台或命令行改；想调整只能改 `douyin-memory.mjs`。
- 只看内存，不看抖音进程常驻大小或运行时长；若某天内存没满但读屏已经慢，仍要靠人工。
- 重启后抖音冷启动如果弹出活动/青少年模式弹窗，与原有自动重拉同样依赖下一个任务的登录检查来发现。

## 上线记录（2026-10-08）

| 时间 | 动作 | 结果 |
|---|---|---|
| 22:48 | 手动 `am force-stop` + 拉起抖音（根因处置） | 读屏 avg 1.1 s / max 2.6 s；后续 6 个词正常完成 |
| 23:08 | 提交 `4a98cec`（main）并推送；`git archive` 生成 `runtime-0.3.1-4a98cec`（`release-source.sha`、沿用 `launcher.json`） | 运行目录内 8/8 测试通过 |
| 23:19:01 | Runner 0.3.0（PID 35682）空闲 90 秒后 SIGINT 受控停止 | 1 秒内退出，`deviceClosureRequired=false`、待上传 0；状态库备份 `backups/runner-0.3.0-12d09bc-before-0.3.1-4a98cec-20261008.sqlite`（完整性 ok） |
| 23:19–23:26 | 新 Runner 两次启动即退（`Command could not complete`） | 真因 `device_locked`：`/tmp/starvoice-android-device-locks/<serial-hash>.lock` 目录还在但 `owner.json` 已不在，目录改动时间 10-08 00:00:00——macOS 每日清理 /tmp 删掉了 3 天没动过的锁文件（0.3.0 从 10-03 跑到现在）。`cli.mjs close` 对「有目录无 owner」明确拒绝（manual investigation）。人工核对：旧进程已退出、手机无 uiautomator2 helper、无会话后，`rmdir` 空锁目录 |
| 23:26:25 | 在桌面端终端页签用 ASCII 包装脚本 `launcher/start.sh` 启动 0.3.1（`open` 双击启动器从本会话拉不起 Terminal 窗口） | PID 52965；就绪、`controlError=null`；`deviceProbe.memory` = 可用 3.1 GB、交换区剩 1.5 GB / 2.5 GB、`starved=false` |

本批 13 词最终：已完成 9（凯迪拉克OTA、别克OTA、别克车机升级、上汽通用客服、别克APP、别克远控、ibuick、别克哨兵、别克壁纸/凯迪拉克壁纸见调度中心），3 次用满 3 个（凯迪拉克车机升级：第 3 次撞上手动重启；安吉星、至境哨兵：第 3 次 `invalid_ui_source`），等下一轮自动再采。

## 顺带发现（未改）

1. **锁根在 /tmp 会被系统清理**：`fixedLockRoot()` = `/tmp/starvoice-android-device-locks`，macOS 会删除 3 天未访问的 /tmp 文件（本次 00:00:00 整点）。Runner 连续运行超过 3 天后，退出时 `releaseDeviceLock` 找不到 owner 会抛错，下次启动报 `device_locked`，`close` 也不接受。可选修法：锁根改到不被清理的固定目录（如 `~/Library/Application Support/StarVoice/android-device-locks`，README 里「整台电脑固定目录」的约束要同步改），或运行中定期 touch `owner.json`。
2. **`invalid_ui_source` 今晚 3 次同一签名**（别克哨兵 22:21、安吉星 22:56、至境哨兵 23:10）：`parser=invalid_attribute`、`tag=android.widget.TextView`、已解析 3 个属性、下一个是 `text`。本地复现：属性值里的 `<` 会报 `invalid_tag` 而不是这个，所以不是 `<`；具体字符仍未捕获（09-26 同样没抓到）。可选：解析失败时把出错属性前后 80 字符记进本地诊断（不上传），下次就能定位。
