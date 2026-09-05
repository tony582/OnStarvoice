# PR #38：测试时间修复与验证

日期：2026-09-05。用户在收到 PR #38 首轮 CI 失败及时间依赖诊断后要求“继续”。本次只修测试及更新证据说明，保持 Draft；没有 Extension/服务端运行逻辑、30天保留规则或客户环境修改。

## 原因与修改

原 head `4a08ca92840f8c5645d06d45a0b9170e930be95a` 的 [push CI](https://github.com/tony582/OnStarvoice/actions/runs/33958176123) 和 [PR CI](https://github.com/tony582/OnStarvoice/actions/runs/33958188392) 合计8/12通过。四个Node检查都在 `tests/background-capture-lock.test.mjs` 的同两条测试失败，八个PostgreSQL检查通过。

两条测试分别验证错误信息传递，以及原生资源已释放后同步失败仍更新唯一账本。它们使用固定的 `2026-08-03T05:00:05.000Z` 和 `2026-08-03T05:10:00.000Z` 作为完成时间，但 harness 使用真实当前时间。`utils/task-center.js` 会按默认30天、优先 finishedAt 清理终态，并在 upsert 后立即再次规范化；9月5日时这些 fixture 已过期，因此记录不存在/数量为0。

改动仅为：

- 将这两处非保留期测试的完成时间改为执行测试时的 `new Date().toISOString()`，与既有相邻测试一致；原状态、错误传播、资源释放及唯一账本断言全部保留。
- 在 `tests/task-center.test.mjs` 新增一个固定 `NOW` 的默认保留期用例，覆盖 `completed_with_warnings` 和 `failed` 两种终态的 `cutoff−1ms / cutoff / cutoff+1ms`。即使 updatedAt 是当前时间，过期 finishedAt 仍淘汰，恰好30天及其内仍保留。
- 原有受控时间下31天淘汰、最多300条终态、旧 running/needs_action 保留用例不变。未改生产规则来使测试通过。

## 本地验证

在独立 worktree 中直接运行Node测试，未调用重建 `extension-build` 的 `npm test` 或打包脚本。测试使用已有模拟Chrome/存储/云任务对象；没有启动真实浏览器、服务器或数据库。

| 检查 | 结果 |
|---|---|
| 修改前 Node 24.12.0，仅选择原失败两条 | 0/2通过；与CI相同的 undefined.status 和0≠1 |
| 修改后 Node 24.12.0，完整两个测试文件 | 217/217通过，0失败/跳过 |
| 修改后 Node 18.20.8，完整两个测试文件 | 217/217通过，0失败/跳过 |

运行命令：

```sh
node --test --test-reporter=spec \
  tests/background-capture-lock.test.mjs tests/task-center.test.mjs
```

Node18使用同一命令和 `18.20.8` 可执行文件。本地测试不等于完整CI、真实浏览器或生产验收。新提交的完整CI在PR状态中记录，仍须保持Draft等待全部检查；不把原head的失败结果写成新head通过，也不改写原始证据JSON。

## 保护边界

本次主干、PR #37 head `8b23632027c1c788a3400ab90cc07aa26a6c435b`、PR #29、客户交付目录均未修改。测试修复不代表E-base归并或E1实施已完成，也不证明G3关闭。后续先对稳定hotfix及配套测试/服务端依赖建立精确归并范围。
