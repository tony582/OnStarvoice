import express from 'express';
import { lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const EXTENSION_PACKAGE = /^\/StarVoice-extension-v\d+\.\d+\.\d+-\d{8}\.zip$/u;

// Only this dedicated directory contains files intended for anonymous download.
export function createPublicDownloadsRouter(directory) {
  const router = express.Router();
  const root = resolve(directory);
  const notFound = res => res.set('Cache-Control', 'no-store').sendStatus(404);

  router.use(async (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method) || !EXTENSION_PACKAGE.test(req.path)) {
      return notFound(res);
    }
    const filename = req.path.slice(1);
    const file = join(root, filename);
    try {
      const [info, resolvedFile, rootInfo, canonicalRoot] = await Promise.all([
        lstat(file), realpath(file), lstat(root), realpath(root),
      ]);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()
        || !info.isFile() || info.isSymbolicLink() || resolvedFile !== join(canonicalRoot, filename)) {
        return notFound(res);
      }
      res.set('X-Content-Type-Options', 'nosniff');
      return res.sendFile(filename, { root, dotfiles: 'deny', maxAge: '1h' }, error => {
        if (error && !res.headersSent) notFound(res);
      });
    } catch {
      return notFound(res);
    }
  });
  return router;
}
