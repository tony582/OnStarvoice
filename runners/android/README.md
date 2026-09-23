# Android 发现执行器

已接通独立手机节点、领取／续期、持久上传、停止和显式恢复；已校准 Smartisan DE106／Android 8.1／抖音 40.6.0。9 月 23 日有限连续任务通过真实手机、既有 PC Extension 和隔离 PostgreSQL 贯通，USB 在复制链接中断后经独立停稳检查恢复；严格保留原时限和作品身份。默认没有 profile 的节点仍不可执行。调度中心现显示恢复检查和实际结束原因，完整进展见 [P0 复测](../../docs/hotfix/20260923-android-p0-validation.md)，上线范围与剩余验收见 [上线清单](../../docs/hotfix/20260923-android-release-checklist.md)。自动重连、长时间稳定性、业务增量和晨巡定时接入尚未验收。

## 环境与模块

Runner 使用 Node 24.12.x，无第三方运行依赖；服务端仍兼容 Node 18。`node:sqlite` 当前会打印 Node 实验性提示，Runner 因此独立锁定版本。Runner 本身不自动安装系统服务、ADB、Appium 或手机应用；本轮 P0 所需工具链已安装至 `~/.local/share/starvoice` 的隔离目录，版本见实机阶段记录。

| 目录 | 职责 |
| --- | --- |
| `src/device/` | ADB、Appium、有界 UI 树、连接检查及 DE106 校准页面 profile |
| `src/calibration/` | 搜索、筛选、详情、分享动作组合与独立作品身份校准 |
| `src/core/` | 单任务动作控制、预算、执行许可、作品证据及设备停稳日志 |
| `src/storage/` | SQLite 事件／回执队列、稳定批次、CAS 检查点 |
| `src/cloud/` | 限时 HTTP、注册与控制协议、幂等交付和退避 |
| `src/daemon/` | 节点配置、设备锁、任务／上传并发循环、进程恢复及停止接线 |
| `src/cli/` | 命令参数、前台启动、显式模拟演示 |

模块上限由边界脚本设为 350 行；Runner 不引用服务端实现，设备层不引用状态机或数据库。业务职责增加时优先拆模块。

## 首次设置与启动

激活码只从环境读取，用于一次注册，不写入本地配置、日志或命令参数。注册得到的节点 token 写入指定状态目录的 `connection.json`（权限 0600）；`identity.json` 保存独立稳定 client UUID。不要把状态目录放进版本库，不要复制同一状态目录绑定另一台手机或服务端。

```sh
# 在当前 shell 安全注入 STARVOICE_ACTIVATION_CODE 和 STARVOICE_CLOUD_URL 后：
node runners/android/cli.mjs setup --state-dir /path/to/private/android-state --serial YOUR_DEVICE_SERIAL
node runners/android/cli.mjs start --state-dir /path/to/private/android-state
```

`start` 是持续运行的前台进程；需要电脑保持运行。它按默认 5 秒间隔领取／检查停止、30 秒续期（许可上限 90 秒），独立每 5 秒上传最多 5 个事件。服务端轮询间隔及 `Retry-After` 可延长等待。网络请求、设备操作均有限时；上传异常不会让界面动作无限重试。

默认未配置 profile 时只上线心跳，`readyForSearch=false`。已校准的试验组合需在首次 setup 时显式指定：

```sh
node runners/android/cli.mjs setup --state-dir /path/to/private/android-state --serial YOUR_DEVICE_SERIAL \
  --device-profile douyin-40.6.0-de106-api27-p0 --adb-path /path/to/adb --appium-url http://127.0.0.1:4723
```

启动前需自行运行已配置的本机 Appium。profile 精确核对机型、安卓版本和抖音版本；版本变化后暂停，不能沿用旧控件。匹配组合且 Appium 可用后，Runner 可领取任务，进入搜索前还会确认抖音前台、已登录且未锁屏。`readyForSearch` 表示本次执行条件，不等于生产验收通过；profile 的 `productionAccepted` 仍为 false。默认综合排序＋一天内，其他四组不限；完整选项见方案 4.1.1。

每个逻辑动作最长 60 秒，单次 UI 层级读取和翻页默认最多 10 秒，其他 Appium 请求保留各自较短时限；搜索由多个有界命令组成。调用方更短的时限和停止信号仍可打断读屏，超时不能当作手机已经停稳，也不能直接解释为 USB 断线。

```sh
node runners/android/cli.mjs status --state-dir /path/to/private/android-state
node runners/android/cli.mjs stop --state-dir /path/to/private/android-state
```

`stop` 只表示已持久发送本地停止请求；需检查 status 中 `running=false` 及 `deviceClosureRequired`。前台按 Ctrl-C 或收到 SIGTERM 也执行受控停止，不安装或修改系统后台服务。

## 停止、断线和重启

每次动作发给适配器前，SQLite 先写“待确认停稳”。正常返回才能清除。停止、超时、断线或进程崩溃期间无法确认当前动作结束时，保留手机锁和证据，不报告空闲。

