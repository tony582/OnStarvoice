# StarVoice Extension · 2026-10-14 正式本地集成 v7

final result: passed (local integration and isolated UI; no production acceptance)

- 独立开发分支：`codex/extension-ui-refresh`。经典默认、新版按浏览器配置文件开启、可随时切回；未提交、未推送、未安装或更新采集节点。
- 修正界面层的原参数上下文：搜索页统一批量入口不变，选择作品 / 博主时，在原弹窗事件之前激活原笔记页 / 博主页。关闭后保留对应页面和输入草稿，避免原异步处理读取搜索页增强设置。没有修改原采集函数。
- `npm run test:extension-ui`：169 项通过；新增 10 项隔离执行原批量处理函数的测试，验证参数、锁、授权、停止和异常清理。93 个核心文件与 HEAD 及现有 extension-build 一致。
- 浏览器实际交互检查：多关键词 50 项、笔记页 41 项通过，零浏览器运行错误；入口不启动任务，新旧切换保留原节点、值、禁用态与草稿。
- 320 / 440 px 视觉复查；320 px 无横向溢出，输入宽 258 px。关闭博主弹窗后仍处于 bloggerTab，焦点回原博主页签。
- v7 独立 ZIP 完整性通过，live snapshot 未改动。真实采集 / 同步 / 授权与 CPU、内存对比仍须授权的空闲节点验收，不是生产发布。

证据：[统一入口](outputs/extension-ui-review-20261013/qa-v7/batch-entry-440.png) / [博主弹窗](outputs/extension-ui-review-20261013/qa-v7/batch-blogger-440.png) / [320 px](outputs/extension-ui-review-20261013/qa-v7/batch-blogger-320.png) / [自动检查](outputs/extension-ui-review-20261013/qa-v7/tests.txt) / [浏览器检查摘要](outputs/extension-ui-review-20261013/qa-v7/browser-contracts.txt)

---

# StarVoice Extension · 2026-10-14 批量入口归并 v6

final result: passed (isolated UI only)

- 搜索页主按钮旁统一「批量采集」入口，原批量作品 / 批量博主按钮移入轻量选择框；笔记页与博主页主按钮恢复全宽。没有克隆按钮或新增采集分发逻辑，两个原功能保留。
- 新版博主输入改为「博主主页链接，每行一个」，提示粘贴完整链接、不支持仅填 ID、沿用博主页的采集条件；批量作品沿用笔记页附加采集选项。关闭 / 切回经典不清除草稿，经典布局和文案可完整恢复。
- 原生展开控件支持 Enter / Tab 选择；弹窗沿用原关闭按钮，Escape 退出后回到统一入口，Tab / Shift+Tab 在弹窗内循环。外部点击或切换页面会收起选项。禁用态和无人值守隐藏手动操作区的边界不变。
- 320 / 440 px 视觉检查完成。320 px 下主按钮 188.31 px、批量入口 95.69 px，均 40 px 高；笔记 / 博主页主按钮 292 px。输入弹窗去除重复横向缩进，宽 296 px、输入区 258 px，无横向溢出。
- 159 项自动检查、多关键词 50 项 / 非搜索页面 41 项浏览器检查通过。93 个受保护核心文件与基线一致，现有 extension-build 未修改。v6 候选 ZIP 完整性通过，未部署、未加载真实扩展、未启动真实采集；真实采集闭环和节点性能仍待授权的空闲节点验收。

证据：[440 px 统一入口](outputs/extension-ui-review-20261013/qa-v6/batch-entry-440.png) / [320 px 统一入口](outputs/extension-ui-review-20261013/qa-v6/batch-entry-320.png) / [440 px 博主弹窗](outputs/extension-ui-review-20261013/qa-v6/batch-blogger-440.png) / [320 px 博主弹窗](outputs/extension-ui-review-20261013/qa-v6/batch-blogger-320.png) / [笔记页](outputs/extension-ui-review-20261013/qa-v6/note-320.png) / [博主页](outputs/extension-ui-review-20261013/qa-v6/blogger-320.png) / [自动检查](outputs/extension-ui-review-20261013/qa-v6/tests.txt) / [浏览器检查](outputs/extension-ui-review-20261013/qa-v6/browser-contracts.txt)

---

# StarVoice Extension · 2026-10-14 上三项 / 下四项导航 v5

final result: passed (isolated UI only)

