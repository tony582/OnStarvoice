/**
 * 封面图落地自有存储 —— 平台 CDN 封面是限时签名链接(小红书路径带时间戳、约1天过期),
 * 过期后 403、图裂。本模块在采集入库时(链接还新鲜)把封面下载到服务器本地磁盘,
 * 存为 /media/covers/<recordId>.<ext>,列表/详情优先读本地副本,永不过期。
 *
 * 存储抽象:只有 downloadCover() 直接落盘 —— 将来换阿里云 OSS 只改这一个函数。
 * 存储目录 MEDIA_DIR(默认 /opt/onstarvoice/media)在 deploy 的 rsync 之外,部署不会被清空。
 * 复用 media-proxy 的 Referer 规则与 host 白名单(防盗链 + 防 SSRF)。
 */
import { mkdirSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { queryOne, queryAll, execute } from '../db/query.js';
import { resolveReferer, isAllowedMediaHost } from './media-proxy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// server 在 /opt/onstarvoice/server,上两级 + media = /opt/onstarvoice/media(rsync 不碰)
export const MEDIA_DIR = process.env.MEDIA_DIR || join(__dirname, '..', '..', 'media');
const COVERS_DIR = join(MEDIA_DIR, 'covers');

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_BYTES = 8 * 1024 * 1024;
const EXT_BY_TYPE = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/bmp': 'bmp' };

export function ensureMediaDirs() {
  try { mkdirSync(COVERS_DIR, { recursive: true }); } catch { /* ignore */ }
}

// 下载单张封面 → 落盘 → 返回对外路径;任何失败返回 null(调用方回退原链接)。换 OSS 只改这里。
async function downloadCover(url, key, platform) {
  if (!url || !/^https?:\/\//i.test(url) || !isAllowedMediaHost(url)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const referer = resolveReferer(url, platform);
    const resp = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': BROWSER_UA, Accept: 'image/*,*/*', ...(referer ? { Referer: referer } : {}) },
    });
    if (!resp.ok || !resp.body) return null;
    const type = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const ext = EXT_BY_TYPE[type];
    if (!ext) return null; // 非图片(可能是 403 的 html 错误页)
    const len = Number(resp.headers.get('content-length') || 0);
    if (len && len > MAX_BYTES) return null;
    ensureMediaDirs();
    const filename = `${key}.${ext}`;
    await pipeline(Readable.fromWeb(resp.body), createWriteStream(join(COVERS_DIR, filename)));
    return `/media/covers/${filename}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 并发限流:批量入库 / 回填时避免瞬间几十个下载
const MAX_CONCURRENT = 4;
let active = 0;
const waiting = [];
function acquire() { return new Promise((res) => { if (active < MAX_CONCURRENT) { active++; res(); } else waiting.push(res); }); }
function release() { active--; const next = waiting.shift(); if (next) { active++; next(); } }

// 确保某记录封面已落地(已落地则跳过);失败静默,等下次回填重试。
export async function ensureCoverLocal(recordId, coverUrl, platform) {
  if (!recordId || !coverUrl) return;
  try {
    const row = await queryOne('SELECT cover_local FROM records WHERE id = $1', [recordId]);
    if (!row || (row.cover_local && String(row.cover_local).trim())) return; // 已落地或记录已删
    await acquire();
    try {
      const local = await downloadCover(coverUrl, recordId, platform);
      if (local) await execute('UPDATE records SET cover_local = $1 WHERE id = $2', [local, recordId]);
    } finally {
      release();
    }
  } catch { /* ignore */ }
}

// 非阻塞触发(入库后调用,不阻塞采集响应)
export function queueCoverLocalization(recordId, coverUrl, platform) {
  ensureCoverLocal(recordId, coverUrl, platform).catch(() => {});
}

// 启动/定时回填:近 24h 采集、还没落地的封面(链接多半还有效)批量下载。过期的会下载失败、自动跳过。
export async function backfillRecentCovers(limit = 800) {
  try {
    const rows = await queryAll(
      `SELECT id, cover_url, platform FROM records
       WHERE cover_url <> '' AND COALESCE(cover_local, '') = '' AND last_seen_at > now() - interval '24 hours'
       ORDER BY last_seen_at DESC LIMIT $1`,
      [limit],
    );
    await Promise.all(rows.map((r) => ensureCoverLocal(r.id, r.cover_url, r.platform)));
    return rows.length;
  } catch {
    return 0;
  }
}
