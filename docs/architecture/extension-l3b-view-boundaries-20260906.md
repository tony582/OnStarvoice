# L3-B：剩余任务域与视图、命令边界收口

## 精确输入与本批约束

实施前登记。父提交为 PR #56 最终 `2c997709c0a4223784901aeaa461fab46108ba8b`，OPEN + Draft + CLEAN、精确 head push/PR 共 12/12 已重新核验；main 仍为 `51896d8694c4b19e3731e5b6b7623397420c84a9`。
新隔离工作树 `OnStarvoice-extension-l3b-20260906`，分支 `codex/extension-l3b-view-boundaries-20260906`。已有 L3-A 和其他 Draft 不改；原脏工作树、客户参考目录不改。

本批属于既定 L3-B，不新增 U/helper 功能线，不把局部完成改称整个 L3。允许隔离本地修改、离线/模拟验证、提交、普通推送、新 stacked Draft 及精确 head CI。禁止 Ready、合并、部署、迁移、split、客户 Extension 更新/安装/Reload、真实鉴权/客户数据 API/新采集及处理 PR #29。

## 职责和退出清单

1. 剩余关键词分析/机会/对标/扩词、平台草稿、计划/run、排序任务域按完整状态闭包迁移，不只迁四个按钮。四项 L3-A 宿主实时绑定退出，由明确任务状态 owner 持有；只读投影不暴露可写状态袋。
2. 监控设置/订阅及尚在宿主的 runner/date/终态策略一并盘点；监控数据继续由既有 `state.js` 唯一拥有，不复制一套 store 或调度器。
3. 旧界面 DOM/控件、焦点、显示文案、分享图片等进入明确的 legacy-view 适配层。应用域使用输入值、输出投影及具名视图能力，不将 DOM 换名后继续传入核心，不向核心返回 DOM 节点；保留读取时机、旧字段、等待及业务顺序。Chrome 序列化工作页函数是平台执行，不误算 Sidebar 视图，平台规则留 L4。
4. 旧任务动作路由拆开显示信息、命令目标、实际执行。历史 taskId/展示关联不得冒充可信当前 Attempt/owner；原采集/停止/收尾和读取取消分别记录，不提前显示业务完成。

精确父提交审计得到 216 个剩余原函数：初分 137 应用/规则、79 目标旧视图 owner（混合点必须进一步切开）；36 项状态初分 30 应用与 6 视图。包括 20 项 monitor runner/date/terminal policy；共享的 `escapeHtml` 及两项 auth response helper 留宿主。宿主初始化、runtime subscription、输入事件和页面类型更新中的写入也必须转具名操作，不能只搬函数声明留下旁路。
实际边界可以因混合函数切开而增加具名接口，但原 216 函数必须逐项核对唯一 owner；上述完整职责是完成门，不靠行数或测试数替代。

独立复核后的必要补齐（本批范围内）：原 `renderKeywordPlanStatus` 不再由 view renderer 隐式触发状态清理，转应用编排，纯标签显示另有 view 方法；原 216 项最终分属 138 应用/78 视图。另补迁宿主 `showProgress`、`hideProgressPanelOnly` 两个公共进度入口，其 DOM 判断和任务状态清理也需分开，作为额外 2 项明确登记，不暗改最初 216 项分母。读取时机、原节点、先显示后清理等顺序按精确父配对，不改后台取消/恢复规则。

## 已发现的必要前置：原子命令围栏

L3-A 基点旧 `handleTaskCenterAction` 只拿 action/taskId/raw 历史项；stop 会将 taskId 当 requestId，失败时还能回退当前诊断任务。后台 recover/cancel 路由不贯穿预期 Attempt，虽然底层 mutation 已有部分 Attempt 支持。
因此“先读当前状态、在 Sidebar 判断、再发旧取消”仍有同 request 新 Attempt 的读写竞态，不构成完整安全命令。

深入核对发现取消的归档删除、terminal cleanup、锁快照后的泛化 relay、计划重排均可在 request mutation 外发生；恢复的 prepare/同步、旧锁回收及开页也跨现有两条队列。甚至 `readActiveCaptureExecutionLock` 会清理过期资源，不是纯读；旧 attempt ownership 谓词兼容空 attempt/tab 重合，不能当严格证据。
因此本轮**不修改后台取消/恢复执行链**。先完成原任务域与视图职责迁移；后续仍须把旧命令迁入独立 legacy application adapter（本批尚未迁出），且不得向新视图开放该 adapter，不将“发送成功”变成“已停止”。严格命令消费者在缺失可信目标、当前权限或原子执行端时必须明确拒绝，禁止回退旧入口。真实身份供给继续属于 L3-C，后台原子围栏须独立范围与审批后实施，不能以仅加参数假收口。
这保留了 B 的原子命令执行缺口：结构职责迁移完成也不能标整个 L3-B 或 L3 完成。完整围栏是有意的行为收紧，须单列锁顺序/资源竞态/旧消费者兼容测试，不得混入“全部原行为 AST 等价”的结构迁移声明。

## 验证计划与保留门

- 保存精确父提交的函数/状态/副作用清单；结构迁移按 AST/依赖/调用次序对照，有意变化逐项单列。
- 原测试真实定位当前 owner，保留原场景；新增实际模块和宿主装配、输入/输出边界、旧 Attempt/owner/延迟消息、停止失败及权限失效测试，不构造伪旧大文件。
- Node 24/18 官方递归全量、语法、快照、仓库卫生、独立代码与文档核读、精确 head 两组 CI。
- 当前客户参考快照仍是 95 文件/v0.4.5，清单摘要 `554479f7e01198ba0e6f7c2eb3d16e58c55db773aaadad90ecea5d6b039d1f87`；只读复核，不构成客户实装版本证明。
- 不启用 E1e/E1i producer，不把远端接受/本地确认失败的既有问题顺带算作修复。U5/新 UI 的实际接线与可信历史权限在 L3-C；真实浏览器/性能/长期验收及客户发布仍另需授权。
- 统一 L1–L6、服务端 PR #37/G3、暂停 P4–P6 和 P8/G8 退役门继续保留，不因 Extension 提前而丢掉旧计划收尾。