- 按用户最新确认，顶部为笔记页 / 博主页 / 搜索页；底部为采集 / 任务 / 创意 / 设置。内容创意缩短为创意，原按钮移动到底栏第三项；移除重复数据视图，不增第二份结果池。
- 原创意 SVG、按钮、禁用状态、三个功能、业务事件继续复用。进入创意时选中底栏第三项，可从任务 / 设置往返，重复点选不关闭，Escape 返回原页面；关闭展示不会启动或取消分析任务。
- 各采集页仍展示原采集内容、分组及操作。经典版恢复原赛道策略位置 / 文案 / 弹窗，不残留新版导航属性。没有修改采集引擎。
- 440 px：顶部每项约 146.67 px，底部每项 110 px；320 px：顶部每项约 106.67 px，底部每项 80 px。搜索页和创意页均无横向溢出。
- 158 项自动化检查、多关键词 35 项及原创意不可用页面 26 项浏览器检查通过。93 个核心文件与基线一致，现有 extension-build 未修改，v5 ZIP 校验通过；未发布 / 未安装 / 未重载节点。

证据：[440 px 采集页](outputs/extension-ui-review-20261013/qa-v5/search-440.png) / [320 px 采集页](outputs/extension-ui-review-20261013/qa-v5/search-320.png) / [440 px 创意](outputs/extension-ui-review-20261013/qa-v5/ideas-440.png) / [320 px 创意](outputs/extension-ui-review-20261013/qa-v5/ideas-320.png) / [自动检查](outputs/extension-ui-review-20261013/qa-v5/tests.txt) / [浏览器检查](outputs/extension-ui-review-20261013/qa-v5/browser-contracts.txt)

---

# StarVoice Extension · 2026-10-14 设置、平台与关键词分组 v4

final result: passed (isolated UI only)

- 新版取消右上角更多菜单；设置里复用原教程、常见问题、联系我们、检查更新和经典回退控件，获取授权放回授权卡内。底栏已有设置 / 任务，不重复新增。没有复制业务按钮或替换链接。
- 原平台切换节点移到顶栏最右，视觉顺序与 DOM 顺序一致；320 px 下平台名称仍显示，菜单向内展开（left 126 / right 310）。经典回退恢复原位置和所有原菜单节点、顺序、角色。
- 多关键词结果采用浅蓝 44 px 分组栏、独立细边框及 14 px 组间距；保持正文 14 px、数量 12 px，使用底色 / 字重区分层次。长关键词换行，数量不挤掉；原逐条结果、独立折叠行为与状态不改。
- 440 / 320 px 完成视觉检查。320 px document scrollWidth = 320，分组宽 274 / 内部 scrollWidth 272；设置宽度及 scrollWidth 均为 300，没有横向溢出。
- 首次合约读取早于导航引发的异步结果刷新；修正隔离测试为等待内存结果池刷新，31 项复测全部通过。未改实际结果渲染逻辑。
- 157 项自动化检查、31 项浏览器兼容检查通过。检查更新的原按钮在隔离环境触发提示；设置中切回经典、经典菜单重新进入新版均成功。无真实采集、更新请求或后台请求。
- 候选包 v4：93 个受保护核心文件与基线一致，现有 extension-build 哈希未变，ZIP 完整性通过；未安装 / 未发布 / 未重载。真实采集闭环和 CPU / 内存仍待空闲测试节点验收。

证据：[440 px 多关键词](outputs/extension-ui-review-20261013/qa-v4/keywords-440.png) / [320 px 独立折叠与长关键词](outputs/extension-ui-review-20261013/qa-v4/keywords-320.png) / [440 px 设置](outputs/extension-ui-review-20261013/qa-v4/settings-440.png) / [320 px 设置](outputs/extension-ui-review-20261013/qa-v4/settings-320.png) / [平台菜单](outputs/extension-ui-review-20261013/qa-v4/platform-menu-320.png) / [原经典菜单恢复](outputs/extension-ui-review-20261013/qa-v4/classic-menu-320.png) / [自动检查](outputs/extension-ui-review-20261013/qa-v4/tests.txt) / [浏览器检查](outputs/extension-ui-review-20261013/qa-v4/browser-contracts.txt)

---

# StarVoice Extension · 2026-10-14 选择器修订 v3

final result: passed (isolated UI only)

