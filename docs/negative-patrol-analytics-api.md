# 负面巡查分析接口

## 统计口径

- 只统计父任务或执行任务明确标记为 `negative_post_patrol` 的工作项，不根据任务标题推断。
- 每条内容以本周期最后一个负面巡查工作项为准。
- 互动增量只使用任务下发时写入 `capture_task_items.metadata.baseline` 的基线，与该工作项的 `result_observation_id` 结果快照配对。
- 缺少任一快照时 `measured=false`、`delta=null`，表示“待形成基线”；真实前后数值相同才返回 0 增量。

## 聚合查询

`GET /api/capture-cloud/negative-patrol/analytics`

查询参数：

| 参数 | 说明 |
| --- | --- |
| `periodStart` / `periodEnd` | ISO 日期时间；默认最近 7 天，单次最多 366 天 |
| `keywords` | 逗号分隔或重复参数，最多 100 个 |
| `platform` | 可选：`xiaohongshu`、`douyin`、`weibo` |
| `status` | 可选：`available`、`unavailable`、`baseline_pending` |

`high_risk` 暂不支持：当前巡查工作项没有可靠、统一的风险等级字段，接口会返回 `unsupported_analytics_status`。

返回值 `negativePatrol`：

- `summary`：负面帖子声量、已测量/待形成基线数量、不可访问数量及互动净增量。
- `trend`：按日声量和互动增量。
- `platforms` / `topics`：平台和关键词分布。
- `risingRecords`：升温帖子；未形成基线的帖子保留并标记 `measured=false`。
- `status`：当前筛选结果中的状态计数。

平台、状态和关键词筛选在聚合前生效，因此 KPI、趋势、分布、主题和帖子列表使用同一范围。

## 单帖巡查时间线

`GET /api/capture-cloud/negative-patrol/posts/:recordId/timeline`

返回 `record`、`summary`、`snapshots` 和 `runs`。为兼容现有详情页，以上字段同时位于响应顶层和 `timeline` 属性内。时间、互动数、增量等关键字段同时保留 snake_case 与 camelCase 别名。

## 报表复用

管理报告、数据看板和邮件摘要使用同一个聚合服务。报告中“负面帖子声量”与“互动增长”遵循上述基线配对规则，不会把首次巡查展示成 0 增量。
