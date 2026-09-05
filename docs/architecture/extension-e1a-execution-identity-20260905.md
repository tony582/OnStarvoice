# E1a：Extension 执行身份纯函数抽离

日期：2026-09-05。隔离开发候选，保持 Draft；不是生产发布、性能修复或完整 Extension 架构重构。

## 基点与范围

- 精确基点：E-base PR #39，`bc2fc9d0adb36e5997383087bc5cb2222369e291`。
- 新分支：`codex/extension-e1a-execution-identity-20260905`；PR 以 #39 分支为 base，审阅差异仅包含本步骤，不修改 #39。
- PR #37 的 Cron 解耦、PR #38 的 R0/E0 候选继续独立保留；本步骤不修改这些分支，也不包含 #37 的运行改动。
- 从 `background.js` 原样搬出 7 个纯函数至 `utils/capture/execution-identity.js`：tab ID 归一化、稳定无人值守任务 ID 的构建/解析、Attempt 锁归属、停止身份的构建/匹配、运行快照身份匹配。
- background 通过必需的同步 `importScripts` 加载并绑定原函数名；不保留重复实现或静默 fallback。
- 没有搬移可变状态、计时器、任务队列、Chrome 事件处理或存储操作。没有改变消息协议、存储键、schema、平台等待、并行度、重试、采集/同步规则、manifest、权限或版本号。
- 本次为 5 个实现/测试文件及本文档；UIUX、品牌素材、混淆和权属问题不在这个实现差异中。搬家或换皮不代表 MediaClaw 相关权属风险已经解决。

## 保留的兼容边界

- 请求必须有 request ID 和 Attempt；显式旧 Attempt 仍拒绝。
- 旧版稳定 task ID 且锁 Attempt 为空时，仍按原规则兼容。
- 历史生成的 child task ID 保留精确 Attempt 匹配。
- 尚未绑定任务的 reservation 仍必须精确对应 runner tab，不从全局锁推断归属。
- 停止身份中的锁、owner、holder、document、tab、task、Attempt 任一变化都会拒绝旧身份。
- 快照仍同时匹配 task、run、Attempt 和有效 source tab；旧快照的空 Attempt 兼容保持原样。

## 本地验证

- Node 24.12.0 与 Node 18.20.8 全量回归各 **1,852/1,852**，无失败、跳过或取消；比 E-base 增加 12 条。
- 新增 10 条纯函数测试和 2 条 runtime contract；原有 35 条 runtime contract 的测试 AST 未改。background VM 仅增加新模块预加载。
- 独立 AST 复核：7 个函数完整 AST 与基点一致；去除搬移部分和新绑定/import 后，background 剩余 83,421 个 token 完全一致。
- 独立故障注入：模块加载失败或缺少全局导出均在 Chrome 访问/监听注册前停止，不会绕过身份检查继续执行。
- 语法检查、差异空白检查与独立 Extension 交付快照检查通过。快照从 95 文件变为 96 文件，增加必需的新模块；既有交付文件只改变 background。
- 服务端代码与数据库 schema 不变。本步骤没有重跑本地数据库 cluster；远端 CI 的隔离 PostgreSQL 矩阵结果另以 PR 精确 head 的检查为准。

## 隔离浏览器验收

使用单独 QA 工作区的既有 browser harness，并为它增加启动前生效、默认拒绝的本地 fixture 代理；未改客户工作区、客户 Extension 快照或用户浏览器 Profile。QA 工具改动及输出留在独立工作区，不属于本步骤的运行代码。

| 测试快照 | 浏览器 | 轮次 | 每轮通过场景 |
| --- | --- | --- | --- |
| E-base，95 文件 | Chrome for Testing 151.0.7922.34 | 2 | 9 |
| E-base，95 文件 | Edge 152.0.4191.66 | 1 | 9 |
| E1a，96 文件 | Chrome for Testing 151.0.7922.34 | 1 | 9 |
| E1a，96 文件 | Edge 152.0.4191.66 | 1 | 9 |

场景为：扩展加载、BEGIN/进度、浏览器原生任务页组与工作页、等待倒计时、小红书 fixture 标记、正常 END 清理、抖音 fixture 标记、页面刷新后标记恢复及错误平台拒绝。Chrome 任务面板与 Edge 倒计时截图已人工查看。

每轮使用新临时 Profile、本地 HTTPS fixture、无登录凭据。代理只将固定 fixture host + 临时端口转发到 127.0.0.1；生产更新 CONNECT 请求已实际被拒绝。NetLog 未观察到成功的非 loopback 连接；同时保留浏览器失败的 IPv6 路由探测记录（负错误码、无发送字节事件），不将 HTTP 代理描述为进程级封包隔离。最初 macOS 外层 sandbox 方案因浏览器原生 sandbox 冲突而在 Extension 启动前失败，已弃用；没有关闭浏览器原生 sandbox。每轮均退出自己的测试浏览器并删除自己的临时 Profile。

验收限制：不是客户账号/真实平台端到端采集、真实 AI/同步、8 小时内存测试、72 小时稳定性验收；没有在浏览器内实际终止并恢复 MV3 worker，也没有验证停止响应时间、旧 Attempt 迟到 END 竞争或移除 debugger 权限。现有 manifest 保留 debugger 权限；“Debug 可降级”不等于无此权限仍能启动。

## 下一道门

本步骤提交、推送、新建 Draft PR 并等待 CI 后停止，不自动 Ready、合并或发布。下一步先明确状态读写和同步提交的契约，再按小模块拆离；不同时重写状态机、存储模型和 UI。客户灰度、发布及 UIUX/权属审查仍须分别验收和授权。

继续禁止部署、生产迁移、生产 split、客户 Extension 更新及处理 PR #29。