- 仅修改新版样式：关键词来源与开始方式统一为双列等宽分段选择器，浅蓝选中底、蓝字、细分隔线；去掉裸露圆形单选与灰色嵌套底块。
- 两组共用 14 px 字号、36 px 控件高度（含外框 38 px）；320 px 视口两组宽度均为 274 px，各选项 136 px，无横向溢出。440 px 也已检查。
- 来源仍为原生 radio，视觉隐藏圆圈但不隐藏可访问控件；方向键左右切换已验证，并正确驱动原批量开关。手动 / 无人值守仍是原按钮、原值与原事件。保留键盘焦点和禁用态。
- [440 px 完整截图](outputs/extension-ui-review-20261013/qa-v3/selectors-440.png) / [控件局部](outputs/extension-ui-review-20261013/qa-v3/selectors-detail.png) / [320 px](outputs/extension-ui-review-20261013/qa-v3/selectors-320.png)
- [155 项自动化检查](outputs/extension-ui-review-20261013/qa-v3/tests.txt)与 [23 项浏览器兼容检查](outputs/extension-ui-review-20261013/qa-v3/browser-contracts.txt)通过；93 个核心文件未变，现有扩展快照未修改。v3 包未部署。

---

# StarVoice Extension · 2026-10-14 导航修订 v2

final result: passed (isolated UI only)

- 用户最新确认：赛道策略改名内容创意，放到顶部标签；对标监控移入设置。原 SV11 视觉方向不变。
- 顶部四个等宽标签：笔记页、博主页、搜索页、内容创意。搜索表单中移除重复入口；原按钮直接移动，没有克隆业务按钮或绕过禁用条件。
- 内容创意复用原三个分析功能和原打开/关闭状态，以页内区域呈现；再次选择当前标签不退出，其他标签、底栏、Escape 可返回。经典模式恢复原策略名称、位置与弹窗语义。
- 设置保留授权与帮助，新增对标监控入口。进入监控后底栏仍选中设置，返回设置与返回采集均已检查；监控业务控件、列表与刷新路径不变。
- 440 px 下顶部各 110 px；320 px 下各 80 px，无横向溢出。修复了继承原图标按钮 36 px 宽度、原四列导航空位、创意面板嵌套内边距导致窄屏内部标签断字的问题，修复后重新截图。
- 字体、品牌蓝、浅蓝标签底、区域边界沿用上一版；无新增字体、图标包、动画、网络请求、轮询或观察器。

## 当前修订证据

- [搜索页与顶部四标签](outputs/extension-ui-review-20261013/qa-v2/search-440.png)
- [内容创意页](outputs/extension-ui-review-20261013/qa-v2/ideas-440.png) / [320 px 创意页](outputs/extension-ui-review-20261013/qa-v2/ideas-320.png)
- [设置中的监控入口](outputs/extension-ui-review-20261013/qa-v2/settings-440.png) / [原监控页与返回路径](outputs/extension-ui-review-20261013/qa-v2/monitor-440.png)
- [154 项自动化检查通过](outputs/extension-ui-review-20261013/qa-v2/tests.txt)
- [23 项浏览器兼容检查通过](outputs/extension-ui-review-20261013/qa-v2/browser-contracts.txt)，包括原节点/字段/禁用状态、入口重绘、返回路径和五次连续新旧切换。
- v2 候选包校验通过：93 个受保护核心文件完全一致；现有 `extension-build/` 未修改。没有部署、重载或触发真实采集。真实功能闭环与节点 CPU/内存仍需空闲测试节点验收。

以下为前一轮的完整记录，保留原始验收时间与证据。

---

# StarVoice Extension · SV11 界面实现 QA

final result: passed

验收范围：本地隔离界面与新旧切换合约。**不代表真实 Extension 采集、生产性能或全量发布已通过。**

## 比较目标与状态

