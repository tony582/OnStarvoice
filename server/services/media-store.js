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
import { rename, unlink, readFile, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { queryOne, queryAll, execute } from '../db/query.js';
import { resolveReferer, isAllowedMediaHost } from './media-proxy.js';
import { runProcessBackgroundWork } from '../runtime/process-background-work.js';
import {inspectWechatImage, WECHAT_IMAGE_MAX_BYTES} from './wechat-image-validation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// server 在 /opt/onstarvoice/server,上两级 + media = /opt/onstarvoice/media(rsync 不碰)
export const MEDIA_DIR = process.env.MEDIA_DIR || join(__dirname, '..', '..', 'media');
const COVERS_DIR = join(MEDIA_DIR, 'covers');
const AVATARS_DIR = join(MEDIA_DIR, 'avatars');
const IMAGES_DIR = join(MEDIA_DIR, 'images');

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_BYTES = 8 * 1024 * 1024;
const EXT_BY_TYPE = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/bmp': 'bmp' };

export function ensureMediaDirs() {
  try {
    mkdirSync(COVERS_DIR, { recursive: true });
    mkdirSync(AVATARS_DIR, { recursive: true });
    mkdirSync(IMAGES_DIR, { recursive: true });
  } catch { /* ignore */ }
}

// 下载单张图片 → 落盘 → 返回对外路径;任何失败返回 null(调用方回退原链接)。换 OSS 只改这里。
export async function downloadImage(url, key, platform, targetDir, publicDir, onFailure) {
  if (!url || !/^https?:\/\//i.test(url) || !isAllowedMediaHost(url)) return null;
  const article = platform === 'wechat_articles';
  const channels = platform === 'wechat_channels';
  const guarded = article || channels;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let tempPath = '';
  let overflowBytes = 0;
  try {
    let current = url, resp;
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (guarded) {
        const parsed = new URL(current);
        if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.port || !isAllowedMediaHost(current)) return null;
      }
      const referer = resolveReferer(current, platform);
      resp = await fetch(current, {
        redirect: guarded ? 'manual' : 'follow', signal: controller.signal,
        headers: { 'User-Agent': BROWSER_UA, Accept: 'image/*,*/*', ...(referer ? { Referer: referer } : {}) },
      });
      if (!guarded || resp.status < 300 || resp.status >= 400) break;
      const location = resp.headers.get('location');
      await resp.body?.cancel();
      if (!location || redirects === 3) return null;
      current = new URL(location, current).toString();
    }
    if (!resp.ok || !resp.body) {
      if (channels && [400, 403].includes(resp.status)) onFailure?.({code: 'upstream_rejected', httpStatus: resp.status});
      await resp.body?.cancel();
      return null;
    }
    const type = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const ext = EXT_BY_TYPE[type];
    if (!ext) return null; // 非图片(可能是 403 的 html 错误页)
    const len = Number(resp.headers.get('content-length') || 0);
    if (len && len > MAX_BYTES) {
      if (article && Number.isSafeInteger(len)) {
        onFailure?.({code: 'too_large', maxBytes: WECHAT_IMAGE_MAX_BYTES, observedBytes: len, source: 'content_length'});
        await resp.body.cancel();
      }
      return null;
    }
    ensureMediaDirs();
    const filename = `${key}.${ext}`;
    const targetPath = join(targetDir, filename);
    tempPath = `${targetPath}.${process.pid}.${guarded ? randomUUID() : Date.now()}.part`;
    if (guarded) {
      let received = 0;
      const bounded = new Transform({transform(chunk, encoding, done) {
        received += chunk.length;
        if (received > WECHAT_IMAGE_MAX_BYTES) overflowBytes = received;
        done(received > WECHAT_IMAGE_MAX_BYTES ? new Error('wechat_image_too_large') : null, chunk);
      }});
      await pipeline(Readable.fromWeb(resp.body), bounded, createWriteStream(tempPath));
      if (article) {
        const verified = inspectWechatImage(await readFile(tempPath), onFailure);
        if (!verified || verified.mime !== (type === 'image/jpg' ? 'image/jpeg' : type)) return null;
      }
    } else await pipeline(Readable.fromWeb(resp.body), createWriteStream(tempPath));
    await rename(tempPath, targetPath);
    tempPath = '';
    return `/media/${publicDir}/${filename}`;
  } catch {
    if (article && overflowBytes > WECHAT_IMAGE_MAX_BYTES) onFailure?.({code: 'too_large', maxBytes: WECHAT_IMAGE_MAX_BYTES,
      observedBytes: overflowBytes, source: 'stream'});
    return null;
  } finally {
    if (guarded) controller.abort();
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

// One signed URL has at most one in-process download. Database guards below keep
// late old-URL results from changing a newer capture, including its local file.
const channelMediaInFlight = new Map();
const CHANNEL_MEDIA = {
  cover: {source: 'cover_url', local: 'cover_local', error: 'cover_storage_error', directory: COVERS_DIR, publicDir: 'covers'},
  avatar: {source: 'author_avatar', local: 'author_avatar_local', error: 'author_avatar_storage_error', directory: AVATARS_DIR, publicDir: 'avatars'},
};

async function ensureChannelMediaLocal(recordId, url, kind) {
  if (!recordId || !url) return {status: 'missing'};
  const key = `${kind}:${recordId}:${url}`;
  if (channelMediaInFlight.has(key)) return channelMediaInFlight.get(key);
  const work = (async () => {
    const fields = CHANNEL_MEDIA[kind];
    await acquire();
    try {
      const row = await queryOne(`SELECT ${fields.source} AS source, ${fields.local} AS local,
        ${fields.error} AS error FROM records WHERE id=$1 AND platform='wechat_channels'`, [recordId]);
      if (!row || row.source !== url) return {status: 'stale'};
      if (String(row.local || '').trim()) return {status: 'existing'};
      if (row.error?.sourceUrl === url && [400, 403].includes(row.error.httpStatus)) {
        return {status: 'blocked', httpStatus: row.error.httpStatus};
      }
      if (row.error?.sourceUrl && row.error.sourceUrl !== url) {
        await execute(`UPDATE records SET ${fields.error}='{}'::jsonb WHERE id=$1 AND ${fields.source}=$2
          AND ${fields.error}->>'sourceUrl' IS DISTINCT FROM $2`, [recordId, url]);
      }
      let failure;
      // Different signed URLs must never overwrite each other's file before the
      // compare-and-set below. Keep the original URL in its original column.
      const fileKey = `${recordId}-${createHash('sha256').update(url).digest('hex').slice(0, 24)}`;
      const local = await downloadImage(url, fileKey, 'wechat_channels', fields.directory, fields.publicDir, value => {failure = value;});
      if (local) {
        const saved = await execute(`UPDATE records SET ${fields.local}=$1, ${fields.error}='{}'::jsonb
          WHERE id=$2 AND ${fields.source}=$3 AND ${fields.local}=''`, [local, recordId, url]);
        return {status: saved.changes ? 'saved' : 'stale'};
      }
      if (failure) {
        const marked = await execute(`UPDATE records SET ${fields.error}=$1::jsonb
          WHERE id=$2 AND ${fields.source}=$3 AND ${fields.local}=''`,
        [JSON.stringify({...failure, sourceUrl: url, checkedAt: new Date().toISOString()}), recordId, url]);
        return {status: marked.changes ? 'expired' : 'stale', httpStatus: failure.httpStatus};
      }
      return {status: 'failed'};
    } catch { return {status: 'failed'}; }
    finally { release(); }
  })();
  channelMediaInFlight.set(key, work);
  try { return await work; }
  finally { if (channelMediaInFlight.get(key) === work) channelMediaInFlight.delete(key); }
}

export async function ensureAvatarLocal(recordId, avatarUrl, platform) {
  if (platform !== 'wechat_channels') return {status: 'unsupported'};
  return ensureChannelMediaLocal(recordId, avatarUrl, 'avatar');
}

// Other platforms retain their existing localization and retry policy.
export async function ensureCoverLocal(recordId, coverUrl, platform) {
  if (platform === 'wechat_channels') return ensureChannelMediaLocal(recordId, coverUrl, 'cover');
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
export function queueCoverLocalization(recordId, coverUrl, platform, avatarUrl = '') {
  void runProcessBackgroundWork(
    () => Promise.all([ensureCoverLocal(recordId, coverUrl, platform),
      ...(platform === 'wechat_channels' ? [ensureAvatarLocal(recordId, avatarUrl, platform)] : [])]),
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

function parseImageUrls(value, limit = 20) {
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
    if (urls.length >= limit) break;
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

export async function verifiedArticleLocalImage(url, onFailure) {
  if (!String(url || '').startsWith('/media/')) return null;
  const path = resolve(MEDIA_DIR, url.slice('/media/'.length));
  if (!path.startsWith(resolve(MEDIA_DIR) + sep)) return null;
  try {
    const file = await stat(path);
    if (!file.isFile()) return null;
    if (file.size > WECHAT_IMAGE_MAX_BYTES) {
      onFailure?.({code: 'too_large', maxBytes: WECHAT_IMAGE_MAX_BYTES, observedBytes: file.size, source: 'local_file'});
      return null;
    }
    return inspectWechatImage(await readFile(path), onFailure);
  } catch { return null; }
}

function articleImageFailure(value) {
  if (value?.code === 'decorative') return {code: 'decorative'};
  return value?.code === 'too_large' && value.maxBytes === WECHAT_IMAGE_MAX_BYTES
    && Number.isSafeInteger(value.observedBytes) && value.observedBytes > value.maxBytes
    && ['content_length', 'stream', 'local_file'].includes(value.source)
    ? {code: 'too_large', maxBytes: value.maxBytes, observedBytes: value.observedBytes, source: value.source} : null;
}

export function articleImageStorageResult(image, localUrl = '', failure) {
  const {storageError: previousError, ...currentImage} = image;
  // A later timeout/403 does not disprove a measured size or separator. A verified save clears it.
  const storageError = !localUrl ? articleImageFailure(failure) || articleImageFailure(previousError) : null;
  return {...currentImage, stored: Boolean(localUrl), localUrl, ...(storageError ? {storageError} : {})};
}

const articleImageJobs = new Map();
export async function ensureRecordImagesLocal(recordId, imageUrls, platform) {
  if (platform !== 'wechat_articles') return localizeRecordImages(recordId, imageUrls, platform);
  // Serialize only this record's article jobs. Read the latest mappings after the previous job finishes.
  const previous = articleImageJobs.get(recordId) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(() => localizeRecordImages(recordId, imageUrls, platform));
  articleImageJobs.set(recordId, pending);
  try { return await pending; }
  finally { if (articleImageJobs.get(recordId) === pending) articleImageJobs.delete(recordId); }
}

async function localizeRecordImages(recordId, imageUrls, platform) {
  const article = platform === 'wechat_articles';
  const urls = parseImageUrls(imageUrls, article ? 100 : 20);
  if (!recordId || urls.length === 0) return;
  try {
    const row = await queryOne(article
      ? 'SELECT image_local_urls, image_urls, payload FROM records WHERE id = $1'
      : 'SELECT image_local_urls FROM records WHERE id = $1', [recordId]);
    if (!row) return;
    // A detached job must never attach images to a different revision of the body.
    if (article && JSON.stringify(parseImageUrls(row.image_urls, 100)) !== JSON.stringify(urls)) return;
    const current = new Map(), failures = new Map();
    for (const entry of parseLocalImageEntries(row.image_local_urls)) {
      const hash = String(entry?.source_hash || '');
      const sourceUrl = String(entry?.source_url || '');
      const url = String(entry?.url || '');
      if (!url || !localImageExists(url)) continue;
      if (article && !await verifiedArticleLocalImage(url, failure => {
        const original = sourceUrl || urls.find(candidate => imageSourceHash(candidate) === hash);
        if (original) failures.set(original, failure);
      })) continue;
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
          localUrl = await downloadImage(url, `${recordId}-${sourceHash}`, platform, IMAGES_DIR, 'images',
            article ? failure => failures.set(url, failure) : undefined) || '';
        }
        if (localUrl) {
          const verified = article ? await verifiedArticleLocalImage(localUrl, failure => failures.set(url, failure)) : null;
          if (article && !verified) continue;
          localized.push({ source_url: url, source_hash: sourceHash, url: localUrl,
            ...(verified ? {byte_size: verified.bytes, width: verified.width, height: verified.height} : {}) });
        }
      }
      if (article) {
        const saved = new Map(localized.map(entry => [entry.source_url, entry.url]));
        const body = row.payload?.wechatArticle ?? {};
        const images = (body.images ?? []).map(image => articleImageStorageResult(image, saved.get(image.url) || '', failures.get(image.url)));
        const decorative = new Set(images.filter(image => image.storageError?.code === 'decorative').map(image => image.url));
        const expected = urls.filter(url => !decorative.has(url)).length;
        const evidence = {originalImagesCaptured: expected > 0 && localized.length === expected,
          imageStorage: {expected, stored: localized.length, checkedAt: new Date().toISOString()}};
        await execute(`UPDATE records SET image_local_urls=$1::jsonb,
          payload=jsonb_set(jsonb_set(payload,'{wechatArticle,evidence}',
            COALESCE(payload#>'{wechatArticle,evidence}','{}'::jsonb)||$3::jsonb),'{wechatArticle,images}',$4::jsonb)
          WHERE id=$2 AND platform='wechat_articles' AND image_urls=$5::jsonb
            AND payload#>>'{wechatArticle,capturedAt}' IS NOT DISTINCT FROM $6::text
            AND image_local_urls=$7::jsonb`,
        [JSON.stringify(localized), recordId, JSON.stringify(evidence), JSON.stringify(images), JSON.stringify(row.image_urls), body.capturedAt ?? null,
          JSON.stringify(row.image_local_urls)]);
      } else await execute(
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

// Default runtime calls preserve the 24h/800-row contract. Explicit Channels
// all-history mode walks every ID in bounded pages and returns actual outcomes.
export async function backfillRecentCovers(limit = 800, {platform = '', allHistory = false, tenantId = null} = {}) {
  if (allHistory && platform !== 'wechat_channels') throw new TypeError('All-history cover backfill requires wechat_channels');
  if (platform === 'wechat_channels') {
    const pageSize = Math.min(800, Math.max(1, Math.trunc(Number(limit)) || 800));
    const counts = () => ({saved: 0, expired: 0, blocked: 0, failed: 0, existing: 0, stale: 0, missing: 0, http400: 0, http403: 0});
    const result = {records: 0, cover: counts(), avatar: counts()};
    let cursor = null;
    do {
      const rows = await queryAll(`SELECT id, cover_url, author_avatar, platform FROM records
        WHERE platform='wechat_channels' AND ($1::uuid IS NULL OR tenant_id=$1)
          AND ($2::boolean OR last_seen_at > now() - interval '24 hours')
          AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4`, [tenantId, allHistory, cursor, pageSize]);
      if (!rows.length) break;
      result.records += rows.length;
      await Promise.all(rows.map(async row => {
        const outcomes = await Promise.all([ensureCoverLocal(row.id, row.cover_url, row.platform),
          ensureAvatarLocal(row.id, row.author_avatar, row.platform)]);
        for (const [index, kind] of ['cover', 'avatar'].entries()) {
          const outcome = outcomes[index];
          result[kind][outcome.status]++;
          if ([400, 403].includes(outcome.httpStatus)) result[kind][`http${outcome.httpStatus}`]++;
        }
      }));
      cursor = rows.at(-1).id;
      if (!allHistory || rows.length < pageSize) break;
    } while (true);
    return result;
  }
  try {
    const rows = await queryAll(
      `SELECT id, cover_url, author_avatar, platform FROM records
       WHERE ((cover_url <> '' AND COALESCE(cover_local, '') = '')
         OR (platform='wechat_channels' AND author_avatar<>'' AND author_avatar_local=''))
         AND last_seen_at > now() - interval '24 hours'
         AND ($2='' OR platform=$2) AND ($3::uuid IS NULL OR tenant_id=$3)
       ORDER BY last_seen_at DESC LIMIT $1`,
      [limit, platform, tenantId],
    );
    await Promise.all(rows.map((r) => Promise.all([ensureCoverLocal(r.id, r.cover_url, r.platform),
      ...(r.platform === 'wechat_channels' ? [ensureAvatarLocal(r.id, r.author_avatar, r.platform)] : [])])));
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
               - CASE WHEN platform='wechat_articles' THEN (
                 SELECT COUNT(DISTINCT image->>'url') FROM jsonb_array_elements(
                   CASE WHEN jsonb_typeof(payload#>'{wechatArticle,images}')='array'
                     THEN payload#>'{wechatArticle,images}' ELSE '[]'::jsonb END) AS image
                 WHERE image#>>'{storageError,code}'='decorative'
                   AND (image_urls @> jsonb_build_array(image->'url')
                     OR image_urls @> jsonb_build_array(jsonb_build_object('url', image->'url')))
               ) ELSE 0 END
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
