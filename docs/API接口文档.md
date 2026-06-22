# StarVoice 星语 · API 接口文档

后端 REST API 参考。基址:本地 `http://localhost:3001/api`,生产 `https://voice.minilife.online/api`。

---

## 基础约定

**响应格式**:统一 JSON,成功 `{ "ok": true, ... }`,失败 `{ "ok": false, "error": "...", "message": "..." }`。

**认证头**(按场景):
| 头 | 用途 |
|---|---|
| `x-auth-code` | **扩展采集**(`/api/sync`)的授权码 |
| `x-session-token`(或 cookie `osv_session`) | **后台用户**会话 |
| `x-tenant-id` | 指定操作哪个**租户**(后台必带) |
| `x-admin-token` | 平台管理端点(`/api/admin/*`) |

多数后台端点经 `requireTenantAccess` 守卫:需有效会话 + 该用户对 `x-tenant-id` 有权限;写操作另需 `tenant_admin` / `tenant_analyst` 角色。

---

## 认证 `/api/auth`
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/login` | 登录,返回会话 |
| POST | `/logout` | 登出 |
| GET | `/me` | 当前用户 + 所属租户/角色 |

## 采集同步 `/api/sync`(扩展用)
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/` | 同步**单条**采集记录(作品 + 可含评论 `commentsCleanedItems`) |
| POST | `/batch` | 同步**多条**(`{ records: [...] }`) |

> 入库流程:`normalizeRecord` 归一化 → `upsertCapturedRecord` 写 `records` → 评论走 `upsertRecordComments`(规则快入库,后台 AI 再精炼)→ 异步 AI 标注作品。详见 [README §2](../README.md)。

## 内容分诊 `/api/triage`
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/records` | 分诊列表。查询参:`platform` `sentiment` `risk`(alert/negative/koe)`status`(处置状态)`sort`(publish/interactions)`dir`(asc/desc)`queue=active`/`bucket=archived` `keyword` `page` `pageSize` |
| PATCH | `/records/:recordId` | 改单条处置状态(note) |
| PATCH | `/records/batch` | 批量改处置状态(`{ ids, status }`) |
| POST | `/records/:recordId/issues` | 该记录转/关联事件 |

## 记录 `/api/records`
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/:id/comments` | 某作品的评论 |
| GET | `/:id/observations` `/:id/versions` | 命中观测 / 历史版本 |
| PATCH | `/:id/official-response` | 标记官方已响应 |
| GET | `/:id/transcript` · POST `/:id/transcribe` · POST `/:id/analyze-transcript` | 视频逐字稿:取/转写/AI 分析 |
| GET | `/:id/media-proxy` · `/tables/:table` | 媒体代理 / 数据底座表 |

## 评论与销售客资 `/api/comments`、`/api/leads`
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/comments/:id/issues` | 评论转事件 |
| GET | `/leads/comments` | 客资列表 |
| PATCH | `/leads/comments/:id` · `/comments/batch` | 改单条/批量客资状态 |
| POST | `/leads/comments/rejudge-sales` | AI 一键重判购买意向(清存量) |

## 工作台 `/api/workspace`
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/badges` | 侧边栏徽标计数(待处理/客资/事件…) |
| GET | `/processing` | **评论 AI 精炼进度**(`pendingPosts`/`pendingComments`,进度条用) |
| GET | `/overview` | 指挥中心总览(KPI/情感/趋势/最新…) |
| GET | `/events` | 事件中心(聚类 issue) |

## 监控 `/api/monitor`
| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/subscriptions` · PATCH `/subscriptions/:id` | 监控订阅增改查 |
| GET | `/executions` `/hits` `/due` | 执行记录 / 命中 / 到期 |
| POST | `/run-now` · `/executions/:id/start` · `/finish` | 立即运行 / 执行生命周期 |
| GET/PUT | `/settings` | 监控设置 |

## 事件与工单 `/api/issues`、`/api/tickets`
| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/issues` · GET/PATCH `/issues/:id` | 事件增改查 |
| POST | `/issues/:id/events` `/records` | 事件加动态/关联记录 |
| POST/GET | `/tickets` · `/tickets/dispatched` `/assignees` | 工单创建/列表/派发/处理人 |
| PATCH | `/tickets/:id` · `/tickets/:id/review` | 工单更新 / 反馈复核 |

## 报告与分析 `/api/reports`、`/api/analytics`
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/reports` · `/reports/:id` · `/:id/preview` | 报告列表/详情/预览 |
| POST | `/reports/generate` · `/:id/send` `/:id/resend` | 生成 / 发送 / 重发 |
| GET | `/analytics/dashboard` · `/analytics/ai-insight` | 分析看板 / AI 研判 |

## 其他
`/api/content` `/api/keyword-analysis` `/api/keyword-opportunity` `/api/benchmark-discovery`(内容创意);`/api/admin/*`(平台管理,`x-admin-token`:测试邮件、跑标注、生成报表);`/api/user` `/api/target` `/api/verify` `/api/update-manifest`(扩展更新清单)`/api/img`(图片代理)`/api/asr-media`(百炼 ASR 临时媒体托管,公网无鉴权、token 一次性);`GET /api/health` 健康检查。

---

## 关键端点示例

**采集同步(扩展)**
```http
POST /api/sync/batch
x-auth-code: <授权码>
Content-Type: application/json

{ "records": [ { "syncType": "single_note", "platform": "douyin",
  "payload": { "noteId": "...", "title": "...", "publishTime": "...",
               "commentsCleanedItems": [ ... ] } } ] }
```

**分诊列表(后台)**
```http
GET /api/triage/records?queue=active&risk=negative&sort=publish&dir=desc&page=1
x-session-token: <会话>
x-tenant-id: <租户ID>
```

> 架构/数据流见 [`README.md`](../README.md),部署见 [`deploy/DEPLOY.md`](../deploy/DEPLOY.md)。