- 用户选定方向：深蓝页头、浅蓝分类栏、Logo 蓝、配置与采集内容清楚分区、同页完成配置。
- source visual truth path：`/Users/dulaidila/.codex/visualizations/2026/08/18/01a0133f-f6cf-78e3-99d0-ee9b01e3a449/extension-sv11-search.svg`
- Figma 来源：`jk1NmFyzAWdBQROUU9nSYI` / `39:1420`，SV11 搜索主页面。本轮实现没有声称同步修改全部 Figma 页面。
- implementation screenshot path：`/Users/dulaidila/.gemini/antigravity/scratch/OnStarvoice-2/outputs/extension-ui-review-20261013/qa/search-440.png`
- 实现 URL：`http://127.0.0.1:4178/sidebar/sidebar.html?scenario=search`
- viewport：440 × 1000 CSS px；devicePixelRatio=1；页面 zoom=1。
- source dimensions：440 × 1000 SVG；implementation dimensions：440 × 1000 PNG。比较图没有缩放实现；源 SVG 原尺寸渲染，无浏览器外框。
- state：小红书搜索页，关键词“新能源汽车”，默认增强关闭，50 条上限、0 点赞阈值；结果使用演示记录。
- 状态差异已明确：设计稿有示意封面和“评论已合并”，演示记录无图片 URL、评论未采集，因此实现保留真实无图/未采集状态，不补假封面或假成功文案。滚动区域自然承载更完整的原记录字段。

## Full-view comparison evidence

源设计在左、浏览器实现在右；是在同一比较图中检查，不是分别凭记忆判断。

![完整对照](outputs/extension-ui-review-20261013/qa/comparison-full.png)

## Focused region comparison evidence

- [配置与单选/输入](outputs/extension-ui-review-20261013/qa/comparison-controls.png)
- [逐条结果与操作](outputs/extension-ui-review-20261013/qa/comparison-content.png)
- [主操作与底栏](outputs/extension-ui-review-20261013/qa/comparison-navigation.png)

## Findings 与比较历史

| 级别 | 发现 | 修正与复核 |
| --- | --- | --- |
| P2 · 已解决 | 初版仍引用旧紫色品牌 SVG | 页头和欢迎页改用仓库现有蓝色 icon128.png；不重绘品牌资产。最终主屏/欢迎页已检查 |
| P2 · 已解决 | 初版折叠项之间保留额外网格间距，结果区域被挤下 | 折叠行统一 44 px、去掉叠加纵向间距；最终配置卡结束位置与源卡接近 |
| P2 · 已解决 | 320 px 下阈值标题换行导致两项输入上下错位 | 同排表单使用弹性列及底部对齐；浏览器读取两输入顶部均为 283 px |
| P2 · 已解决 | 原结果按钮单独占据内容行，记录偏高；两种记录按钮位置不统一 | 原按钮仍为同一节点，仅通过 CSS 归到卡片头；最终结果/数据视图检查，无字段删除 |
| P2 · 已解决 | 新底栏可能遮住原任务最小化入口 | 仅在新版中为浮动入口预留底栏高度；全屏运行面板四个区域新旧坐标完全一致 |
| P2 · 已解决 | 新页正文行高可能继承到稳定运行面板 | 运行面板恢复原 normal 行高，布局不重排；紫色强调改蓝，原绿色/红色语义不变 |
| P2 · 已解决 | 原图标 tooltip 转换后按钮缺少可读名称 | 原界面 tooltip 转换同时保留空文本按钮的 aria-label；记录“移除”、批量和关闭按钮可被语义定位 |
| P3 · 可接受 | 字体与样张有差异 | 使用原系统字体栈，不下载 Noto Sans SC；中文渲染随操作系统。减少节点下载/字体布局负担是本任务明确约束 |

以上修正后重新捕获同一 440 × 1000 搜索状态并生成完整/局部对照。无遗留可操作的 P0/P1/P2 视觉问题。修正前的浏览器交互故障属于隔离演示初始化顺序问题，不计作视觉 QA 迭代。

## 五项必检表面

- **字体/排版**：系统字体沿用原产品；正文/控件 14 px，辅助说明 12 px，关键词 18 px，品牌 20 px。折叠项统一字号和重量，标题最长两行，保留原动态文本。源设计与实现的字体抗锯齿不做像素级等同承诺。
- **间距/布局**：配置、结果、授权以 8 px 圆角和轻边界区分。页头 58 px、分类 44 px、底栏 60 px；主操作固定且为滚动内容保留空间。320–600 px 搜索及 320 px 任务无横向溢出；自然长内容允许纵向滚动。
- **颜色/tokens**：主蓝 `#2F6FED`，页头 `#1C3B5B`，分类底 `#EAF2FC`，页面 `#F5F7FA`。浏览器 computedStyle 已核实按钮实际 `rgb(47, 111, 237)`；捕获图的色彩显示与源 SVG 存在差异，不以截图偏色反向修改品牌 token。成功/警告/错误保留现有语义色。
- **资产/图像**：使用原蓝色品牌 PNG，新增通用导航图标来自本地 Lucide 1.8.0 并附许可证；没有用自绘图形替代正式品牌。采集记录封面继续由原渲染器读取，演示无图时显示原生缺图状态。
- **文案/内容**：保留真实“高于以下点赞数”语义，不擅自改成大于等于；头部“已就绪”只是原状态的呈现，不新造后台健康探测。新增“设置”满足最近确认，帮助入口完整；不把原有动态结果伪装成源稿示例成功状态。