## 实际进度

隔离源码已接线，本地最终回归和独立审查通过，进入提交/普通推送/新 stacked Draft 及精确 head CI 阶段；远端结果单独记录，不能沿用父提交 CI 作为本批通过证据。

| 职责 | 当前 owner 与边界 | 验证状态 / 尚未完成 |
| --- | --- | --- |
| 平台草稿、关键词分析/机会/对标、扩词、计划/run、排序 | `task-controller/keyword-{drafts,analysis,strategy,plan,sort}.js`；30 项任务状态移入 `keyword-state.js`，与原 62 项由同一 controller 实例拥有 | 4 项宿主 live bindings 已退出；草稿控件用冻结会话保留原节点及晚读取时机；仍是旧流程的兼容读口，不是深不可变新 UI DTO |
| 监控订阅、设置、runner/date/terminal policy | `task-controller/monitor-{subscriptions,policy}.js`；既有 `state.js` 继续唯一拥有 monitor store | 事件和删除确认在 legacy view，业务查找/更新在应用域；无新增调度器，不把 DOM 数据当新命令权限 |
| 旧计划/策略/分享/监控显示 | `legacy-view/keyword-{plan,strategy,sharing}.js`、`monitor-settings.js` | 原 216 函数按实际 owner 核对；应用编排先调用纯标签 renderer，再处理进度状态/恢复清理、Debug 显示；策略切页的 seed 更新迁至具名应用操作 |
| 采集输入、进度、恢复、取消显示 | `legacy-view/capture-{inputs,progress}.js`、`keyword-inputs.js` | 核心不再获取 Sidebar DOM；捕获引用/缺节点/焦点/提示顺序离线配对，原平台序列化函数不变 |
| 公共进度显示/隐藏入口 | 新 `task-controller/progress-visibility.js` 与 `legacy-view/progress-visibility.js` | 原 host 的额外 2 个入口实际迁出；倒计时/DOM 读写、缺节点及 pinned 判断顺序保留，任务状态只由应用操作清理 |
| 宿主接线 | 原 Sidebar 18,530 行降至当前 11,096 行，净减 7,434 行；只向核心传 55 个明确的语义视图方法，不传节点 helper 或 document/window | 行数不是完成率；补齐额外入口后的双 Node 各 2,205 项全量通过，精确 head CI 单独核验 |
| 旧动作与严格执行 | `handleTaskCenterAction` 仍是旧宿主兼容入口，后台执行链保持原样 | 独立 legacy command adapter 尚未迁出；可信目标/原子执行围栏未实施，严格新 UI 不能接此旧入口；整个 B 与 L3 均未完成 |

离线配对由独立实施者完成：采集输入 76 组、进度/恢复/取消 206 组、关键词/监控/状态显示最终 87 组、公共进度显示/隐藏 593 组，Node 24/18 各通过。原 2,165 项回归按实际 owner 迁移，保留原场景；新增 25 项实际模块测试及 15 项迁移/AST 测试，不复制伪旧大文件、不覆盖 L3-A 历史哈希。

复核中修正了提前读取 plan filters、迁移 HTML template literal 空白变化和重复声明 owner；这些不算“仅格式差异”忽略。203 项初次 AST 等价因状态 renderer 明确拆分调整为 202 项，14 项有意语义端口迁移另列；额外 2 个入口独立登记。原宿主保留函数也按实际状态读写端口逆变换核对，不用候选自己与自己比较。

最终本地门禁：Node 24.12.0 / 18.20.8 官方递归各 **2,205/2,205**，0 失败/跳过；25 个源码消费者/迁移测试文件各 **599/599**；精确双父 Git 对象专项各 **35/35**。47 个 Sidebar JS 双 Node 语法通过；仓库卫生 854 文件、差异空白与隔离构建检查通过。独立最终审查核定 337 个应用方法、87 个旧视图方法、55 个语义端口、380 个有效解构引用，两个真实装配启动分支通过；剩余 293 个普通宿主函数加 init 按固定状态读写端口对照一致，无额外语义变化。

本地快照（均为 v0.4.5；相对路径排序后逐文件 SHA256 清单再取 SHA256）：候选 164 文件 `fefb16e176589b101332a2b7ce8beed37ef17c6e9e868e0313d000b61163eb4c`；原客户参考 95 文件仍为 `554479f7e01198ba0e6f7c2eb3d16e58c55db773aaadad90ecea5d6b039d1f87`。没有安装、Reload 或更改客户包；后台、平台采集、服务端、管理端、manifest、同步实现与精确父无差异。

下一步：提交/普通推送新 stacked Draft 并等待精确 head CI；本结构候选达到 Draft 门也不关闭 B 的命令边界缺口。后续先列旧命令 adapter 与后台原子围栏的精确实施范围，行为收紧须单独审批；不提前进入 C/L4，不对客户发布。

文档独立读者核对：现有独立审阅者（非全新无上下文实例）按三份计划回答完成范围、发布、来源/设计和后续授权问题，无阻断本结构候选的遗漏；按反馈澄清了未迁出的 legacy command adapter、旧界面语义端口并非新 UI 接线、原 216 项之外追加 2 个入口，以及服务端/G8 收尾仍保留。
