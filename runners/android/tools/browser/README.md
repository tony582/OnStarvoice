# 独立预览浏览器

`enable-wechat` 在用户明确启用微信时准备 Chrome for Testing；`setup --wechat-preview true` 只预装浏览器。日常 `up`、心跳和任务读取不安装、不升级浏览器。已有可用安装会直接复用。

安装位置为 `~/.local/share/starvoice/chrome-for-testing/<版本>/<mac-arm64 或 mac-x64>/`；对应架构的 `current-*.json` 选择当前版本。按 Node 架构选择 arm64 或 x64；Rosetta 下的 x64 Node 使用 x64 浏览器。`--chrome` 显式指定的用户路径优先，并写入 `chromeExplicit`；旧的系统默认路径自动迁移，旧 managed 路径必须继续通过安装收据和可执行文件哈希检查。

安装器仅访问 [Chrome for Testing 官方版本清单](https://github.com/GoogleChromeLabs/chrome-for-testing) 和官方 `chrome-for-testing-public` 存储桶，拒绝跳转。根据 Stable 清单选出准确的平台对象，再读取 [Google Cloud Storage 对象元数据](https://docs.cloud.google.com/storage/docs/json_api/v1/objects)，固定 generation 下载，核对完整字节数与 MD5/CRC32C。SHA-256 是本地安装收据中的复查值，不能称为 Google 发布的 SHA-256。下载有覆盖响应体的期限和 512 MiB 上限。

解压使用 Python 3.9 以上的 `zipfile` 标准库。解压前检查所有文件名、类型、条数、声明大小；最多 50,000 项，单文件 1 GiB，总计 2 GiB。拒绝目录穿越、绝对路径、大小写重名、加密和特殊文件。普通文件使用独占创建，Framework 的相对符号链接最后创建，并验证整条链接链只能指向安装目录内的现有内容。实际字节数和 ZIP CRC 也必须通过。

安装前核对 Info.plist 的独立应用标识、版本、可执行文件名，以及主 Mach-O 的格式、架构和执行权限。存在的签名必须通过只读完整性校验；允许官方包的 ad-hoc 签名，x64 无签名发行物依靠官方 HTTPS 和固定 generation 的压缩包校验确认来源，arm64 缺失签名则失败。不硬编码 Google Team ID，不重新签名或移除 quarantine。签名类型写入收据，不把 ad-hoc 签名称为发布者身份证明。随后对新下载的可执行文件运行有时限的 `--version` 核对版本。

每次安装使用独立 staging，完成全部验证后才原子移入版本目录，再原子更新 current 指针。并发安装只复用已完整验证的胜出版本，不覆盖已存在的有效安装。没有持久安装锁，意外中断不会锁住下次安装；普通错误会清理本次 staging，突然断电留下的 staging 不会被当作可运行安装，也不会擅自删除另一次安装的临时文件。若已有目标版本目录损坏则拒绝覆盖，并报告 `chrome_install_existing_invalid`。

自动选择不把 managed 路径固定写进手机配置，每次创建预览组件都核对收据和主可执行文件 SHA-256。安装失败时若系统 Chrome 可用会回退并提示一次，错误码仍保留在命令结果的 `previewBrowser.installError`。没有可用浏览器时命令失败；不会通过重新签名、修改系统设置或关闭用户 Chrome 来掩盖错误。

离线测试使用固定假元数据、小型 ZIP、伪 Mach-O 和注入的 macOS 工具结果。仅 Python 解压是真实执行；没有下载或运行真实 Chrome，没有访问微信或操作真机。真实安装、签名形态及 Chrome 并行使用的最终验收交给 Claude。

## 0.5.7 启动检查与预览回退

启动检查给独立浏览器最多 30 秒建立调试连接，同一采集器进程共享一次检查结果。`preview_browser_selfcheck_passed` 和 `preview_browser_selfcheck_failed` 均记录发生时间、`stage=launch` 和启动耗时。0.5.6 的对照 G 中，同一浏览器打开本机检查页耗时 9,763 ms，随后打开视频号页耗时 189 ms。0.5.7 移除了本机检查页。

自动选中的独立浏览器启动失败时，确认自有进程已退出后切换到可用的系统 Chrome，并提示一次。真实的视频号或文章预览返回 `preview_timeout` 时，先等已开始的预览结束，再确认独立浏览器退出。切换后仅重试超时的链接一次，后续预览使用系统 Chrome 直到采集器重启。诊断 `preview_browser_runtime_fallback` 记录超时时的任务种类、时间、耗时和独立浏览器版本。重试仍失败时返回该次错误。

解析错误和无效链接沿用原有处理。显式 `--chrome` 或系统 Chrome 缺失时保留失败。自有浏览器退出最多等 2 秒，仍未退出时预览报告未就绪，避免争用配置目录和端口。

## 预览验收的启动方式

预览类验收必须从普通 Terminal 或 Finder 启动，并记录进程祖先链、实际浏览器路径、配置目录完整路径、端口与版本。使用全新的临时配置目录，不复用日常 Chrome 的登录资料，也不停止用户的 Chrome。

2026-11-12 曾出现代理进程直接启动、配置目录在 `~/Documents` 下时预览超时的现象。补充对照 F 使用相同目录位置：Codex 批准执行与普通 Terminal 均成功（11,476 / 10,853 ms）。因此原因仍未确定，不能声称 macOS 隐私权限或 Documents 位置已被证明是根因；代理环境中的一次失败也不能单独代表 Finder 托管采集器的真实结果。

同日同字节官方 ZIP 的 Python/ditto 解压树逐文件内容、权限、符号链接与扩展属性零差异。0.5.7 真机复测分别记录视频号和文章的实际浏览器及结果，发生回退时保留诊断和重试结果。搜索、复制链接、留言与入库各自按真机证据验收。