## 已检查交互与状态

| 覆盖 | 证据 |
| --- | --- |
| 当前搜索/批量单选、文本输入、开始方式、平台筛选、增强多选与依赖 | search-440.png、search-batch-plan.png、search-enhancement.png、douyin-filters.png |
| 笔记、博主、批量输入、赛道策略 | note-440.png、blogger-440.png、batch-modal.png、strategy.png |
| 结果、无数据、错误页面、不支持平台 | data-view.png、empty.png、unsupported.png；页面不符保留原禁用主按钮 |
| 任务列表、失败详情、窄侧栏 | tasks-440.png、task-detail.png、tasks-320.png |
| 运行、等待、最小化与切回 | running-next.png、running-classic.png、running-waiting.png、running-minimized.png |
| 授权、未授权、过期、帮助 | settings-authorized.png、settings-unauthed.png、settings-expired.png、help-menu.png |
| 新旧切换、原节点和输入保留、订阅清理、连续五次切换 | browser-contracts.txt、browser-contracts.png：13 项通过 |

所有证据均位于 `outputs/extension-ui-review-20261013/qa/`。浏览器当前轮错误监听为 0；开发日志保留一条早期演示页面初始化顺序错误，已通过延后到 load 初始化修复，最终重新载入与合约检查未复现。没有把该历史错误掩盖成“从未出现错误”。

## 自动检查与安全边界

- 135 项测试通过，0 失败、0 跳过；见 [tests.txt](outputs/extension-ui-review-20261013/qa/tests.txt)。
- 93 个受保护核心文件与原版本一致；两份包的现有扩展目录哈希检查均通过。
- 新版不增加计时器、网络请求、观察器或业务状态写入；旧版默认不加载新样式和适配层。
- 真实平台页面、后台同步回执、授权绑定、无人值守执行、停止/恢复和节点 CPU/内存需要单空闲节点验收，未在此隔离演示中声称完成。
- 不是自动发布版本；没有部署或重载现有节点。

## Implementation checklist

- [x] 主框架、独立采集页、同页配置、逐条结果、任务、设置与帮助完整接入。
- [x] 明确单选/多选/禁用/折叠语义，不改变业务字段或默认值。
- [x] 新版手动按浏览器启用；可切回；加载故障回退；经典包独立保留。
- [x] 完成完整和局部图像对照、多宽度检查、浏览器 DOM 合约及静态测试。
- [ ] 用户确认后，在单台空闲节点进行真实采集闭环与性能对照。
- [ ] 首台业务验收通过后再决定正式版本号、签名与小批次分发。

[单节点验收与回退说明](docs/extension-ui-review-20261013.md)

---

# 历史 QA（原样保留）

# 官方社媒帖子视图 Design QA

## 对照范围

- 来源标注 1：`/var/folders/y7/0dk281y10zn0w4s0z7wk_f300000gn/T/codex-clipboard-db2616cc-7ac8-4918-be26-e3e5ae09f723.png`
- 来源标注 2：`/var/folders/y7/0dk281y10zn0w4s0z7wk_f300000gn/T/codex-clipboard-0a26de47-057e-4b66-874d-89ac4c7fdb39.png`
- 最终实现：`.codex-artifacts/official-social-post-engagement-final-1280x720.png`
- 全页对照：`.codex-artifacts/official-social-post-view-comparison.jpg`
- 帖子列表聚焦对照：`.codex-artifacts/official-social-post-list-focused-comparison.jpg`
- 来源像素：2550 × 1522，144 dpi
- 实现像素与 CSS 视口：1280 × 720，deviceScaleFactor 1
- 归一化：来源图按宽度缩放至 1280 像素后与实现纵向合并；帖子列表分别裁切并缩放至 1000 像素宽。
- 状态：近 30 天、全部平台、全部官方账号、负面评论标签。

## 比较历史

