/**
 * 采集图片落地自有存储 —— 平台 CDN 地址是限时链接(小红书路径带时间戳、约1天过期),
 * 过期后 403、图裂。本模块在采集入库时(链接还新鲜)把封面和正文图下载到服务器本地磁盘,
 * 列表/详情优先读 /media 下的本地副本,避免历史内容随平台链接过期而丢图。
 *
 * 存储抽象:只有 downloadImage() 直接落盘 —— 将来换阿里云 OSS 只改这一个函数。
 * 存储目录 MEDIA_DIR(默认 /opt/onstarvoice/media)在 deploy 的 rsync 之外,部署不会被清空。
 * 复用 media-proxy 的 Referer 规则与 host 白名单(防盗链 + 防 SSRF)。
 */
import { mkdirSync, createWriteStream, existsSync } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { queryOne, queryAll, execute } from '../db/query.js';
import { resolveReferer, isAllowedMediaHost } from './media-proxy.js';
import { runProcessBackgroundWork } from '../runtime/process-background-work.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// server 在 /opt/onstarvoice/server,上两级 + media = /opt/onstarvoice/media(rsync 不碰)
export const MEDIA_DIR = process.env.MEDIA_DIR || join(__dirname, '..', '..', 'media');
const COVERS_DIR = join(MEDIA_DIR, 'covers');
const IMAGES_DIR = join(MEDIA_DIR, 'images');

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_BYTES = 8 * 1024 * 1024;
const EXT_BY_TYPE = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/bmp': 'bmp' };

export function ensureMediaDirs() {
  try {
    mkdirSync(COVERS_DIR, { recursive: true });
    mkdirSync(IMAGES_DIR, { recursive: true });
  } catch { /* ignore */ }
}

// 下载单张图片 → 落盘 → 返回对外路径;任何失败返回 null(调用方回退原链接)。换 OSS 只改这里。
async function downloadImage(url, key, platform, targetDir, publicDir) {
  if (!url || !/^https?:\/\//i.test(url) || !isAllowedMediaHost(url)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let tempPath = '';
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
    const targetPath = join(targetDir, filename);
    tempPath = `${targetPath}.${process.pid}.${Date.now()}.part`;
    await pipeline(Readable.fromWeb(resp.body), createWriteStream(tempPath));
    await rename(tempPath, targetPath);
    tempPath = '';
    return `/media/${publicDir}/${filename}`;
  } catch {
    return null;
  } finally {
    if (tempPath) await unlink(tempPath).catch(() => {});
    clearTimeout(timer);
  }
}

async function downloadCover(url, key, platform) {
  return downloadImage(url, key, platform, COVERS_DIR, 'covers');
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
  void runProcessBackgroundWork(
    () => ensureCoverLocal(recordId, coverUrl, platform),
    { label: 'CoverLocalization' },
  );
}

export function imageSourceIdentity(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    const hostname = String(parsed.hostname || '').toLowerCase();
    const isDouyinImageHost = [
      'douyinpic.com',
      'byteimg.com',
      'pstatp.com',
      'bytecdn.cn',
    ].some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
    if (isDouyinImageHost) {
      const pathSegments = String(parsed.pathname || '').split('/').filter(Boolean);
      const lastSegment = decodeURIComponent(pathSegments.at(-1) || '');
      // 同一抖音素材会因搜索页/详情页生成不同签名、格式和尺寸后缀。
      // `~` 前的素材 token 才是稳定身份，不能按整条限时 URL 重复下载。
      const assetToken = lastSegment.split('~')[0].trim();
      if (assetToken) return `douyin:${assetToken}`;
    }
  } catch {
    // 非标准 URL 继续使用原值，保持旧行为。
  }
  return raw;
}

function parseImageUrls(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { parsed = []; }
  }
  if (!Array.isArray(parsed)) return [];
  const urls = [];
  const seen = new Set();
  for (const item of parsed) {
    const url = typeof item === 'string' ? item.trim() : String(item?.url || '').trim();
    const identity = imageSourceIdentity(url);
    if (!/^https?:\/\//i.test(url) || !identity || seen.has(identity)) continue;
    seen.add(identity);
    urls.push(url);
    if (urls.length >= 20) break;
  }
  return urls;
}

function parseLocalImageEntries(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { parsed = []; }
  }
  return Array.isArray(parsed) ? parsed : [];
}

function imageSourceHash(url) {
  return createHash('sha256')
    .update(imageSourceIdentity(url))
    .digest('hex')
    .slice(0, 20);
}

function localImageExists(url) {
  const prefix = '/media/';
  if (!String(url || '').startsWith(prefix)) return false;
  return existsSync(join(MEDIA_DIR, String(url).slice(prefix.length)));
}

export async function ensureRecordImagesLocal(recordId, imageUrls, platform) {
  const urls = parseImageUrls(imageUrls);
  if (!recordId || urls.length === 0) return;
  try {
    const row = await queryOne('SELECT image_local_urls FROM records WHERE id = $1', [recordId]);
    if (!row) return;
    const current = new Map();
    for (const entry of parseLocalImageEntries(row.image_local_urls)) {
      const hash = String(entry?.source_hash || '');
      const sourceUrl = String(entry?.source_url || '');
      const url = String(entry?.url || '');
      if (!url || !localImageExists(url)) continue;
      if (hash) current.set(hash, url);
      // 兼容旧版本按完整签名 URL 生成的 source_hash：只要素材 token 相同，
      // 新采集的 URL 变了也直接复用已经落地的文件。
      if (sourceUrl) current.set(imageSourceHash(sourceUrl), url);
    }

    await acquire();
    try {
      const localized = [];
      for (const url of urls) {
        const sourceHash = imageSourceHash(url);
        let localUrl = current.get(sourceHash) || '';
        if (!localUrl) {
          localUrl = await downloadImage(url, `${recordId}-${sourceHash}`, platform, IMAGES_DIR, 'images') || '';
        }
        if (localUrl) localized.push({ source_url: url, source_hash: sourceHash, url: localUrl });
      }
      await execute(
        'UPDATE records SET image_local_urls = $1::jsonb WHERE id = $2',
        [JSON.stringify(localized), recordId],
      );
    } finally {
      release();
    }
  } catch { /* 采集主流程不因图片落地失败而失败 */ }
}

export function queueRecordImagesLocalization(recordId, imageUrls, platform) {
  void runProcessBackgroundWork(
    () => ensureRecordImagesLocal(recordId, imageUrls, platform),
    { label: 'RecordImagesLocalization' },
  );
}

// 启动回填:近 24h 采集、还没落地的图片(链接多半还有效)批量下载。过期的会下载失败、自动跳过。
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

export async function backfillRecentImages(limit = 400) {
  try {
    const rows = await queryAll(
      `SELECT id, image_urls, platform FROM records
       WHERE image_urls <> '[]'::jsonb
         AND jsonb_array_length(COALESCE(image_local_urls, '[]'::jsonb))
             < jsonb_array_length(COALESCE(image_urls, '[]'::jsonb))
         AND last_seen_at > now() - interval '24 hours'
       ORDER BY last_seen_at DESC LIMIT $1`,
      [limit],
    );
    await Promise.all(rows.map((r) => ensureRecordImagesLocal(r.id, r.image_urls, r.platform)));
    return rows.length;
  } catch {
    return 0;
  }
}