物理锁使用整台电脑固定目录：macOS／Linux 为 `/tmp/starvoice-android-device-locks`，Windows 为 `%ProgramData%\StarVoice\android-device-locks`，锁名由手机 serial 生成。CLI 不能按用户目录、checkout 或状态目录改变锁根；不接受符号链接根目录。其他用户无权访问现有锁目录时直接拒绝操作，不降级到用户私有锁。锁不会仅因 PID 消失或超时自动释放。

重启不会继续旧 UI 操作或修改旧事件归属。保存中的运行任务先用原 session 和原 attempt 报告 `interrupted`；丢失的完成响应按原 requestId、原请求体重放。正常结束先等当前 attempt 的所有事件收到持久回执再 complete，等待期间继续续期；截止时间到期或许可撤回则转为中断，剩余事件仅作为迟到证据上传。

异常停稳需要独立确认。关闭进程并实际检查手机停止后，将证明写成文件：

```json
{
  "method": "independent_stop_check",
  "evidenceId": "独立检查的记录编号",
  "verifiedBy": "实际检查人",
  "verifiedAt": "检查发生时的 ISO 时间"
}
```

```sh
node runners/android/cli.mjs close --state-dir /path/to/private/android-state --evidence-file /path/to/closure.json
```

不能为绕过锁编造证明。命令检查活进程和锁拥有者，并向服务端确认关闭后释放本地锁。损坏／未知锁不会被自动删除；由状态证据定位问题。恢复任务仍须服务端明确发出新的 attempt 与更高 revision，预算与原截止时间继续沿用。

## 模拟设备联调

不联网演示运行两关键词，生成 4 个来源事件、3 个模拟作品，写入临时 SQLite；它不使用任何真实节点凭证。

```sh
node runners/android/cli.mjs demo
```

可选 localhost 模式使用真实 HTTP 注册、领取、续期、回执及本地持久队列；只有显式 loopback 地址可使用模拟设备。先在隔离本地服务中启用测试租户并创建相应手机节点的任务，禁止把演示假作品接入生产租户。

```sh
# 本地测试环境已提供 STARVOICE_ACTIVATION_CODE：
node runners/android/cli.mjs setup --state-dir /tmp/android-local-demo --serial SIMULATED_DEVICE \
  --cloud-url http://127.0.0.1:3001 --simulation true
node runners/android/cli.mjs start --state-dir /tmp/android-local-demo
# 或一次有界演示（15 秒后停止；任务需由本地管理入口下发）：
node runners/android/cli.mjs demo --cloud-url http://127.0.0.1:3001 --duration-seconds 15
```

没有本地服务或未创建任务时，不会伪报发现结果；demo 的 mode 始终是 `simulation_only`。

## 真机 P0

本轮 Mac + Smartisan DE106（Android 8.1.0／API 27）已完成 USB 授权和工具链连接检查。用户于 9 月 23 日上午把抖音 30.6.0 升级为 40.6.0，当前代码只允许显式选择新版组合。独立旧版校准配置保留原版本，不用旧版 20 条样本冒充新版验收。以下是设备准备流程。

1. 登记手机型号、安卓／抖音版本、主机系统及可传数据 USB 线。
2. 人工授权 USB 调试、解锁并登录抖音。
3. 核对 ADB、Appium、UiAutomator2、SDK／JDK 工具链。
4. 执行只读检查；未指定 serial 时列出设备，绝不自动选择第一台。

```sh
node runners/android/cli.mjs doctor
node runners/android/cli.mjs doctor --serial YOUR_DEVICE_SERIAL
```

`doctor` 的 `readyForP0` 仅代表连接清单通过，其 `readyForSearch` 仍为 false；实际就绪由已显式配置的 Runner profile 检查。当前自动搜索只用于隔离试验，扩展生产前仍需完整作品身份、恢复和稳定性验收。Windows 可指定 `--adb-path` 和 `--appium-cli-path`；Appium 控制面仅允许 loopback。

Finder 的“位置”不是 Runner 的连接状态。排查手机是否仍连接时，先核对指定设备的 ADB 状态，再看 Runner 的就绪检查和任务日志；9 月 23 日出现过 Finder 未列出手机、USB 设备树与 ADB 仍在线的情况，实际停止原因是 5 秒读屏误超时。不要仅凭 Finder 侧栏消失就要求拔插。

## 单次上传维护命令

注册后的 start 自动管理交付。保留 `deliver` 和 `retry-delivery` 供开发排查；它们从 `STARVOICE_CLOUD_URL`、`STARVOICE_AGENT_TOKEN` 环境读取凭证，每次处理至多 5 条，不能与 daemon 同时维护同一状态目录。

```sh
node runners/android/cli.mjs deliver --state-dir /path/to/state
node runners/android/cli.mjs retry-delivery --state-dir /path/to/state
```

