/**
 * 图片代理:小红书(xhscdn)、微博(sinaimg)、抖音 等 CDN 都有 Referer 防盗链,
 * 后台 <img> 直接引用会 403。这里服务端带对应 Referer 取图再转发,后台用
 * /api/img?url=<encoded> 引用即可。仅允许白名单图片域名,只转发 image/* 内容。
 */
import express from 'express';

const router = express.Router();

const HOST_RULES = [
  { test: (h) => h.endsWith('.sinaimg.cn') || h.endsWith('.sinaimg.com') || h.endsWith('.weiboimg.cn') || h.endsWith('.weiboimg.com'), referer: 'https://weibo.com/' },
  { test: (h) => h.endsWith('.xhscdn.com') || h.endsWith('.xiaohongshu.com'), referer: 'https://www.xiaohongshu.com/' },
  { test: (h) => h.endsWith('.douyinpic.com') || h.endsWith('.douyinstatic.com') || h.endsWith('.pstatp.com') || h.endsWith('.bytecdn.cn') || h.endsWith('.byteimg.com') || h.endsWith('.bdxiguaimg.com'), referer: 'https://www.douyin.com/' },
];

const MAX_BYTES = 15 * 1024 * 1024; // 15MB 上限,防滥用

router.get('/', async (req, res) => {
  const raw = String(req.query.url || '').trim();
  if (!raw) return res.status(400).send('missing url');

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return res.status(400).send('bad url');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return res.status(400).send('bad protocol');
  }

  const host = parsed.hostname.toLowerCase();
  const rule = HOST_RULES.find((r) => r.test(host));
  if (!rule) return res.status(403).send('host not allowed');

  // 统一升级到 https,降低被拦概率
  if (parsed.protocol === 'http:') parsed.protocol = 'https:';

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const upstream = await fetch(parsed.toString(), {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        Referer: rule.referer,
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
    }).finally(() => clearTimeout(timer));

    if (!upstream.ok) return res.status(upstream.status).send('upstream ' + upstream.status);

    const ct = upstream.headers.get('content-type') || 'image/jpeg';
    if (!/^image\//i.test(ct)) return res.status(415).send('not an image');

    const len = Number(upstream.headers.get('content-length') || 0);
    if (len && len > MAX_BYTES) return res.status(413).send('too large');

    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > MAX_BYTES) return res.status(413).send('too large');

    res.set('Content-Type', ct);
    res.set('Cache-Control', 'public, max-age=86400, immutable');
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    return res.send(buf);
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || /abort/i.test(String(err.message || '')));
    return res.status(aborted ? 504 : 502).send('proxy error');
  }
});

export default router;
