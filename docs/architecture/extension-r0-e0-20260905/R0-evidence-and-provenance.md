# R0：本地证据与来源清单

观察日期：2026-09-05。状态：本地技术盘点完成，权属审查与实际部署来源未完成。仅技术比对，不作侵权判定。

## 1. 原件、副本及保全范围

本次只复制原件，不移动或删除原文件。证据副本位于仓库外，不进入 Git、CI 或 Extension 构建。

| 对象 | 本地路径 |
|---|---|
| MediaClaw 原件 | `/Users/dulaidila/.gemini/antigravity/scratch/OnStarvoice-2/mediaclaw (new).crx` |
| StarVoice 原目录 | `/Users/dulaidila/.gemini/antigravity/scratch/OnStarvoice-2/extension-build` |
| MediaClaw 副本 | `/Users/dulaidila/.gemini/antigravity/scratch/OnStarvoice-extension-evidence-20260905.xVY0IM/mediaclaw-0.3.0.crx` |
| StarVoice 副本 | `/Users/dulaidila/.gemini/antigravity/scratch/OnStarvoice-extension-evidence-20260905.xVY0IM/starvoice-local-delivery` |

副本和原件在审计前、后逐字节相等。仅读取 CRX 内 ZIP 成员，没有把第三方源码解包进开发仓库。普通本地副本与哈希不是公证、可信时间戳或不可变外部存档；如果需要正式证据保全，应另按专业意见处理。本次保留了获取路径和可复核方法，没有证明更早的历史内容。

MediaClaw 包 SHA-256：`078f27d7aa753b6a26662b5809c320ecfacaea7dc9eb17235b4380aa0a84d2bc`，包体 1,795,457 字节，manifest 0.3.0。

| 集合 | 文件数 | 原始文件总字节 | 清单 SHA-256 |
|---|---:|---:|---|
| main 扩展源码投影（0.4.3） | 95 | 4,605,203 | `dfc29a7afddc8015ebef73d9b68c5e3efe8d8081530da07ab9a4a6bd9813634f` |
| 本机交付（0.4.5）及匹配提交源码投影 | 95 | 4,700,348 | `92e4cfd6b862f016eca51805669297cce6630315a00027083379476add8e5238` |
| MediaClaw 包成员（0.3.0） | 226 | 5,084,715 | `816160d21988811172908fa6ba4638b9619ef85fc86698f465b3892064f831ae` |

清单哈希方法：按 path 排序，每项字段按 `path, bytes, sha256` 顺序序列化；UTF-8 JSON、非 ASCII 不转义、无空白、无尾换行，然后 SHA-256。它不是把文件简单拼接后的哈希。完整清单在 [snapshot-audit.json](evidence/snapshot-audit.json)。

报告文件 SHA-256：`46df5fe1b10271d6026ba5b09d2234a75b4b05ee1f5fb59c733cc5c34e4939b2`。

## 2. 版本与 Git 证据

| 角色 | 提交 | Git 作者/作者时间 | 限制 |
|---|---|---|---|
| 架构 base | `51896d8694c4b19e3731e5b6b7623397420c84a9` | dulaidila，2026-09-01T19:05:52+08:00 | 合并 PR #36；扩展仍为 0.4.3 |
| 本机交付匹配源码 | `85f8d797358e5aa2acf4db51ff1b3c57abe6c594` | dulaidila，2026-09-02T11:50:25+08:00 | 95/95 字节一致，不等于服务器或客户加载证明 |
| 保留的架构候选 | `8b23632027c1c788a3400ab90cc07aa26a6c435b` | dulaidila，2026-09-01T19:53:40+08:00 | PR #37 Draft，不并入本次文档分支 |

Git 作者字段和提交时间仅是仓库元数据，不证明法律作者、雇佣关系、独立创作或权利归属。共享历史与相同代码不表明复制方向；需要结合合同和更早来源。后续可用这些精确提交逐路径追溯，但本批没有完成全部历史作者/授权链调查。

相对于本机 0.4.5，main 的 9 个差异文件：

1. `background.js`
2. `content-v2.js`
3. `manifest.json`
4. `sidebar/sidebar-logic.js`
5. `utils/capture-sync.js`
6. `utils/capture/debug-session.js`
7. `utils/capture/list-capture-debug-overlay.js`
8. `utils/capture/task-runtime.js`
9. `utils/capture/task-tab-group.js`

每项两侧 SHA-256 已存入 JSON 的 `base_to_snapshot.files`。`candidate_to_snapshot` 证明匹配提交全部 95 文件相等。投影范围源于生产同步脚本：根目录四入口及 `images/sidebar/utils`，排除 `.DS_Store`；本次没有实际执行同步/打包。

## 3. 共同实现排查目录

算法：只比较包和本机交付目录的同路径 `.js`；按 `splitlines()`，`difflib.SequenceMatcher(autojunk=False)`，比例为 `2 × matched_lines / (left_lines + right_lines)`。48 个同路径 JS 中，11 个逐字节相同。完整数据见 [similarity.tsv](evidence/similarity.tsv)。

| 相同文件组 | 路径 | 后续对应批次 |
|---|---|---|
| 执行上下文 | `utils/task-context.js` | E1a |
| 同步路由 | `utils/platform/sync-router.js` | E2 |
| 展示/平台配置 | `sidebar/platform-config.js`、`sidebar/renderers/douyin.js`、`sidebar/renderers/xiaohongshu.js` | D1/E4 |
| 采集适配/DOM | `utils/capture/adapters/xiaohongshu/index.js`、`utils/capture/shared/detail-dom.js`、`utils/capture/shared/dom-locator.js` | E3 |
| 平台配置/策略 | `utils/platform/dom-profiles/index.js`、`utils/platform/dom-profiles/xiaohongshu.js`、`utils/platform/shared-policy.js` | E3/E4 |

