import { Router } from 'express';

const router = Router();

export const EXTENSION_UPDATE_MANIFEST = Object.freeze({
  latestVersion: '0.3.70',
  minSupportedVersion: '0.3.51',
  releaseDate: '2026-07-30',
  downloadUrl: 'https://voice.minilife.online/downloads/StarVoice-extension-v0.3.70-20260730.zip',
  changelogUrl: 'https://voice.minilife.online/changelog',
  releases: [
    {
      version: '0.3.70',
      releaseDate: '2026-07-30',
      releaseNotes: [
        {
          tag: '修复',
          notes: [
            {
              title: 'Edge 账号巡查不再被误停止',
              desc: 'Edge 临时重建账号页目标时会继续当前巡查，不再把浏览器内部切换误判为用户取消；长任务持续上报进度，详情工作页中断后可续跑未完成作品。',
            },
          ],
        },
        {
          tag: '优化',
          notes: [
            {
              title: '官方账号按作品数量巡查',
              desc: '复用账号页采集增强，用户分别填写作品加载数量与每篇评论加载上限；新作品入库，已有作品也会重新读取并补充评论，不再按不可靠的列表日期过滤。',
            },
          ],
        },
      ],
    },
    {
      version: '0.3.67',
      releaseDate: '2026-07-29',
      releaseNotes: [
        {
          tag: '修复',
          notes: [
            {
              title: '官方账号评论巡查',
              desc: '修复账号主页识别、作品发布时间筛选和评论巡查结果回写，避免旧页面或非目标作品数据混入。',
            },
            {
              title: '任务尝试隔离',
              desc: '停止、重试与重分配按本次执行尝试严格隔离，避免旧指令误停新任务或覆盖新结果。',
            },
            {
              title: '巡查记录与工单',
              desc: '工单保留来源内容的舆情巡查与快照历史，便于持续查看声量和互动变化。',
            },
          ],
        },
      ],
    },
    {
      version: '0.3.66',
      releaseDate: '2026-07-29',
      releaseNotes: [
        {
          tag: '优化',
          notes: [
            {
              title: 'AI 前置筛选稳定性',
              desc: '缩小单批判断数量并延长等待时间；整批超时时自动拆分重试，减少高峰期未介入。',
            },
            {
              title: '采集不中断保护',
              desc: 'AI 超时或服务异常时安全放行并继续采集详情，不因筛选服务波动丢失内容。',
            },
            {
              title: '运行状态更清楚',
              desc: '任务进度会显示 AI 拆批重试、超时及安全放行数量，便于确认 AI 是否实际介入。',
            },
          ],
        },
      ],
    },
    {
      version: '0.3.65',
      releaseDate: '2026-07-28',
      releaseNotes: [
        {
          tag: '修复',
          notes: [
            {
              title: '抖音作品与评论采集',
              desc: '加强作品身份校验和评论数量读取，避免自动播放、推荐内容或旧页面数据写入目标作品。',
            },
            {
              title: '官方账号评论巡查',
              desc: '进入作品详情后按真实发布时间筛选，并只读取评论区域，避免误入 AI 页面。',
            },
            {
              title: '采集数据写回保护',
              desc: '阻止不确定或过期数据覆盖可信指标，并允许可靠的新采集结果修复历史异常值。',
            },
          ],
        },
      ],
    },
    {
      version: '0.3.64',
      releaseDate: '2026-07-28',
      releaseNotes: [
        {
          tag: '修复',
          notes: [
            {
              title: '定向巡查采集与回写',
              desc: '修复抖音作品身份校验、评论采集和重分配结果回写，确保当前执行结果可靠结算。',
            },
            {
              title: '删帖与异常页面识别',
              desc: '识别抖音和小红书已删除或不可用作品，及时结算并避免误采下一条内容。',
            },
            {
              title: '任务结束自动收尾',
              desc: '任务结束后暂停任务视频并返回抖音首页；需要人工介入时保留现场。',
            },
          ],
        },
      ],
    },
    {
      version: '0.3.61',
      releaseDate: '2026-07-27',
      releaseNotes: [
        {
          tag: '修复',
          notes: [
            {
              title: '负面巡查删帖结算',
              desc: '识别小红书作品已删除页面，并可靠回传任务终态，避免巡查长期停留在等待执行。',
            },
            {
              title: '任务完成页关闭',
              desc: '一次关闭即可退出全部已完成任务状态页，不再在两个完成界面之间反复切换。',
            },
          ],
        },
      ],
    },
    {
      version: '0.3.60',
      releaseDate: '2026-07-27',
      releaseNotes: [
        {
          tag: '修复',
          notes: [
            {
              title: '社交账号与 Agent 绑定',
              desc: '人工指定 Agent 后不再被心跳覆盖，并过滤无效账号身份与过期识别缓存。',
            },
          ],
        },
      ],
    },
    {
      version: '0.3.59',
      releaseDate: '2026-07-26',
      releaseNotes: [
        {
          tag: '修复',
          notes: [
            {
              title: '定向巡查运行页',
              desc: '修复未指定浏览器窗口时错误使用无效窗口 ID，导致负面帖子与官方账号评论巡查无法启动的问题。',
            },
          ],
        },
      ],
    },
    {
      version: '0.3.58',
      releaseDate: '2026-07-26',
      releaseNotes: [
        {
          tag: '新增',
          notes: [
            {
              title: '负面帖子巡查',
              desc: '按发布时间、平台与负面条件筛选帖子，并定向采集详情。',
            },
            {
              title: '官方账号评论巡查',
              desc: '按时间范围筛选官方账号作品，由指定 Agent 定向采集评论。',
            },
          ],
        },
        {
          tag: '优化',
          notes: [
            {
              title: '定向详情采集',
              desc: 'Extension 可领取巡查任务并打开目标作品，按任务要求完成增强、评论和同步。',
            },
          ],
        },
      ],
    },
  ],
});

/**
 * GET /api/update-manifest
 * 扩展版本更新检查
 */
router.get('/', (req, res) => {
  return res.json({
    ok: true,
    data: {
      updateManifest: EXTENSION_UPDATE_MANIFEST,
    },
    ...EXTENSION_UPDATE_MANIFEST,
  });
});

export default router;
