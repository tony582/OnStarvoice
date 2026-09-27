# 无人值守自愈 0.4.19 发布

本目录是发布器源码。运行前必须由发布准备步骤生成独立暂存目录，其中包含：

- `deploy.sh`、`deploy.mjs`：本目录原样复制。
- `release.json`：生产基线 `31b51d1`、完整 sourceHead、每个变更文件 oldSha/newSha、未变文件 guards、版本及新旧扩展包文件名。
- `payload/`：仅包含本次服务端变更、已构建 Admin 和生产目标扩展 zip。
- `ci.json`：`gh run view <run-id> --json headSha,status,conclusion,jobs` 的原始结果；严格匹配 sourceHead，五个 job 均已完成并成功。
- `SHA256SUMS`：整个暂存包的文件摘要（不含自身），在上传后先校验。

先在本地使用 Node 18.20.8 演练，包括正常发布、错误基线拒绝、中途切换失败与就绪失败回滚。模拟目录名称以 `simulation-` 开头，`--simulate` 只替换 PM2/HTTP，文件备份、逐文件 SHA、临时文件原子 rename 和回滚代码与生产相同。

生产部署须经用户明确同意后才允许上传。暂存于
`/opt/onstarvoice-private/releases/unattended-self-heal-<short-sha>-20260927/`：

1. `sha256sum -c SHA256SUMS`。
2. `bash deploy.sh --check`：只读；检查所有变更的旧文件 SHA、guard、线上 0.4.18 清单、Node 18.20.8、PM2 入口和就绪。
3. `bash deploy.sh`：再次校验，先完整备份，再对每个文件用临时文件原子替换；重启 PM2 onstarvoice；验证就绪、运行 PID/启动时间、0.4.19 清单、HTTP 扩展下载及 Admin 资源 SHA。
4. 任一步失败自动恢复原文件，移除本次新增文件，重启并验证回到 31b51d1 / 0.4.18。结果写入 `rollback.json`；回滚不完整时明确失败退出。已经使用的暂存目录不能覆盖备份重跑。
5. 不修改 `server/.env` 或数据库结构；部署前后比较环境文件摘要。保留 `CAPTURE_FILTER_VERIFICATION_LIMIT=20`、`PG_GENERAL_WAIT_MS=3000`。

部署成功后才同步本机实际加载的 `extension-build`。先完整备份为
`extension-build.rollback-v0418-before-<short-sha>`，然后原目录替换。扩展没有 manifest key，不能通过换目录升级。各节点逐台重载并重启浏览器；Windows 同样原目录替换。

模拟：

```sh
bash deploy.sh --simulate /absolute/path/simulation-success
bash deploy.sh --simulate /absolute/path/simulation-mid-switch --fail=mid-switch
bash deploy.sh --simulate /absolute/path/simulation-readiness --fail=readiness
```

模拟不能证明生产浏览器页面行为或真实 PM2 重启；这些分别由扩展/服务端联调与经批准后的上线验收完成。
