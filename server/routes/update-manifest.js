import { Router } from 'express';

const router = Router();

/**
 * GET /api/update-manifest
 * 扩展版本更新检查
 */
router.get('/', (req, res) => {
  return res.json({
    ok: true,
    currentVersion: '0.1.0',
    latestVersion: '0.1.0',
    hasUpdate: false,
    downloadUrl: '',
    changelogUrl: '',
    releaseNotes: '',
  });
});

export default router;
