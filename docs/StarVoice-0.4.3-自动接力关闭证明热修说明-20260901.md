# StarVoice 0.4.3 自动接力关闭证明热修说明

日期：2026-09-01
分支：`codex/hotfix-unattended-local-closure-20260901`

## 事故结论

本次 12/13 停滞不是采集结果丢失，也不是没有空闲 Agent。原 Agent 在抖音搜索安全验证后已经完成结果同步，但 Extension 没有持续重试清理当前 attempt 遗留的本地锁、调试会话和任务页，因此未能回传可验证的 `localClosure`。服务端为防止同一关键词在两台设备同时执行，正确阻止了后续 Agent 接力。

同时存在两个观察面问题：重复终态心跳会把复查时间持续改成“当前时间 + 60 秒”；值守页把受阻动作表现成跳过或自动恢复，掩盖了真正的关闭证明阻塞。

## 修复内容

### Extension

- 只识别并清理当前 request/attempt 精确拥有的无人值守锁。
- `cancelCapture` 的应答不再等同于“已经停止”；后台会按精确 `captureRequestId` 复查 content 活动状态。
- 同一 `captureRequestId` 因重发产生并发调用时按引用计数跟踪，必须全部结束才判定停止。
- content 无法提供活动状态时，只允许对精确拥有的来源页执行硬刷新，并且必须观察到同一页完整的 `loading -> complete` 周期。
- 关闭证明分为“来源已停止”和“运行资源已释放”两阶段；只有第二阶段成功才允许回传。
- 终态 heartbeat 每次都重试当前 attempt 的稳定任务资源清理。
- 只有锁、Debug、任务分组、worker、owner、任务页和同步 outbox 全部排空后，才生成关闭证明。
- 已绑定锁却无法验证来源、锁身份在清理期间变化或后续 attempt 替换来源时，一律保留锁并失败关闭。
- 无关任务或后续 attempt 的新锁不会被删除，也不会误阻塞旧 attempt 的关闭证明。

### Server

- 同一 Agent、同一 attempt 的重复终态心跳保留首次复查锚点，不再制造滚动倒计时。
- 新 attempt 或换 Agent 会获得新的复查锚点。
- 等待关闭证明的工作项进入 `sourceClosureBlocked` 事实口径，受控恢复动作标记为 `blocked`，不再显示为 `scanned=0` 或 `skipped`。
- 继续保留防双跑门禁；没有精确关闭证明时不会强制下发接力任务。

### Admin / 值守

- 分开显示“进行/等待”“自动恢复”“需人工”“失败”。
- 明确显示“等待原 Agent 关闭确认”，并解释已采集结果仍保留。
- 到达复查时间后，没有真实待领取命令时显示“等待服务端重新评估”，不再假称“正在等待 Agent 回报”。
- 值守页区分“恢复已完成”和“恢复阻塞”；只有后续快照确认任务完成才计入恢复完成。

## 本地门禁

- Node 24 定向回归：353/353 通过。
- Node 18 定向回归：353/353 通过。
- Node 24 全仓回归：1670/1670 通过。
- Node 18 全仓回归：1670/1670 通过。
- Admin TypeScript 与生产构建通过。
- Admin lint baseline 通过，未增加既有 lint 债务。
- Extension 生产快照校验通过：95 个文件，版本 0.4.3，生产 API 为 `https://voice.minilife.online`。
- 生产安装包已在本地生成：`release/StarVoice-extension-v0.4.3-20260901.zip`，共 108 个 ZIP 条目，SHA-256 为 `a71b9b6a481dc0d840a1beca74b600474a03c0fbf2780ece2c51988fa9d23dcc`。

## 发布后验收

以下项目必须在服务端与原 Agent 都更新到 0.4.3 后，以真实任务验证；本地测试不能替代：

1. 原 Agent 的终态 heartbeat 带回当前 item attempt 的 `localClosure/localClosures`。
2. 后台工作项从 `waitingForSourceClosure` 离开，并创建新的接力 attempt/command。
3. 未尝试且空闲的 Agent 领取该关键词，原 Agent 和后续 Agent 不发生双跑。
4. 父任务从 12/13 收敛到真实终态；若接力失败，页面按失败或需人工展示，不伪装成成功。
5. 值守页在阻塞期间显示“恢复阻塞”，只有后续快照验收完成后才增加“恢复已完成”。

当前文件记录的是 hotfix 候选代码和本地门禁证据，不代表已推送、已合并、已部署或客户设备已验收。