事件、固定 uploadBatchId 与退避状态均持久保存。先查询已落库回执再补传，网络重试不重做 UI。身份冲突／鉴权失败保留队列并要求处理根因；候选不是正式记录，不计入日报。

## 服务端短链 DNS

默认仍使用系统 DNS。若当前网络将 `v.douyin.com` 解析为代理合成地址（例如 `198.18.0.0/15`），后端会保留事件并显示“链接域名解析到了受限地址”，不会把它计为入库成功。

可在需要的测试后端进程启动前显式设置 `ANDROID_DISCOVERY_DNS_MODE=google-doh`；不设置或设为 `system` 时维持原行为，其他值拒绝启动解析器。该开关属于服务端，手机 Runner 无需设置。它只向固定的 Google HTTPS DNS 地址发送白名单平台域名和 A 记录查询，不发送作品链接、正文或凭证；查询禁止重定向、每次尝试最长 1.5 秒、响应上限 64 KiB，按 CNAME 链最短 TTL 缓存且最多 60 秒。协议依据 [Google JSON API 文档](https://developers.google.com/speed/public-dns/docs/doh/json)。

查询结果继续通过既有公网 IP 检查、固定目标 IP 的 HTTPS 请求、证书校验和官方重定向白名单；私网、回环和代理合成地址一律拒绝。失败原因区分 DNS 受限地址、DNS 查询失败和后续短链跳转失败。临时网络故障、HTTP 临时错误或有效 SERVFAIL 最多额外重试一次，默认退避 100 ms；上游要求更长等待时尊重 Retry-After，超过 1 秒则保留为待处理。完整短链解析仍最多 3 秒；错误或不安全答案不作为放宽地址验证的理由。此设置不修改操作系统 DNS／代理，也未在生产环境启用。

## 验证

```sh
npm --prefix runners/android test
npm --prefix runners/android run check:boundaries
```

早期含 DNS 修复的定向测试 146／146 通过；此前停止原因修正后相关 daemon 12／12 复测通过；详情数据库事务集成 13／13 通过，Admin TypeScript 检查通过。覆盖六组筛选、重复选项分组、复制成功弹层、剪贴板恢复、身份不匹配回滚、未确认会话关闭和收尾期间停止。模块边界检查覆盖 79 个模块，最大 264 行，上限 350。旧版的 97 项结果保留于阶段记录。

本机系统 DNS 仍返回受限地址；测试后端可显式使用上述 HTTPS DNS 模式，地址防护未放宽，不代表系统或生产解析环境已修复。早先独立校准使用 HTTPS DNS 得到的公网地址完成真实短链解析。20 条真实公开证据通过 SQLite、HTTP 和隔离 PostgreSQL 回放：候选先不写正式记录、严格详情接收后正式记录 20 条、重复回放不增行、错误作品编号拒绝。该 20 条回放不运行 Extension UI；另在独立 `StarVoice P0` 配置运行真实 Extension，3 条作品自动补详情成功，登录后两次复采仍保持 3 条正式记录，昵称表情及正文 @ 官方作者归属已核对。实际测试包为 `/private/tmp/starvoice-p0-local-extension-20260923`，业务 API 为 localhost；生产 `extension-build/` 未修改。

另已通过真实控制面贯通：隔离 PostgreSQL + 真实租户管理员 session／节点令牌 + HTTP 注册／创建／领取／接收／完成 + Runner SQLite，仅手机 UI 为模拟；两个关键词产生 4 个 normal 来源事件，outbox 清空，候选未被计为正式记录。该测试需在受保护的测试数据库上单独运行：

```sh
# DATABASE_URL 与 TEST_DATABASE_URL 必须明确指向同一个已允许的隔离测试库。
npm --prefix runners/android run test:integration
```

该验证不代表真机采集、页面稳定性、生产部署或全部业务测试完成。产品管理及浏览器补详情由服务端／Extension 对应模块接入，接口和实施范围见 [整体方案](../../docs/hotfix/20260922-douyin-android-discovery-plan.md)。

2026-09-23 最新真机补充：40.6.0 综合排序＋一天内，两关键词各 3 条产生 6 个真实事件、5 个不同作品。修复内嵌展开及既有 PC 图文范围后，另一次 6 条连续发现零重试交付（5 复用、1 新入库）。真实复制链接中 USB 断开约 39 秒，停稳核验后显式恢复同一任务，恢复获得 3 条，按原关键词 10 分钟预算有界结束；待传为 0，无重复记录。自动重连、全天稳定性与发现率对照未验收，详见 [P0 记录](../../docs/hotfix/20260923-android-p0-validation.md)。


9 月 23 日傍晚连续试跑另见[固定版本验证](../../docs/hotfix/20260923-android-soak-validation.md)。已修复作者标记、正文表情、认证昵称、手机补采标签页收尾及读屏／翻页误超时，均保留对应失败及回归证据；最新 Node 24.12.0 Runner 全套 118 项通过，模块边界 82 个、最大 264 行；有限回归不代表已通过长时间稳定性或生产发布。
