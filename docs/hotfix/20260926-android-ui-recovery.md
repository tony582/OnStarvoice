# 手机跑两个词后连续失败、视频「展开」后被跳过（Runner 0.2.3 / 0.2.4）

分支：`codex/hotfix-android-ui-recovery-20260926`，基线 `69bbd90`（生产头，`97b3765` 加发布记录）。只改手机 Runner（`runners/android`），不动服务端和 Admin，不需要迁移。线上手机跑的 `runtime-0.2.2-45c049b` 与基线的 `runners/android/src` 逐字节相同。

## 现象

2026-09-26 手机（锤子 DE106）跑 10 个壁纸关键词：前两个词（别克车机壁纸、凯迪拉克车机壁纸）正常结束，从第三个词起全部「需要处理」，每个词尝试 3 次。

## 证据（本机 runner 数据库只读副本 + `diagnose`）

最近 16 小时 60 次关键词运行：5 次正常，54 次 `needs_action:invalid_ui_source`，1 次 `scroll_container_ambiguous`。三轮（09-25 23:41、09-26 11:57、12:24）情形相同：

1. 「君越壁纸」滑到第 6–8 屏（8.8–11.3 分钟，15–20 条）时，`scroll` 读到的界面被 Runner 自己的解析器（`src/device/ui-tree.mjs`）拒绝，报 `invalid_ui_source`。
2. 手机停在这个君越结果页。之后每个关键词开头的 `inspect:login_check` 先读当前界面，同样被拒绝，约 10 秒就失败。`verifyLoginAndSearchEntry` 只在读成功之后才按返回，所以手机一直原地不动。
3. 服务端马上把下一个词、下一次尝试派下来。每次失败都算一次尝试，约 6 分钟内 7 个词 × 3 次全部耗尽。

`invalid_ui_source` 只由解析器产生（Appium 返回超过 2 MB 会报另一个错误码 `appium_response_too_large`），所以是页面结构或字符被判为非法：控制字符实体、嵌套超过 128 层、超过 12000 个节点等。事后（13:03）同一结果页已回到顶部，用 Runner 同款会话参数取到的 Appium 页面结构（200 个节点，130 KB，深度 33）能正常解析。所以触发它的是滑动到某一位置时出现的动态内容（如自动播放或直播卡片），当时的具体元素已无法取回。旧版诊断没有记录是哪条规则拒绝的。

## 改动

| 文件 | 内容 |
|---|---|
| `src/device/douyin-readiness.mjs` | 登录检查读到 `invalid_ui_source` 时按返回键再读，最多 `UNREADABLE_SCREEN_BACKS = 3` 次；仍读不了就照原样失败，并带上 `backPresses`（已是上传白名单里的数字字段）。其它错误不重试。按返回只用 Appium 的 back 接口，不依赖解析结果；与原有“最多按 6 次返回找到首页”的做法同一类操作 |
| `src/device/ui-tree.mjs` | 每条拒绝规则带上名字：`invalid_code_point`（附 `codePoint`）、`too_deep`、`too_many_nodes`、`stray_text`、`duplicate_attribute`、`bare_ampersand`、`unknown_entity`、`unbalanced_tag`、`invalid_tag`、`invalid_attribute`、`misplaced_root`、`markup_declaration`、`too_large`、`incomplete_document`、`not_text`，另附字节数、节点数、深度。放在错误的 `diagnostic` 字段里：只进本机 `diagnose` 记录，不在上传的完成详情里，不含任何页面文字。解析规则本身一条没放宽 |
| `package.json`、`src/daemon/setup.mjs` | 版本 0.2.3 |

时间预算：配置了设备档案时，每个动作的上限是 60 秒（`daemon-commands.mjs`、`up-command.mjs`）。原来整次 `inspect`（含建会话）约 10 秒，最多再加 3 次返回加读取，仍在预算内。

## 验证

Node 24.12.0，串行。