1. P2 信息密度：指标卡数字下方存在四句解释文案。已全部删除。
2. P1 业务结构：页面以单次巡查对比为主，而用户需要直接查看帖子。已删除全局巡查对比、右侧对比摘要、帖子对比与趋势列，以及评论“本次新增”标记。
3. P1 核心数据缺失：帖子没有展示点赞、评论、转发。已从帖子当前数据增加三项互动指标，并用于桌面列表和移动端卡片。
4. P2 术语负担：“评论覆盖”要求运营人员理解采样口径。已从桌面和移动端界面删除。

## 最终检查

- 字体与层级：沿用现有产品字体、字号和表格层级；删减后帖子标题、情绪和互动数据成为主要阅读路径。
- 间距与布局：移除摘要块后帖子列表直接上移；三列帖子表格在 1280 × 720 下无需横向滚动，点赞、评论、转发均完整可见。
- 颜色与状态：保留现有情绪色、选中态和建议卡颜色，没有引入新视觉语言。
- 图片与图标：页面无新增图片资产；互动数据使用现有图标库中的点赞、评论和转发图标。
- 文案：未发现“本次巡查”“上次巡查”“相比上次巡查”“较上次巡查”“风险趋势”“评论覆盖”或“本次新增”。
- 交互：帖子可切换；负面、正面、全部评论标签可切换；原文入口与评论建议保留。
- 浏览器控制台：新页面加载后无 error。
- 自动验证：管理端构建、定向 ESLint、16 项相关测试及 diff check 通过。

## 剩余问题

- P0：无。
- P1：无。
- P2：无。

final result: passed

---

# 社交账号 Agent 日运行视图 Design QA（2026-08-12）

## 目标与视觉基准

- 业务目标：把社交账号页从“账号负载管理”改为“每个 Agent 的今日运行健康”；账号绑定降为可选说明信息。
- 视觉基准：现有 StarVoice 桌面/移动端导航、卡片、状态色、圆角、字号和紧凑运营布局；本轮没有引入新的视觉语言或图片资产。
- 验收数据：2 个 Agent，1 个在线，今日搜索 35、采集运行 35、增强 205、采到内容 553；Windows-火星出现 1 次安全验证，Windows-金星未登记账号。
- 验收地址：`http://127.0.0.1:5173/admin/?page=social-accounts`。

## 信息层级

- 首屏先回答三个问题：有多少 Agent、多少在线、多少 Agent 今日出现安全验证。
- 第二层展示今日搜索、采集运行、增强、采到内容和安全验证总数。
- 每张 Agent 卡同时展示在线状态、支持平台、今日五项数字、最后心跳、最后安全验证时间。
- 账号信息放在卡片底部并明确标为“可选”；未登记时明确说明不影响 Agent 统计。
- 上海自然日按日期行读取；00:00 进入新日期后页面自然从 0 开始，历史行不删除。

## 交互验证

- 今日安全验证筛选：只保留 Windows-火星，结果数从 2 变为 1。
- 未登记账号筛选：只保留 Windows-金星，并显示“未登记账号，不影响统计”。
- 账号信息弹层：可选小红书和抖音账号，每个平台最多一个，允许选择 0 个。
- 保存账号信息后弹层关闭并显示成功反馈；反馈明确说明 Agent 用量不受绑定变化影响。
- 账号绑定接口只修改说明关系，不参与 Agent 用量累计主键或每日汇总。

## 响应式与视觉检查

- 1536 × 960：两张 Agent 卡并排，各 634 像素宽；无横向溢出。
- 1280 × 720：Agent 卡单列，主内容区无横向溢出。
- 390 × 844：摘要、筛选和 Agent 卡自动单列；文档宽度等于视口宽度 390，无横向溢出。
- 字体、图标、状态色和边框沿用现有设计系统；安全验证使用红色，在线使用绿色，离线使用中性色。
- 干净页面重新加载后浏览器控制台 warning/error 均为 0。

## 自动验证

- 管理端生产构建通过。
- 本轮涉及的 3 个管理端文件定向 ESLint 通过。
- 社交账号、云端 Agent 和后台采集锁相关测试共 168 项通过。
- 服务端路由、用量服务和 Extension 两份用量脚本语法检查通过。
- `git diff --check` 通过。

## 剩余问题

- P0：无。
- P1：无。
- P2：无。
- P3：全仓 ESLint 仍有 288 个既有问题，均不在本轮 3 个管理端修改文件内；定向检查已通过。

final result: passed

---

# 调度中心 UI Design QA（2026-08-12）

