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
