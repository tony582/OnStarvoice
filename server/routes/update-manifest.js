import { Router } from 'express';

const router = Router();

export const EXTENSION_UPDATE_MANIFEST = Object.freeze({
  latestVersion: '0.3.57',
  minSupportedVersion: '0.3.51',
  releaseDate: '2026-07-26',
  downloadUrl: 'https://voice.minilife.online/downloads/StarVoice-extension-v0.3.57-20260726.zip',
  changelogUrl: 'https://voice.minilife.online/changelog',
  releases: [
    {
      version: '0.3.57',
      releaseDate: '2026-07-26',
      releaseNotes: [
        {
          tag: '新增',
          notes: [
            {
              title: '安全验证人工介入',
              desc: '识别平台安全验证后暂停继续搜索，并在调度中心提供人工处理入口。',
            },
          ],
        },
        {
          tag: '优化',
          notes: [
            {
              title: '空闲 Agent 接力',
              desc: '任务受阻时可把尚未开始的关键词交给空闲 Agent 继续执行。',
            },
            {
              title: '保留已采集结果',
              desc: '出现安全验证时保留当前已发现和已保存的数据，避免重复采集。',
            },
          ],
        },
        {
          tag: '修复',
          notes: [
            {
              title: '异常搜索循环',
              desc: '平台阻断后不再反复重搜同一关键词，等待人工处理或安全接力。',
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