| 非完全相同的重点模块 | 文本比例（四舍五入） | 核查用途 |
|---|---:|---|
| `utils/capture/keyword-expansion.js` | 99.9% | 关键词扩展来源和独立实现规格 |
| `utils/auth-code.js` | 99.2% | 授权交互辅助代码；不能顺带改变激活协议 |
| `utils/selectors.js` | 99.0% | 页面提取实现来源 |
| `utils/capture/index.js` | 98.7% | 适配入口实际依赖 |
| `sidebar/renderers/common.js` | 97.3% | 结果展示来源 |
| `utils/capture/douyin-comments.js` | 91.6% | 评论循环、停止与恢复行为 |
| `utils/capture/keyword-search.js` | 88.6% | 搜索流程和任务接续 |

这些数值不是整个产品的相似度，也不是合法性阈值。未覆盖跨路径改名后的模糊匹配、感知图像相似度、代码生成/第三方来源甄别、完整文档比对、版权/商标/商业秘密权属。不得将“只剩 11 个文件”或“低于某比例”作为独立性结论。

## 4. 品牌与资产范围

对本机快照 `.js/.json/.html/.css/.md/.txt/.svg` 的品牌文本扫描发现：`sidebar/sidebar-logic.js:12908` 含“社媒虾”。这是静态命中，未通过触发图片导出验证运行时显示。报告只保存命中词和位置，不复制上下文代码。

manifest 仍含客资、选题、导出、飞书等表达。是否保留既有客户需要的能力应由产品规格决定，不能为了文案差异删除已用功能。品牌后续清单应包含名称、Logo、图标/字体许可、图片导出签名、帮助链接、包元数据、网站/商店和合同产品称谓；本批未更改这些对象。

## 5. 权属台账（均为待证，不由技术相似度推断）

| 材料/对象 | 当前证据 | 需要补齐 | 决策责任 |
|---|---|---|---|
| 两家公司分立前后代码权利 | 用户说明曾属同一团队；仓库与包有共同实现 | 合作/分立协议、资产与代码授权/转让范围、期限和修改再发行权限 | 公司负责人 + 专业律师 |
| 员工/外包贡献 | 上述 Git 元数据 | 劳动/IP归属、委托开发及交付文件、真实贡献时间 | 公司负责人 + 专业律师 |
| 第一方独有/共有模块 | 技术差异及职责目录 | 逐模块许可或权利链；独有功能不自动等于拥有全部底层实现 | 工程盘点 + 法务判定 |
| 图片、字体、图标和 UI 文案 | 文件哈希；既有设计任务 | 原始设计与素材来源、购买/开源许可、授权范围 | 设计负责人 + 法务 |
| 公共 API/平台字段/第三方依赖 | 程序文件与协议清单 | 依赖来源和适用许可；排除只能有限表达的内容后再评估 | 工程 + 法务 |

已读取“评估Extension反编译防护”任务作为技术背景；其较早的“底层可以共享”是有权使用前提下的建议，不能作为两家公司已有许可的证明。已接触过对方源码，不作洁净室声明。原文件、历史提交及潜在证据继续保留。

法律背景沿用前一轮已经查阅的官方资料：[计算机软件保护条例](https://tfs.mofcom.gov.cn/fgsjk/flfg/zscq/zzq/art/2024/art_d071637de09e4ca88b627f924a7280c3.html) 第10、11、13条规定合作、委托与职务开发的不同归属规则；[最高法软件侵权案例](https://ipc.court.gov.cn/zh-cn/news/view-1636.html) 说明接触与实质性相似的判断及源代码比对并非必备环节。资料不能替代针对合同事实的意见，本批未重新作法律研究。

## 6. 重现与校验

工具 [audit_snapshot.py](audit_snapshot.py) 使用 Python 标准库和本地 Git；只读源目录、CRX 和提交对象，只向新的审计输出目录写元数据。无网络、不提取压缩包、不启动应用、不调用构建。原始副本不随 PR 分享，协作者需有合法取得的同哈希输入；同一输入重现的 JSON/TSV 应逐字节相同。

在本隔离 worktree 中执行，下列输出目录必须不存在：

```sh
python3 docs/architecture/extension-r0-e0-20260905/audit_snapshot.py \
  --repo . \
  --base 51896d8694c4b19e3731e5b6b7623397420c84a9 \
  --candidate 85f8d797358e5aa2acf4db51ff1b3c57abe6c594 \
  --snapshot /Users/dulaidila/.gemini/antigravity/scratch/OnStarvoice-extension-evidence-20260905.xVY0IM/starvoice-local-delivery \
  --original-snapshot /Users/dulaidila/.gemini/antigravity/scratch/OnStarvoice-2/extension-build \
  --media-package /Users/dulaidila/.gemini/antigravity/scratch/OnStarvoice-extension-evidence-20260905.xVY0IM/mediaclaw-0.3.0.crx \
  --original-media-package '/Users/dulaidila/.gemini/antigravity/scratch/OnStarvoice-2/mediaclaw (new).crx' \
  --output /Users/dulaidila/.gemini/antigravity/scratch/OnStarvoice-extension-evidence-20260905.xVY0IM/recheck
```

若原目录后续按正式流程升级，前后相等检查应失败；不能覆盖此次证据来使检查变绿，应创建新日期的证据批次。`check-extension-snapshot.zsh` 会先重建交付目录，不能用于此次只读取证；本批本地也不运行会调用它的 `npm test`。远端 CI 使用自身临时工作区的常规测试，与本机证据目录无连接。
