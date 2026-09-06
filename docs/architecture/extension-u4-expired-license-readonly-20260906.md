# U4：业务授权到期后可看历史、不可新采集

日期：2026-09-06。基点为 Draft PR #51 / `f4355392bffd18621395c547ebbd4737fdd0a5da`。分支 `codex/extension-u4-expired-license-readonly-20260906`，工作目录 `OnStarvoice-extension-u4-20260906`。

## 用户决定与发布边界

用户已确认：**“继续，可以查看历史，但不能新采集”**。此前问题明确限定身份仍有效的原客户可只读、禁止新采集和写入、冻结或撤权不放行。

本批落实可执行的独立权限策略及 U3 读取许可桥，以人工事实和假数据组合测试。不是生产权限更改，没有调用真实认证服务、客户存储或采集命令；没有修改旧侧栏、运行源码、服务端路由、数据库、构建白名单或客户包。Ready、合并、部署、迁移、split、客户 Extension 更新及 PR #29 继续禁止；旧 Draft PR 保持原样。

“历史可查看”不等于所有数据可读。每次仍需核实主体、会话、租户成员资格、设备资格及精确历史范围。业务许可证、登录会话和读取许可是三类不同期限。

## 权限矩阵

| 可信事实 | 历史摘要/详情 | 新采集 |
| --- | --- | --- |
| 身份与范围有效，业务授权有效，两项能力明确允许 | 允许，限读取许可期限 | 允许的纯策略决定，仍须执行端检查 |
| 身份与范围有效，业务授权到期，历史读取明确允许 | 允许，不能把业务到期时间当作读取到期时间 | 拒绝，`license_expired` |
| 业务授权仍标为 active，但其到期时间已到 | 按到期后的只读规则 | 拒绝，不能相信过时 active 标记 |
| 身份/会话失效，租户/成员/设备冻结或撤权 | 拒绝 | 拒绝 |
| 业务授权 frozen/revoked，或状态未知/矛盾 | 拒绝 | 拒绝 |
| 历史范围不匹配，事实不新鲜，缺字段或访问器字段 | 拒绝 | 拒绝 |
| 历史读取能力明确为 false | 拒绝 | 单独判断，不能从历史读取决定推导采集能力 |

到期边界均为 `now >= expiresAt`，不使用时间宽限、当前账号回退、模糊 ID 或跨租户查询。`expired` 却带未来业务到期时间视为矛盾，暂不猜测原因。

## 最小新契约

`evaluateAccessPolicy(facts, request, now)` 是纯函数：

```js
const request = {
  principalId, sessionId,
  scope: { tenantId, taskId, executionId },
  snapshotId, recordNamespace // client_record 或 server_record
};
const facts = {
  ...request,
  accessRevision,
  identityStatus: 'active', tenantStatus: 'active',
  membershipStatus: 'active', deviceStatus: 'active',
  licenseStatus: 'active', // active / expired / frozen / revoked
  licenseExpiresAt, sessionExpiresAt, evidenceExpiresAt,
  historyReadAllowed: true, captureAllowed: true
};
// 冻结输出，不含原始事实、身份或令牌：
// { state: active | expired | blocked,
//   history: { allowed, reason, expiresAt },
//   capture: { allowed, reason, expiresAt } }
```

- 所有身份使用既有精确 ID 契约；只读 own-data 字段，不执行输入 getter、继承字段或对象字符串转换，不冻结/修改输入。
- facts 是可信供给方的结论，不是任意客户端可提交的授权声明。字段匹配不证明真实身份、归属或签名；不得把当前租户、当前任务分配、最新 trace 或旧 `synced` 拼成 facts。
- `evidenceExpiresAt` 必须是**身份、租户、成员、设备与精确历史范围等所有事实有效期限的最小值**，不是简单的缓存时间或当前时间加固定时长。`sessionExpiresAt` 是会话截止时间，二者再次取最小值。
- `accessRevision` 必须由可信供给方在主体/会话/租户/范围/冻结/撤权等任何安全上下文变化时更新。不能只填许可证版本、当前时间或通过有碰撞的字符串拼接生成。主体与会话另外在桥实例中固定校验。
- 历史读取有效期是 `min(sessionExpiresAt, evidenceExpiresAt)`；新采集决定有效期再加上 `licenseExpiresAt` 的约束。业务到期不会延长会话/范围读取权。
- 未知、继承、访问器、异常类型或矛盾值保守拒绝，输出固定原因 `access_unavailable`；允许/能力不足/业务到期分别为 `allowed`、`not_permitted`、`license_expired`。稳定键供未来独立文案使用，不直接照搬旧 UI。

## U3 读取许可桥

