import { Router } from 'express';

const router = Router();

export const EXTENSION_UPDATE_MANIFEST = Object.freeze({
  latestVersion: '0.3.59',
  minSupportedVersion: '0.3.51',
  releaseDate: '2026-07-26',
  downloadUrl: 'https://voice.minilife.online/downloads/StarVoice-extension-v0.3.59-20260726.zip',
  changelogUrl: 'https://voice.minilife.online/changelog',
  releases: [
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