## 对照范围与归一化

- 视觉基准：`/Users/dulaidila/.codex/generated_images/019ff440-5744-77f2-8ef5-47c7a9f4aa88/exec-c355de0e-b895-4162-82c0-f51b2a51e401.png`
- 浏览器实现截图：`/Users/dulaidila/.codex/visualizations/2026/08/12/019ff440-5744-77f2-8ef5-47c7a9f4aa88/dispatch-keyword-report-final.png`
- 同图对照：`/Users/dulaidila/.codex/visualizations/2026/08/12/019ff440-5744-77f2-8ef5-47c7a9f4aa88/dispatch-keyword-report-comparison.png`
- 计划归档截图：`/Users/dulaidila/.codex/visualizations/2026/08/12/019ff440-5744-77f2-8ef5-47c7a9f4aa88/dispatch-plan-archive-final.png`
- 历史分页截图：`/Users/dulaidila/.codex/visualizations/2026/08/12/019ff440-5744-77f2-8ef5-47c7a9f4aa88/dispatch-history-final.png`
- 来源像素：1409 × 1117；实现截图像素：1440 × 1000；CSS 视口：1440 × 1000。
- 浏览器报告 DPR 为 2；截图输出已归一化为 CSS 像素尺寸。
- 对照状态：47 个关键词已完成 17 个，第 18 个“安吉星”由 Windows-火星执行；搜索/采集 34、增强 12、保存 11、词内 13/34。
- 来源为独立报告画布，实现嵌在现有调度中心弹窗中。因此对照重点是信息层级、密度、当前词强调、指标和交互，不把外围产品导航计为偏差。

## 全局和聚焦区域证据

- 两者均以批次信息为首层、关键词列表为主工作区、当前关键词详情为右侧持续可见区域。
- 实现保留蓝色进行中、绿色完成、紧凑指标、Agent 归属、关键词搜索、Agent 筛选、批次位置和词内位置。
- 当前关键词行显示状态、实际执行 Agent、在线状态、搜索数、增强数、保存数和词内位置；右侧显示四阶段、34/12/11、18/47、13/34、当前动作、最后上报和尝试次数。
- Extension 没有上报的阶段数字显示“—”，不推算成看似真实的进度。
- 当前第 18 个词在初次打开时自动定位到可见列表区域；桌面验收时行坐标为 y=788–855.5。

## 必查视觉面

- 字体与层级：通过。沿用产品字体栈，标题、标签、表格数字和中文长文案无裁切。
- 间距与布局：通过。双栏比例、卡片间距、分割线和筛选分组在 1440、1024、768 宽度均稳定。
- 颜色与 token：通过。蓝/绿/红/中性色分别承担进行、完成、破坏性、等待语义。
- 图片与资产：通过/不适用。此运营界面没有照片或插画；图标均来自现有 Lucide 图标库，无占位图、emoji、手绘 SVG 或 CSS 插画。
- 文案：通过。搜索、增强、保存、批次位置、词内位置边界明确；归档文案明确说明历史与采集结果保留。
- 交互与可访问性：通过。按钮、标签页、区域、进度条、筛选标签、选中态和禁用态均为语义控件，原生输入与下拉可键盘操作。

## 比较历史

1. P2：历史筛选原六列布局超出中心工作区，查询和重置可能被挤出。已改为任务名整行、平台/状态两列、日期两列、操作独立一行；1440、1024、768 下均无页面级横向溢出。
2. P2：关键词报告第一次打开没有把活动词放到可见区；首次偏移修复又产生过度滚动。已按列表容器计算相对位置，最终第 18 个词完整可见。
3. 最终同图对照：弹窗外框和信息密度差异属于现有产品约束；未发现可执行的 P0/P1/P2 差异。

## 浏览器验证

- 已操作：打开运行编排、切换关键词、关键词搜索、Agent 筛选、当前/归档计划标签、复制归档计划、历史筛选与重置、历史下一页。
- 已检查尺寸：1440 × 1000、1024 × 900、768 × 900；窄屏无文档级横向溢出。
- 最终控制台 warning/error：无。
- 验收使用本地仿真数据，没有修改生产数据或计划状态。

## 剩余问题

- P0：无。
- P1：无。
- P2：无。
- P3：实现顶部批次摘要比视觉基准少几个重复指标；父任务进度卡和右侧当前词卡已覆盖这些数据，因此保留当前更紧凑结构。

final result: passed
