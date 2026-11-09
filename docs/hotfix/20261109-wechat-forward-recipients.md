# 视频号发到微信接收人配置与多选

系统设置增加「视频号发到微信」，管理员按采集手机微信中的备注或昵称维护接收人名单，每行一个，最多 20 个。内容详情的「发到微信」从当前客户的名单中多选，每位接收人生成独立发送任务，并显示各自最近一次状态。选择记忆按客户和登录用户隔离。

## 行为与兼容

- 配置存于当前租户 `tenant_settings.wechat_forward_recipients`。保存时统一空白与 Unicode、去重，非法名称或超额整份拒绝，原名单保持不变。新建客户不复制其他客户的接收人。
- `POST /api/capture-cloud/android/wechat-forwards` 接受 `{recordId, recipients: [...]}`，返回 `{forwards: [...]}`。仍接受旧页面的单个 `recipient` 字段；旧页面忽略返回内容，随后重新查询状态。
- 多选请求先检查全部接收人是否获准，再在同一事务中创建任务；非法请求不留下部分任务。同一租户同一帖子采用事务锁，防止不同顺序并发多选发生互锁。同一帖子与接收人在排队或发送中复用原任务。
- `GET` 返回配置名单与每位接收人的最近状态，历史重复记录不会挤掉当前 20 人中的任务。每人仍只尝试一次，不自动重试；未看到发送提示明确标为待人工核实。
- 页面直接显示 POST 返回的受理结果；随后查询失败不会把已排队误报为未发送。网络中断时提示先核实状态或微信聊天，再决定是否重新发送。

## 发布边界

基线 `97583fa`。本轮仅四个服务端文件与 Admin 构建，重启 `onstarvoice-api`；无数据库迁移，手机采集器保持 `0.4.7`。发布脚本位于 `scripts/releases/wechat-forward-multi/deploy.sh`，逐文件比对生产基线与 Admin 入口哈希，备份后替换；检查失败恢复旧文件与入口。保留旧的静态资源供已打开的页面使用。

生产环境为 `voice.minilife.online`，OnStar 测试客户与安吉星业务客户分别保存配置。真机共用手机 `829d89`，两套采集器不可同时运行。完成 OnStar 真机验证后需停止测试采集器，并恢复安吉星的 `runtime-0.4.7-97583fa/launcher/StarVoice 手机采集.command`。

## 验证

- 服务端完整回归：`npm test`，3551/3551 通过，包含正式扩展快照前置检查。接手时旧日志缺少快照导致的 3 项失败已通过正确入口消除。
- 独立本机 PostgreSQL：`onstarvoice_test_wechat_multi_20261109`，12/12 通过。覆盖名单格式、事务原子性、租户隔离、20 人状态、并发反序请求去重、旧请求兼容、真实 HTTP 设置与权限、新客户不继承名单。
- Admin 构建、转发组件 ESLint 通过。真实本地后台验证：配置保存去重、空选禁发、两人提交分别排队、成功选择记忆、取消不覆盖记忆。使用本地隔离数据库，没有向手机发送。
- 发布与真机结果单独记录；本地证据目录为 `outputs/wechat-forward-multi-20261109/`，UI 截图在工作树 `output/playwright/wechat-forward-multi-20261109/`。

## 生产发布与真机验收

- 功能提交 `1ade51e3b9f4625e6e17675f9135d0307177f84b`，已推送 `codex/feat-wechat-filters-20261109`。2026-11-09 **14:54:04 +08:00** 发布完成；逐文件与静态资源哈希核对通过，公开 HTTPS Admin 入口与本次构建一致。仅 API 重启；scheduler 和 ai-media 保持原进程。
- 生产发布与回滚证据：`/opt/onstarvoice-private/releases/wechat-forward-multi-1ade51e3b9f4-20261109/`。本轮无数据迁移；OnStar 与安吉星分别配置「金明Tony」「文件传输助手」，没有改其他租户的设置。
- **14:54:46** 在 OnStar 对已有萧枫帖子 `8fe30da6-32c0-4d28-b69d-e29e56ac69eb` 提交一次两人多选。两条任务均由原 0.4.7 手机采集器执行，最终 `completed / forward_sent`，手机实际捕捉到发送成功提示。本轮给两位接收人各新增一张卡片，没有重试或额外重复发送。
  - 金明Tony：`f4d10068-a36c-4836-b3fe-fe3edb3763d0`。
  - 文件传输助手：`ce6e83c7-c007-4570-ba4f-ddcc5f843c78`。
- 验收后 OnStar 测试采集器正常停止、释放设备锁。**14:57** 安吉星 `runtime-0.4.7-97583fa` 恢复 `running=true / ready=true / controlError=null`，生产心跳确认 `wechat_forward` 能力，抖音与视频号均就绪。
- 安吉星当时没有视频号记录，因此真实发送验收使用 OnStar 的现有帖子；没有将测试内容导入安吉星。安吉星配置及手机就绪已确认，业务内容产生后的首条真实发送仍属于后续使用验收。
- 功能提交的 [GitHub CI](https://github.com/tony582/OnStarvoice/actions/runs/42575844752) 五项作业全部成功：测试与构建、生产 Node 24 兼容性、PostgreSQL 14 / Node 24.12.0、PostgreSQL 16 / Node 24.12.0、PostgreSQL 16 / Node 24；集成作业也完成手机采集器对真实控制面的检查。本条发布记录为纯文档补记，不改变已部署代码。
