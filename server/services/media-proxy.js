/**
 * 媒体透明代理 — server 仅做「带 Referer 的流式中转」，不落盘、不归档。
 *
 * 用途：web/admin 后台无法直接下载抖音/小红书/微博的媒体直链
 *  （跨域 CORS + 防盗链 Referer + 后台浏览器无登录态），
 *  由 server 带上正确 Referer/UA 去抓，再把字节流原样转发给浏览器，
 *  浏览器保存到操作员本地磁盘。服务器磁盘占用≈0。
 *
 * 注意：只对「未过期的签名直链」有效（视频带 sign+t、封面带时间令牌）。
 *  历史记录直链失效后上游会 403，本模块会原样把失败透传给前端提示。
 */

import { Readable } from 'node:stream';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// 允许代理的媒体 CDN 域名后缀（防止把本接口当成任意 URL 的开放代理 / SSRF）
const ALLOWED_HOST_SUFFIXES = [
  // 小红书
  'xhscdn.com',
  'xiaohongshu.com',
  // 抖音 / 字节
  'douyinvod.com',
  'douyinpic.com',
  'bytevod.com',
  'byteimg.com',
  'bytecdn.cn',
  'pstatp.com',
  'zjcdn.com',
  'ixigua.com',
  'amemv.com',
  'douyin.com',
  'douyinstatic.com',
  // 微博 / 新浪
  'sinaimg.cn',
  'sinaimg.com',
  'weibocdn.com',
  'weiboimg.cn',
  'weiboimg.com',
  'miaopai.com',
  'weibo.com',
];

// 按域名解析合适的 Referer，绕过防盗链
const REFERER_RULES = [
  { test: /xhscdn\.com|xiaohongshu\.com/i, referer: 'https://www.xiaohongshu.com/' },
  { test: /douyinvod\.com|douyinpic\.com|bytevod\.com|byteimg\.com|bytecdn\.cn|pstatp\.com|zjcdn\.com|amemv\.com|douyin/i, referer: 'https://www.douyin.com/' },
  { test: /sinaimg|weibocdn|weiboimg|miaopai|weibo\.com/i, referer: 'https://weibo.com/' },
];

const PLATFORM_REFERER = {
  xiaohongshu: 'https://www.xiaohongshu.com/',
  douyin: 'https://www.douyin.com/',
  weibo: 'https://weibo.com/',
};

function safeParse(value) {
  if (value == null) return value;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return value;
}

function asArray(value) {
  const parsed = safeParse(value);
  if (Array.isArray(parsed)) return parsed;
  if (parsed == null || parsed === '') return [];
  return [parsed];
}

function urlFromItem(item) {
  if (!item) return '';
  if (typeof item === 'string') return item.trim();
  if (typeof item === 'object') {
    return String(
      item.url || item.src || item.href || item.originUrl || item.originalUrl || item.downloadUrl || ''
    ).trim();
  }
  return '';
}

function pick(obj, ...keys) {
  for (const key of keys) {
    const v = obj?.[key];
    if (v != null && v !== '') return v;
  }
  return '';
}

/**
 * 从一条记录里提取「这条记录允许下载」的全部媒体直链。
 * 与 web/admin DataPage 的 primaryImage/imageUrls/videoUrl/audioUrl 取值口径保持一致。
 * 返回一个 Set<string>，用于代理时校验 url 确实属于该记录（防止 SSRF / 越权）。
 */
export function collectRecordMediaUrls(record) {
  const urls = new Set();
  if (!record) return urls;
  const payload = safeParse(record.payload) || {};
  const add = (u) => {
    const s = String(u || '').trim();
    if (s && /^https?:\/\//i.test(s)) urls.add(s);
  };

  // 封面
  add(record.cover_url);
  add(pick(payload, 'coverImageUrl', 'coverUrl', 'cover'));

  // 图片
  [
    ...asArray(record.image_urls),
    ...asArray(payload.imageUrls),
    ...asArray(payload.images),
    ...asArray(payload.imageLinks),
    ...asArray(payload.attachments),
  ].map(urlFromItem).forEach(add);

  // 视频
  add(record.video_url);
  add(pick(payload, 'videoUrl', 'videoLink', 'video_url', 'awemeVideoUrl'));
  add(urlFromItem(asArray(payload.videoUrls)[0]));

  // 音频
  add(record.audio_url);
  add(pick(payload, 'audioUrl', 'audio_url', 'musicUrl'));
  add(urlFromItem(asArray(payload.audioUrls)[0]));
  add(urlFromItem(asArray(payload.musicUrls)[0]));

  return urls;
}

export function isAllowedMediaHost(urlStr) {
  let host = '';
  try {
    host = new URL(urlStr).hostname.toLowerCase();
  } catch {
    return false;
  }
  return ALLOWED_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`)
  );
}

export function resolveReferer(urlStr, platform = '') {
  for (const rule of REFERER_RULES) {
    if (rule.test.test(urlStr)) return rule.referer;
  }
  return PLATFORM_REFERER[String(platform || '').toLowerCase()] || '';
}

function encodeContentDisposition(filename) {
  const fallback = String(filename || 'download')
    .replace(/[\r\n"]/g, '')
    .replace(/[^\x20-\x7e]/g, '_') || 'download';
  const encoded = encodeURIComponent(String(filename || 'download'));
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * 带 Referer 抓取上游媒体并流式转发到 res（不落盘）。
 * 调用方需已校验 url 属于某条租户记录且 host 在白名单内。
 */
export async function streamMediaToResponse({ url, filename, platform, res, timeoutMs = 60000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const referer = resolveReferer(url, platform);
    const upstream = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: '*/*',
        ...(referer ? { Referer: referer } : {}),
      },
    });

    if (!upstream.ok || !upstream.body) {
      clearTimeout(timer);
      return res.status(502).json({
        ok: false,
        error: 'upstream_failed',
        status: upstream.status,
        message:
          upstream.status === 403
            ? '上游拒绝访问，直链可能已过期或被防盗链拦截'
            : `上游返回 ${upstream.status}`,
      });
    }

    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    const len = upstream.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);
    res.setHeader('Content-Disposition', encodeContentDisposition(filename));
    res.setHeader('Cache-Control', 'no-store');

    const nodeStream = Readable.fromWeb(upstream.body);
    nodeStream.on('error', () => {
      if (!res.headersSent) res.status(502).end();
      else res.end();
    });
    res.on('close', () => {
      controller.abort();
      nodeStream.destroy();
    });
    nodeStream.pipe(res);
    nodeStream.on('end', () => clearTimeout(timer));
  } catch (err) {
    clearTimeout(timer);
    if (res.headersSent) return res.end();
    const aborted = err?.name === 'AbortError';
    return res.status(aborted ? 504 : 502).json({
      ok: false,
      error: aborted ? 'upstream_timeout' : 'proxy_error',
      message: aborted ? '下载超时' : err.message,
    });
  }
}
