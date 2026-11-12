/**
 * 图片代理:小红书(xhscdn)、微博(sinaimg)、抖音 等 CDN 都有 Referer 防盗链,
 * 后台 <img> 直接引用会 403。这里服务端带对应 Referer 取图再转发,后台用
 * /api/img?url=<encoded> 引用即可。仅允许白名单图片域名,只转发 image/* 内容。
 */
import express from 'express';
import {withSafeMediaDownload} from '../services/safe-media-download.js';

const router = express.Router();

const HOST_RULES = [
  { test: (h) => ['finder.video.qq.com', 'findermp.video.qq.com', 'wx.qlogo.cn'].some(s => h === s || h.endsWith(`.${s}`)), referer: 'https://channels.weixin.qq.com/' },
  { test: (h) => h === 'qpic.cn' || h.endsWith('.qpic.cn'), referer: 'https://mp.weixin.qq.com/' },
  { test: (h) => h.endsWith('.sinaimg.cn') || h.endsWith('.sinaimg.com') || h.endsWith('.weiboimg.cn') || h.endsWith('.weiboimg.com'), referer: 'https://weibo.com/' },
  { test: (h) => h.endsWith('.xhscdn.com') || h.endsWith('.xiaohongshu.com'), referer: 'https://www.xiaohongshu.com/' },
  { test: (h) => h.endsWith('.douyinpic.com') || h.endsWith('.douyinstatic.com') || h.endsWith('.pstatp.com') || h.endsWith('.bytecdn.cn') || h.endsWith('.byteimg.com') || h.endsWith('.bdxiguaimg.com'), referer: 'https://www.douyin.com/' },
];

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

router.get('/', async (req, res) => {
  const raw = String(req.query.url || '').trim();
  if (!raw) return res.status(400).send('missing url');
  try { new URL(raw); } catch { return res.status(400).send('bad url'); }
  try {
    return await withSafeMediaDownload({
      url: raw,
      isAllowedUrl: url => HOST_RULES.some(rule => rule.test(new URL(url).hostname.toLowerCase())),
      headers: url => ({
        Referer: HOST_RULES.find(rule => rule.test(new URL(url).hostname.toLowerCase())).referer,
        'User-Agent': BROWSER_UA,
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      }),
    }, async ({response, stream}) => {
      if (!response.ok) return res.status(response.status).send('upstream ' + response.status);
      const type = response.headers.get('content-type') || 'image/jpeg';
      if (!/^image\//i.test(type)) return res.status(415).send('not an image');
      if (!stream) return res.status(502).send('empty upstream');
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      res.set('Content-Type', type);
      res.set('Cache-Control', 'public, max-age=86400, immutable');
      res.set('Cross-Origin-Resource-Policy', 'cross-origin');
      return res.send(Buffer.concat(chunks));
    });
  } catch (error) {
    return res.status(error.status || 502).send(error.code === 'too_large' ? 'too large' : 'proxy error');
  }
});

export default router;
