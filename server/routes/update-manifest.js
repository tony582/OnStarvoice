import { Router } from 'express';

const router = Router();

export const EXTENSION_UPDATE_MANIFEST = Object.freeze({
  latestVersion: '0.3.56',
  minSupportedVersion: '0.3.51',
  releaseDate: '2026-07-25',
  downloadUrl: 'https://voice.minilife.online/downloads/StarVoice-extension-v0.3.56-20260725.zip',
  changelogUrl: 'https://voice.minilife.online/changelog',
  releases: [
    {
      version: '0.3.56',
      releaseDate: '2026-07-25',
      releaseNotes: [
        {
          tag: '新增',
          notes: [
            {
              title: '社交账号与 Agent 绑定',
              desc: '自动识别当前登录账号，并与浏览器 Agent 建立可追踪的使用关系。',
            },
          ],
        },
        {
          tag: '优化',
          notes: [
            {
              title: '账号每日用量统计',
              desc: '按账号记录搜索、详情增强、采集任务与采集条数，便于安排账号轮换和休息。',
            },
            {
              title: '离线用量可靠补传',
              desc: '网络中断时暂存用量事件，恢复后去重补传，并保留事件发生时的账号归属。',
            },
          ],
        },
        {
          tag: '修复',
          notes: [
            {
              title: '账号切换归属',
              desc: '切换登录账号后，历史用量仍归属于事件发生时的账号，不会串账。',
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
