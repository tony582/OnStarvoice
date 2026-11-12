# 独立预览浏览器

`enable-wechat` 在用户明确启用微信时准备 Chrome for Testing；`setup --wechat-preview true` 只预装浏览器。日常 `up`、心跳和任务读取不安装、不升级浏览器。已有可用安装会直接复用。

安装位置为 `~/.local/share/starvoice/chrome-for-testing/<版本>/<mac-arm64 或 mac-x64>/`；对应架构的 `current-*.json` 选择当前版本。按 Node 架构选择 arm64 或 x64；Rosetta 下的 x64 Node 使用 x64 浏览器。`--chrome` 显式指定的用户路径优先，并写入 `chromeExplicit`；旧的系统默认路径自动迁移，旧 managed 路径必须继续通过安装收据和可执行文件哈希检查。

安装器仅访问 [Chrome for Testing 官方版本清单](https://github.com/GoogleChromeLabs/chrome-for-testing) 和官方 `chrome-for-testing-public` 存储桶，拒绝跳转。根据 Stable 清单选出准确的平台对象，再读取 [Google Cloud Storage 对象元数据](https://docs.cloud.google.com/storage/docs/json_api/v1/objects)，固定 generation 下载，核对完整字节数与 MD5/CRC32C。SHA-256 是本地安装收据中的复查值，不能称为 Google 发布的 SHA-256。下载有覆盖响应体的期限和 512 MiB 上限。

解压使用 Python 3.9 以上的 `zipfile` 标准库。解压前检查所有文件名、类型、条数、声明大小；最多 50,000 项，单文件 1 GiB，总计 2 GiB。拒绝目录穿越、绝对路径、大小写重名、加密和特殊文件。普通文件使用独占创建，Framework 的相对符号链接最后创建，并验证整条链接链只能指向安装目录内的现有内容。实际字节数和 ZIP CRC 也必须通过。

安装前核对 Info.plist 的独立应用标识、版本、可执行文件名，以及主 Mach-O 的格式、架构和执行权限。存在的签名必须通过只读完整性校验；允许官方包的 ad-hoc 签名，x64 无签名发行物依靠官方 HTTPS 和固定 generation 的压缩包校验确认来源，arm64 缺失签名则失败。不硬编码 Google Team ID，不重新签名或移除 quarantine。签名类型写入收据，不把 ad-hoc 签名称为发布者身份证明。随后对新下载的可执行文件运行有时限的 `--version` 核对版本。

每次安装使用独立 staging，完成全部验证后才原子移入版本目录，再原子更新 current 指针。并发安装只复用已完整验证的胜出版本，不覆盖已存在的有效安装。没有持久安装锁，意外中断不会锁住下次安装；普通错误会清理本次 staging，突然断电留下的 staging 不会被当作可运行安装，也不会擅自删除另一次安装的临时文件。若已有目标版本目录损坏则拒绝覆盖，并报告 `chrome_install_existing_invalid`。

自动选择不把 managed 路径固定写进手机配置，每次创建预览组件都核对收据和主可执行文件 SHA-256。安装失败时若系统 Chrome 可用会回退并提示一次，错误码仍保留在命令结果的 `previewBrowser.installError`。没有可用浏览器时命令失败；不会通过重新签名、修改系统设置或关闭用户 Chrome 来掩盖错误。

离线测试使用固定假元数据、小型 ZIP、伪 Mach-O 和注入的 macOS 工具结果。仅 Python 解压是真实执行；没有下载或运行真实 Chrome，没有访问微信或操作真机。真实安装、签名形态及 Chrome 并行使用的最终验收交给 Claude。
