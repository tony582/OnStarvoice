import { Router } from 'express';

const router = Router();

export const EXTENSION_UPDATE_MANIFEST = Object.freeze({
  latestVersion: '0.3.55',
  minSupportedVersion: '0.3.51',
  releaseDate: '2026-07-25',
  downloadUrl: 'https://voice.minilife.online/downloads/StarVoice-extension-v0.3.55-20260725.zip',
  changelogUrl: 'https://voice.minilife.online/changelog',
  releases: [
    {
      version: '0.3.55',
      releaseDate: '2026-07-25',
      releaseNotes: [
        {
          tag: '新增',
          notes: [
            {
              title: '远程任务运行报告',
              desc: '按关键词展示进度、保存数、尝试次数、失败原因与设备心跳。',
            },
          ],
        },
        {
          tag: '优化',
          notes: [
            {
              title: '明确区分零结果与页面异常',
              desc: '筛选范围内无匹配内容按 0 条正常完成，页面未就绪继续保留为异常。',
            },
            {
              title: '一次性任务文案与执行逻辑',
              desc: '一次性采集不再显示为无人值守，也不会意外开启隐藏的额外轮次。',
            },
          ],
        },
        {
          tag: '修复',
          notes: [
            {
              title: '冻结标签页恢复',
              desc: '优先唤醒原运行页，避免重新执行当前关键词。',
            },
            {
              title: '风控原因识别',
              desc: '平台安全限制会明确标记为风控信号，不再混入普通异常。',
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
