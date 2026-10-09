# 20261009 手机 Runner 0.3.2：设备锁根移出 /tmp + 读屏解析失败记录上下文

两项都是 2026-10-08 换版 0.3.1 时顺带发现、用户 10-09 批准（「做吧」）的改动。只改 `runners/android/`，服务端不变。

## 1. 设备锁根移出 /tmp

### 现象

10-08 23:19 停掉跑了 5 天的 Runner 0.3.0 后，新版两次启动即退（窗口只有「Command could not complete」）。用 `runUp` 直接打印真错是 `device_locked`：`/tmp/starvoice-android-device-locks/<serial-hash>.lock` 目录还在，但里面的 `owner.json` 没了，目录改动时间是 10-08 00:00:00 整——macOS 会删除 /tmp 下 3 天没人碰过的文件（锁文件 10-03 12:30 写入后再没被访问）。锁设计是「目录在而没有主人 = 未确认的获取，不凭 PID 消失自动释放」，`cli.mjs close` 对这种情况也明确拒绝（manual investigation），所以只要 Runner 连续运行超过 3 天，之后每次换版都会撞上，而且旧进程退出时 `releaseDeviceLock` 也会因找不到主人抛错。

### 改动

`src/daemon/state.mjs` `fixedLockRoot()`：macOS → `/Users/Shared/StarVoice/android-device-locks`（每台 Mac 都有、不被清理、整机共用，保留「其他用户无权访问现有锁目录时直接拒绝」的原语义）；Linux → `/var/tmp/starvoice-android-device-locks`（systemd 默认 30 天才清，Runner 目前不在 Linux 上部署）；Windows 不变（`%ProgramData%`）。锁文件格式、获取/释放/闭环确认逻辑都不变。测试 `test/lock-root-20261009.test.mjs`：三个平台的根都不在 /tmp、不在用户目录。

### 迁移

旧根 `/tmp/starvoice-android-device-locks` 不再使用；0.3.1 退出时会释放它自己的锁，换版后把空的旧根目录删掉即可。

## 2. 读屏解析失败记录出错位置上下文

### 现象

`invalid_ui_source` 一直只记规则名和计数（09-26 的设计：诊断里不含页面文字）。10-08 晚三次失败（别克哨兵 22:21、安吉星 22:56、至境哨兵 23:10）签名完全一样：`parser=invalid_attribute`、`tag=android.widget.TextView`、已解析 3 个属性、下一个属性是 `text`；本地复现属性值里的 `<` 报的是 `invalid_tag` 而不是它，所以具体是什么字符让 `text="…"` 不合语法，没有文字就查不下去。09-26 那次也是同样没抓到。

### 改动

`src/device/ui-tree.mjs`：
- 新增 `failureContext(text, index, radius=80)`：出错位置前后各最多 80 个码点（按字符边界截，表情不会被截成半个孤立代理项）、`offset`、以及窗口内 XML 不允许的码点（C0 控制字符除 tab/LF/CR、DEL 与 C1、孤立代理项、U+FFFE/FFFF，最多 8 个）。
- `invalid_attribute`（属性串里的位置）、`invalid_tag`（标签内第一个引号值含 `<` 的位置，否则标签开头）、`stray_text`、`bare_ampersand` 带 `context`；`duplicate_attribute`/`bare_ampersand`/`unknown_entity`/`invalid_code_point` 带 `attribute`（`unknown_entity` 另带 `entity` 前 40 字）；`unbalanced_tag` 带 `closeTag`/`openTag`。规则名和原有计数字段不变。
- 这段文字可能含帖子文案，只进本机诊断环（状态目录 0600，`diagnostics:recent`，字符串被 sanitize 截到 300）；上传给调度中心的完成详情走 `faultDetails` 白名单，不含 `diagnostic`/`context`，测试锁定。

测试 `test/ui-source-context-20261009.test.mjs`（属性失败的前后文与奇异码点、码点级截断与代理项边界、各规则的上下文、上传详情不含上下文）；09-26 的「诊断只含数字」测试改为「诊断可含有界上下文，但上传详情不含页面文字」。

## 核对

- 下次 `invalid_ui_source` 后：`node cli.mjs diagnose --state-dir … --hours 24` 的 `problems` 里该条 `diagnostic.context.before/after/oddCodePoints`。
- 新锁根：启动后 `ls /Users/Shared/StarVoice/android-device-locks/`（一个 `<hash>.lock/owner.json`）。

## 发布

见文末「上线记录」。

## 上线记录（2026-10-09）

| 时间 | 动作 | 结果 |
|---|---|---|
| 09:40 | 发现手机不在（用户手机留在家里），Runner 0.3.1 自 09:40 起 `device_missing`，空闲 | 换版不会打断任务；手机回来前今天手机轮次不会跑 |
| 09:47 | 提交 `195fce9`（main）并推送；`git archive` 生成 `runtime-0.3.2-195fce9`（`release-source.sha`、沿用 `launcher.json`、ASCII 包装 `start.sh`） | 运行目录内 13/13 测试通过；全套 275/275 |
| 09:48:24 | 0.3.1（PID 52965）SIGINT 受控停止 | 1 秒内退出，`deviceClosureRequired=false`、待上传 0；状态库备份 `backups/runner-0.3.1-4a98cec-before-0.3.2-195fce9-20261009.sqlite`（完整性 ok）；旧根 `/tmp/starvoice-android-device-locks` 退出后为空目录，已删除 |
| 09:48:38 | 桌面端终端页签 `bash …/runtime-0.3.2-195fce9/launcher/start.sh` 启动 0.3.2 | PID 56133；`controlError=null`；锁已建在 `/Users/Shared/StarVoice/android-device-locks/<hash>.lock/owner.json`；状态 `device_missing`（手机不在，符合预期） |

待手机插回：探测应自动变为就绪并领取下一轮；0.3.1 的内存重启和本次的解析上下文都在真机上等第一次触发核对。
