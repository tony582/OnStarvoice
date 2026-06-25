/**
 * 视频逐字稿编排:取记录视频直链 → 带 Referer 暂存到公网临时 URL → 交百炼转写 → 回填 transcript。
 * 转写在后台异步进行(提交+轮询可能数十秒),HTTP 请求只负责置 pending 并触发。
 */

import { queryOne, execute, getSetting } from '../db/init.js';
import { isAllowedMediaHost } from './media-proxy.js';
import { stageMediaForAsr } from './asr-media-host.js';
import { transcribeFileUrl } from './dashscope-asr.js';

const MAX_TRANSCRIPT_CHARS = 50000;
const INFLIGHT = new Set(); // recordId,防并发重复转写

function safeParse(value) {
  if (value == null) return {};
  if (typeof value === 'object') return value;
  try {
    const v = JSON.parse(String(value));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function urlOf(item) {
  if (!item) return '';
  if (typeof item === 'string') return item.trim();
  if (typeof item === 'object') return String(item.url || item.src || item.downloadUrl || '').trim();
  return '';
}

/** 选要转写的媒体直链:口播在视频里,优先视频;音频兜底(可能是 BGM,效果次之)。 */
export function pickTranscribeMediaUrl(record) {
  const payload = safeParse(record.payload);
  const candidates = [
    record.video_url,
    payload.videoUrl,
    payload.video_url,
    payload.awemeVideoUrl,
    Array.isArray(payload.videoUrls) ? payload.videoUrls[0] : null,
    record.audio_url,
    payload.audioUrl,
    payload.musicUrl,
    Array.isArray(payload.audioUrls) ? payload.audioUrls[0] : null,
  ];
  for (const c of candidates) {
    const url = urlOf(c);
    if (url && /^https?:\/\//i.test(url) && isAllowedMediaHost(url)) return url;
  }
  return '';
}

/** DashScope key:租户设置优先 → env → qianwen 的 LLM key 兜底(同一 DashScope 账号 key 通用)。 */
async function resolveDashScopeKey(tenantId) {
  const direct = (await getSetting('dashscope_api_key', tenantId)) || process.env.DASHSCOPE_API_KEY || '';
  if (direct) return direct;
  const provider = ((await getSetting('llm_provider', tenantId)) || process.env.LLM_PROVIDER || '').toLowerCase();
  if (provider === 'qianwen' || provider === 'dashscope' || provider === 'qwen') {
    return (await getSetting('llm_api_key', tenantId)) || process.env.LLM_API_KEY || '';
  }
  return '';
}

async function setStatus(recordId, tenantId, fields) {
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(fields)) {
    params.push(v);
    sets.push(`${k} = $${params.length}`);
  }
  sets.push('transcript_updated_at = now()');
  params.push(recordId, tenantId);
  await execute(
    `UPDATE records SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND tenant_id = $${params.length}`,
    params,
  );
}

/** 实际转写一条记录(后台调用)。负责完整状态机。 */
export async function transcribeRecord({ tenantId, recordId }) {
  if (INFLIGHT.has(recordId)) return;
  INFLIGHT.add(recordId);
  let staged = null;
  try {
    const record = await queryOne(
      `SELECT id, platform, video_url, audio_url, payload FROM records WHERE id = $1 AND tenant_id = $2`,
      [recordId, tenantId],
    );
    if (!record) return;

    const apiKey = await resolveDashScopeKey(tenantId);
    if (!apiKey) {
      await setStatus(recordId, tenantId, {
        transcript_status: 'failed',
        transcript_error: '未配置 DashScope(百炼)API Key',
      });
      return;
    }

    const mediaUrl = pickTranscribeMediaUrl(record);
    if (!mediaUrl) {
      await setStatus(recordId, tenantId, { transcript_status: 'no_media', transcript_error: '该记录无可转写的视频/音频直链' });
      return;
    }

    await setStatus(recordId, tenantId, {
      transcript_status: 'processing',
      transcript_error: '',
      transcript_source_url: mediaUrl,
    });

    staged = await stageMediaForAsr({ url: mediaUrl, platform: record.platform });
    const { text, lang } = await transcribeFileUrl({ apiKey, fileUrl: staged.publicUrl });

    if (!text) {
      // 转写成功但无文本 = 视频无人声/纯音乐,不是失败 → 中性 no_speech 态(前端灰字提示,不红)
      await setStatus(recordId, tenantId, { transcript_status: 'no_speech', transcript_error: '' });
      return;
    }
    await setStatus(recordId, tenantId, {
      transcript: text.slice(0, MAX_TRANSCRIPT_CHARS),
      transcript_lang: String(lang || '').slice(0, 16),
      transcript_status: 'done',
      transcript_error: '',
    });
  } catch (err) {
    const expired = err?.code === 'EXPIRED';
    const noSpeech = err?.code === 'NO_SPEECH';
    await setStatus(recordId, tenantId, {
      transcript_status: noSpeech ? 'no_speech' : expired ? 'expired' : 'failed',
      // 无人声不是错误,清空 error 文案,靠 no_speech 状态在前端显示中性提示
      transcript_error: noSpeech ? '' : String(err?.message || err || '转写失败').slice(0, 500),
    }).catch(() => {});
  } finally {
    if (staged) await staged.cleanup().catch(() => {});
    INFLIGHT.delete(recordId);
  }
}

/** HTTP 入口:置 pending 并后台触发转写,立即返回。返回当前状态。 */
export async function startTranscription({ tenantId, recordId }) {
  const record = await queryOne(
    `SELECT id, transcript_status, video_url, audio_url, payload FROM records WHERE id = $1 AND tenant_id = $2`,
    [recordId, tenantId],
  );
  if (!record) return { ok: false, error: 'not_found' };
  if (record.transcript_status === 'processing' || record.transcript_status === 'pending') {
    return { ok: true, status: record.transcript_status, message: '正在转写中' };
  }
  if (!pickTranscribeMediaUrl(record)) {
    await setStatus(recordId, tenantId, { transcript_status: 'no_media', transcript_error: '该记录无可转写的视频/音频直链' });
    return { ok: true, status: 'no_media', message: '无可转写的视频' };
  }
  await setStatus(recordId, tenantId, { transcript_status: 'pending', transcript_error: '' });
  // 后台执行,不阻塞 HTTP
  setImmediate(() => {
    transcribeRecord({ tenantId, recordId }).catch(() => {});
  });
  return { ok: true, status: 'pending' };
}