`createHistoryReadAuthorizer({ identity: { principalId, sessionId }, readAccessFacts, now? })` 返回 U3 的 `authorize` 函数。

1. 构造固定主体/会话 + 精确请求范围，校验原生取消信号。无效请求不调用事实供给方。
2. 每次调用可信 `readAccessFacts({ principalId, sessionId, scope, snapshotId, recordNamespace, signal })`，不缓存前一次授权，不回退旧身份。供给方必须核实这些身份与会话仍是当前有效上下文，不能仅按请求参数找到一份尚未到期的旧会话就放行。
3. 事实返回后立即复制有界白名单，独立计算历史读取决定；等待期间发生的会话到期/撤销必须反映在新事实或有效期限中。
4. 发出 U3 grant：`{ allowed: true, scope, snapshotId, recordNamespace, accessRevision, expiresAt }`。期限为读取事实有效期与当前时间后 30 秒的最小值；溢出、无效时钟、到期或取消均拒绝。
5. U3 继续执行读取前后两次核验、相同授权世代检查及发布时期限检查。仅业务到期且读取事实仍有效时可返回历史；身份/事实到期或世代改变时不得发布。

桥失败固定抛出 `Error('History read unavailable')`，不传原错误、facts、cause 或凭据。配置错误为固定 `TypeError('Invalid history authorizer configuration')`。30 秒是本地 grant 的有效期上限，不是 30 秒内必定得知撤权的保证。它没有实时撤权订阅或自身超时；不合作的供给函数只能由 U3 的取消/超时隔离迟到结果，不能被本函数强行结束。

未来宿主在退出、换账号/任务、冻结或撤权时仍必须关闭 U2/U3、丢弃旧选择并清理已展示敏感内容。已经返回的 DTO 无法事后追回；UI 更新前仍检查 `isCurrent`。这不是任意恶意同进程代码的安全沙箱。

## 尚未接线及下一步

- 真实身份/会话/历史范围事实源仍未实现；生产旧认证存在读取时写回路径，不能直接复用，需单独审查与审批。
- 策略中 `capture.allowed` 只是当前历史读取上下文的产品可用性决定。其 request 包含既有快照，**不是新采集的命令请求模型**。真正创建即时/批量/定时任务或到点下发计划、继续/重试采集时，执行端仍需独立目标能力、参数及实时权限检查，不能只禁用按钮，也不能沿用点击时尚未过期的结果。
- 历史只读不授予同步、删除、关注、重采、继续采集、自动重试或导出。对到期时**已经运行**的任务，本批不停止、不延续、不改保存/结算规则，避免凭“不能新采集”扩大为强停客户任务。
- UIUX 接口缺口仍需逐项收口：历史 unknown 与可操作问题分离、真实任务进度/停止状态、平台能力/筛选与扩展指标、单条作品与任务聚合的不同身份。候选 A 已交付，不再把“设计未完成”当作这些工作的前置阻塞。
- 本地交互原型之前被浏览器安全策略拦截，Figma MCP 额度不足，本批不绕过、不修改设计或宣称完整交互验收。UI/共同代码完整区分和权属审核未完成。

## 验证记录

本地验证已完成：

- 新增策略测试 149 项、许可桥及 U2/U3 组合测试 82 项，合计 **231/231**；Node 24.12.0 与 18.20.8 均通过。
- 全量回归两套 Node 环境各 **2433/2433**，无失败、取消或跳过。日志：`/tmp/onstarvoice-u4-node24-final-20260906.log`、`/tmp/onstarvoice-u4-node18-final-20260906.log`。
- 独立审阅及人工数据 smoke 通过业务到期、身份/租户/成员/设备撤权、会话/世代变化、在途期限和共享输入变异检查，未发现阻断性问题。
- 静态边界 12 模块通过（core-only、无 UI 入口）；卫生检查 759 源文件通过；服务端语法检查及 diff 空白检查通过。运行源码、server、构建和 CI 脚本无变动。
- U4 隔离快照与 U3 相同：95 文件 / 0.4.3 / 清单 SHA256 `c5040350bd8f8731c5375b958f7147b76c3b65c9c580c49fba504ea3cd28c0c2`。
- 客户本机参考包未变：95 文件 / 0.4.5 / 清单 SHA256 `554479f7e01198ba0e6f7c2eb3d16e58c55db773aaadad90ecea5d6b039d1f87`。没有生成 ZIP、重载扩展或执行生产采集。

清单摘要算法沿用 U3：相对路径排序，每行 `路径\t文件SHA256\n`，再对清单求 SHA256。本地文件比较不是生产运行版本证明。远端提交与 Draft CI 是提交后的独立门槛，实际结果以交付报告为准，不替代浏览器、生产或客户验收。