| 检查 | 结果 |
|---|---|
| 新增 `test/ui-recovery-20260926.test.mjs` | 4/4：各规则名与数值、诊断里没有页面文字；读不了时按返回后继续；一直读不了就按 3 次后失败，并带 `stage`、`backPresses`、规则名；规则名进本机诊断记录，但不进上传的完成结果 |
| 反向：换回旧 `douyin-readiness.mjs` | 两个恢复测试失败 |
| Runner 全套 `node --test --test-concurrency=1 test/*.test.mjs` | 186/186（原 182 + 新 4） |
| `scripts/check-android-discovery-boundaries.mjs` | 通过（87 个模块，最大 299 行） |
| `tests/capture-discovery-runner-contract.test.mjs` | 通过 |

## 这次没修的

- **「君越壁纸」本身仍会在滑到那个位置时失败。** 修复后它只影响这一个词，不再拖垮后面的词。下次再出现时，`diagnose` 会显示是哪条规则，到时再决定是否对这类内容放宽。
- **“结果已看完”（连续两屏没有新卡片就停）。** 这批任务的发布时间筛选是「一天内」，数量少可能是真实情况，需要在手机上对照一次。
- **浏览器补详情 / 入库环节**（12:25 后西瓜节点没再领任务、`detail_finished_without_ingestion`）要查生产库，本次未查。

## 0.2.4：视频「展开」后被判“离开详情页”（每个词丢 2–3 条）

**真机校准（2026-09-26 17:00，DE106，抖音 40.6.0）。** 停掉 0.2.2 后，用 0.2.3 的 Runner 适配器自己的流程（搜索 → 读卡片 → 打开 → 展开）重现「凯迪拉克车机壁纸」里被跳过的作品（作者「感受深蓝」），并在点击前后各抓一次页面结构和截图：

- 点击位置正确：文案区域 x 30–847、y 1747–1861，点在 (798, 1832)，正是「展开」两个字。
- 这类视频点「展开」后，抖音不是原地展开文案，而是从下方弹出**作品详情面板**：作者 `g_5`（不带 @）、完整文案 `g=7`、「关注」`g_3`、标题「相关推荐」`g_f`，下面是推荐列表。右侧的分享按钮被面板盖住。
- `g=7` 的文字末尾还带着发布时间：“…#车载大屏    23小时前”。详情页原本就有发布时间节点 `4wp`：“ · 23小时前”。
- 旧逻辑只认原地展开，把面板当成“离开了详情页”，于是跳过（`left_detail`）。

**改动（`src/device/douyin-detail.mjs`）：**

- 认出这个面板：`相关推荐` 标题、`g=7`、`g_5` 各恰好一个。只有当末尾的时间与点击前详情页 `4wp` 显示的时间逐字相同、且前面有空白时，才去掉这个时间；剩下的文案（只忽略空白）和作者必须与卡片完全一致。
- 一致时按返回键关闭面板，并要求回到的正是同一个折叠详情（文案和作者都不变、面板已关）；这时才返回。返回的对象就是详情页本身（含分享按钮），`title` 换成面板里的完整文案，与原地展开的结果同形，后面复制链接的身份校验照旧。
- 面板里是别的文案、作者或时间：连续两次后判 `panel_mismatch`，不按返回，按原有“安全返回结果页后跳过”处理。面板关不掉或回来的不是同一条：`panel_not_closed`，同样跳过。这两个结果与原有其它结果一样只上传结果码，文案只留在本机记录里。
- 复制链接前后的两次复核也走同一条路径（每次展开并关闭一次面板），多花几秒，但没有新增需要信任的逻辑。

**验证：**

| 检查 | 结果 |
|---|---|
| 用真机抓到的两份页面结构（点击前、面板）回放新逻辑 | 通过：点「展开」→ 面板匹配 → 返回 → 同一详情页，有分享按钮；旧逻辑回放为 `left_detail` |
| 新增 `test/caption-panel-20260926.test.mjs`（按实测结构构造，内容为合成文字） | 3/3；换回旧 `douyin-detail.mjs` 为 0/3 |
| Runner 全套（串行） | 189/189 |
| 边界脚本、Runner 接口约定测试 | 通过 |

## 上线

只替换本机手机 Runner：把 `runners/android` 复制成新的运行目录（沿用 `StarVoice-Android/runtime-<版本>-<提交>` 的命名），停掉旧的 `cli.mjs up`（当前 PID 45749，`runtime-0.2.2-45c049b`），再从新目录用同一个 `--state-dir` 启动 `up`。回滚：从旧目录重新启动。服务端不用动。
