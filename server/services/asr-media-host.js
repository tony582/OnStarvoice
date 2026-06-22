/**
 * ASR 临时公网托管:百炼录音文件识别只认公网 URL,而抖音/小红书直链有 Referer 防盗链 +
 * 签名时效,百炼服务器直接拉会 403。所以这里:
 *   1) 由 server 带正确 Referer 把媒体下载到本地临时文件;
 *   2) 在 /api/asr-media/<一次性token> 暴露一个公网无鉴权地址(仅供百炼拉取);
 *   3) 转写完/超时后删临时文件 + 失效 token。
 *
 * 安全:token 不可猜(crypto 随机)、TTL 短、只服务我方下载下来的文件、不接受任意路径。
 */

import { Router } from 'express';
import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { resolveReferer } from './media-proxy.js';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TMP_DIR = join(tmpdir(), 'onstar-asr');
const STAGE_TTL_MS = Number(process.env.ASR_STAGE_TTL_MS) || 15 * 60 * 1000; // 15 分钟

/** name(token+ext) -> { path, contentType, expiresAt } */
const STORE = new Map();

function publicBaseUrl() {
  const explicit = process.env.PUBLIC_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, '');
  const cors = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const https = cors.find((o) => o.startsWith('https://'));
  return (https || 'https://voice.minilife.online').replace(/\/+$/, '');
}

function extFor(url, contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('mp4') || ct.includes('video/')) return '.mp4';
  if (ct.includes('mpeg') || ct.includes('mp3')) return '.mp3';
  if (ct.includes('m4a') || ct.includes('mp4a')) return '.m4a';
  if (ct.includes('aac')) return '.aac';
  if (ct.includes('wav')) return '.wav';
  const m = String(url || '').match(/\.(mp4|mp3|m4a|aac|wav|mov|webm|flv)(?:[?#]|$)/i);
  return m ? `.${m[1].toLowerCase()}` : '.mp4';
}

async function cleanupName(name) {
  const entry = STORE.get(name);
  if (!entry) return;
  STORE.delete(name);
  await unlink(entry.path).catch(() => {});
}

// 定期清理过期临时文件(兜底,正常路径转写完会主动 cleanup)
setInterval(() => {
  const now = Date.now();
  for (const [name, entry] of STORE) {
    if (now > entry.expiresAt) cleanupName(name);
  }
}, 60 * 1000).unref?.();

/**
 * 下载媒体到临时文件并返回公网 URL。
 * @returns {{ name, publicUrl, contentType, cleanup: () => Promise<void> }}
 * @throws err.code = 'EXPIRED'(403,直链过期)| 'FETCH_FAILED'
 */
export async function stageMediaForAsr({ url, platform, timeoutMs = 120000 }) {
  await mkdir(TMP_DIR, { recursive: true });
  const referer = resolveReferer(url, platform);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': BROWSER_UA, Accept: '*/*', ...(referer ? { Referer: referer } : {}) },
    });
  } catch (err) {
    clearTimeout(timer);
    const e = new Error(err?.name === 'AbortError' ? '下载媒体超时' : `下载媒体失败: ${err.message}`);
    e.code = 'FETCH_FAILED';
    throw e;
  }
  if (!resp.ok || !resp.body) {
    clearTimeout(timer);
    const e = new Error(
      resp.status === 403 ? '媒体直链已过期或被防盗链拦截(需重采)' : `下载媒体失败 ${resp.status}`,
    );
    e.code = resp.status === 403 ? 'EXPIRED' : 'FETCH_FAILED';
    throw e;
  }

  const contentType = resp.headers.get('content-type') || 'application/octet-stream';
  const ext = extFor(url, contentType);
  const name = `${randomBytes(24).toString('hex')}${ext}`;
  const filePath = join(TMP_DIR, name);
  try {
    await pipeline(Readable.fromWeb(resp.body), createWriteStream(filePath));
  } finally {
    clearTimeout(timer);
  }

  STORE.set(name, { path: filePath, contentType, expiresAt: Date.now() + STAGE_TTL_MS });
  return {
    name,
    publicUrl: `${publicBaseUrl()}/api/asr-media/${name}`,
    contentType,
    cleanup: () => cleanupName(name),
  };
}

/** 公网无鉴权路由,仅供百炼拉取临时托管的媒体。 */
export const asrMediaRouter = Router();

asrMediaRouter.get('/:name', async (req, res) => {
  const entry = STORE.get(req.params.name);
  if (!entry || Date.now() > entry.expiresAt) {
    await cleanupName(req.params.name);
    return res.status(404).end();
  }
  const st = await stat(entry.path).catch(() => null);
  if (!st) {
    await cleanupName(req.params.name);
    return res.status(404).end();
  }
  res.setHeader('Content-Type', entry.contentType);
  res.setHeader('Content-Length', st.size);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'HEAD') return res.end();
  createReadStream(entry.path).pipe(res);
});
