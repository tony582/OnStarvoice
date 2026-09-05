# E-base：0.4.5 稳定行为与架构 main 的隔离归并

日期：2026-09-05。此分支是归并候选，不是生产发布，也不是 Extension 架构重构已经完成。

## 输入与实际运行核对

- 架构基点：`main@51896d8694c4b19e3731e5b6b7623397420c84a9`。
- 稳定来源：`85f8d797358e5aa2acf4db51ff1b3c57abe6c594`，与 main 的共同祖先为 `9501925fea143a93ae33b31f019ee1ba978b1694`。
- 2026-09-05 20:22（上海）只读比对：上述稳定来源的 203 个 server JS/JSON/SQL/HTML 文件与生产磁盘全部匹配，差异 0。此范围不包括环境秘密、依赖目录、上传文件或客户数据。
- 生产发布标记及正式更新接口均为 0.4.5；运行进程指向既有 server/index.js，单进程、`PROCESS_ROLE=all`，启动时间仍为 2026-09-02 12:03:09。未重启、修改配置或执行迁移。
- 正式 Extension ZIP SHA-256：`873419d230ad6528e2722a1a7156a3c4486996e35b47caf3dbe9bb24c50d92b8`，与发布清单一致。
- 20:23 的只读聚合显示，近 5 分钟 Chrome/Edge 各 7 个节点有完整心跳，均为 0.4.5。其余历史 active 记录不代表当前在线；这些聚合不等于全部客户业务验收。
- 新工作区从精确 main 创建，只在本地归并上述稳定来源。原工作区、原 extension-build、客户浏览器均未修改。

## 本次范围

这不是单纯的 9 文件 Extension 更新。稳定分支的 9 个提交包含服务端、管理端和 Extension 配套行为，必须按最终行为归并，不能用旧巨型 route 覆盖架构模块。

| 行为 | 在架构中的承接位置 |
| --- | --- |
| Debug 可降级、BEGIN/END 串行、精确 Attempt 恢复与资源回收、无人值守结束回传 | 保持 0.4.5 的 9 个 Extension 源文件及其回归测试；没有新增采集策略 |
| ACK 但未实际启动的 create 有界过期 | postgres-command-reconciliation；保留 task→command 锁序，候选与 UPDATE 双重执行证据判断 |
| 关闭证明从分配门禁变为观测 | cross-device / lease adapters；保留 strict lineage、CAS、资源准入、活跃 source / command 栅栏；local-closure-proof 同步稳定版精确身份与旧版观测规则 |
| 技术失败不冷却整个 Agent；非安全失败最多两轮账户池 | control-outcome-projection 导出统一轮数；route 分配与诊断复用；单 item/账号安全失败继续永久排除 |
| 迟到结果拒绝与唯一冲突有限重放 | record-store、sync；完整 Attempt / requestHash / assignment revision / execution / Agent 验证 |
| 有效 blocking command 和恢复展示 | capture-orchestrations、ops-control、Admin 既有 0.4.5 展示修复 |

PR #30–#36 已完成的模块边界、锁顺序、重校验及实库测试全部保留。尤其 cross-device 的 item/Attempt fence、Profile subscription→execution 锁、旧 Monitor finish 归属保护不回退。没有数据库 schema 变化。

PR #37（Cron 解耦）及 PR #38（R0/E0 与测试时钟）保持独立 Draft；本分支未包含 #37 的运行改动，也未改动它们的远端分支。#38 的两处日期 fixture 修复及 30 天边界测试以独立测试提交复用，不改生产保留期。

## 验证与限制

- 双 Node（24.12.0 / 18.20.8）全量回归：各 1,840/1,840，通过且无跳过。
- 首轮归并回归的两项失败为已知固定终态日期过期；单独复用 #38 的测试修复后全绿。未通过放宽生产保留期改变结果。
- Admin 构建通过；lint 288 errors / 0 warnings，等于现有限额，不声称消除了既有 lint 债务。
- 13 个变更 server JS 文件的未定义标识检查为 0；全部服务端语法检查、仓库卫生与单进程拓扑检查通过。
- 候选工作区独立构建 95 文件快照，与本机既有 0.4.5 交付逐文件相等；未安装、加载、替换客户快照。
- PostgreSQL 本地验证使用全新、仅绑定 loopback 的 PG17 临时 cluster 和两个空白专用测试库，分别通过 Node24 / Node18 全套：各 56/56（拓扑阶段 1 + 集成阶段 55），无跳过。该结果不替代 CI 的 PG14/16 × Node18/24 矩阵；CI结果以PR验收记录为准。
- 新增实库场景：标记但缺关闭证明的 lease 回收与自动接力、旧 revision / 活跃命令拒绝、ACK 未启动及执行证据保护、两轮上限和安全账号隔离、重叠事务唯一领取。ACK 的 SELECT 后注入心跳用例属于同事务 SQL 复核，不冒充双连接竞争；另保留既有双连接锁序回归。
- 独立 AST 复核：稳定 route 的 97 个顶层函数全部映射；85 个函数体直接匹配，9 个保持已核验的 main 架构实现，其余 3 个为已审核的模块/锁序适配。稳定 hotfix 的 17 个变更函数及 11 个常量/handler 无漏迁；安全码数组替代旧 Set 的绑定逐项等价。

本候选尚未完成专用 Chrome/Edge 的代表性场景验收、客户灰度或业务验收。CI通过不授权 Ready、合并或发布。

## 后续顺序

1. E-base 的 Draft 审阅与技术验证收口，另行控制 Ready / 合并 / 发布。
2. E1 再抽离 Extension 执行上下文、状态机和同步边界；不把 UI 或存储模型同时改动。
3. UIUX 独立设计、品牌和素材来源审查后，再以独立变更接入。
4. 与 MediaClaw 的权属、授权和历史共同代码风险继续按 R0 独立审查；模块拆分、改名、换皮或混淆均不代表权属问题解决。

继续禁止生产部署、迁移、split、Extension 客户更新、Ready / 远端合并及处理 PR #29。
