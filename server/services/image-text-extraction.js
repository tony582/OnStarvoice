/**
 * 内容图片（封面与正文图）按需文字提取。
 *
 * - 客户端只提交服务端生成的稳定图片标识，图片归属和真实地址全部由服务端按 tenant + record 解析。
 * - 优先读取采集时落地的 /media 本地副本；平台原图只做受限兜底。
 * - 使用独立的 Qwen OCR 模型，不改变舆情标注所用的文字模型。
 * - 按图片字节哈希缓存，同一条内容里的重复图片不会重复调用模型。
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execute, getSetting, queryOne } from '../db/init.js';
import { isAllowedMediaHost, resolveReferer } from './media-proxy.js';
import { MEDIA_DIR } from './media-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEGACY_IMAGES_DIR = resolve(__dirname, '..', '..', 'images');
const MAX_IMAGE_BYTES = 7 * 1024 * 1024;
const MAX_TEXT_CHARS = 50_000;
const IMAGE_FETCH_TIMEOUT_MS = 20_000;
const OCR_TIMEOUT_MS = 45_000;
const PROMPT_VERSION = 'visible-text-v2';
const DEFAULT_MODEL = 'qwen3.5-ocr';
const DEFAULT_ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const OCR_MIN_PIXELS = 3_072;
const OCR_MAX_PIXELS = 8_388_608;
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const OCR_PROMPT =
  'Please output only the text content from the image without any additional descriptions or formatting.';

const MIME_BY_EXTENSION = {
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.webp': 'image/webp',
};
const ALLOWED_IMAGE_MIMES = new Set(Object.values(MIME_BY_EXTENSION));
const QWEN_PROVIDER_ALIASES = new Set(['qianwen', 'qwen', 'dashscope']);
const INFLIGHT = new Map();
const ACTIVE_BY_TENANT = new Map();

export class ImageTextExtractionError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ImageTextExtractionError';
    this.code = code;
    this.status = status;
  }
}

function safeParse(value) {
  if (value == null) return value;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function asArray(value) {
  const parsed = safeParse(value);
  return Array.isArray(parsed) ? parsed : [];
}

function itemUrl(item) {
  if (typeof item === 'string') return item.trim();
  if (!item || typeof item !== 'object') return '';
  return String(item.url || '').trim();
}

function displayableUrl(url) {
  return /^https?:\/\//i.test(url) || url.startsWith('/');
}

/**
 * 必须与前端 recordDisplayImageEntries 保持相同顺序：本地图优先，
 * 未落地图回退原图，封面使用独立且稳定的身份补入。
 */
export function recordImageCandidates(record) {
  if (!record) return [];

  const remoteUrls = asArray(record.image_urls)
    .map(itemUrl)
    .filter(displayableUrl);
  const localEntries = asArray(record.image_local_urls);
  const localizedSources = new Set(
    localEntries
      .map(entry => String(entry?.source_url || '').trim())
      .filter(Boolean),
  );
  const localCandidates = localEntries
    .map(entry => {
      const url = itemUrl(entry);
      const sourceUrl = String(entry?.source_url || '').trim();
      return { url, sourceUrl, ref: sourceUrl || url };
    })
    .filter(item => displayableUrl(item.url));

  const candidates = [...localCandidates];
  for (const url of remoteUrls) {
    if (!localizedSources.has(url)) candidates.push({ url, sourceUrl: url, ref: url });
  }

  const cover = String(record.cover_local || record.cover_url || '').trim();
  const sourceUrl = String(record.cover_url || '').trim();
  const coverRef = sourceUrl || cover;
  if (displayableUrl(cover) && !candidates.some(item => item.ref === coverRef)) {
    candidates.unshift({ url: cover, sourceUrl, ref: coverRef });
  }

  const seenUrls = new Set();
  const seenRefs = new Set();
  return candidates.filter(item => {
    if (seenUrls.has(item.url) || seenRefs.has(item.ref)) return false;
    seenUrls.add(item.url);
    seenRefs.add(item.ref);
    return true;
  });
}

export function validateImageTextRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'invalid_request', message: '请求内容无效' };
  }
  const supported = new Set(['imageRef', 'refresh']);
  const unknown = Object.keys(body).filter(key => !supported.has(key));
  if (unknown.length) {
    return { ok: false, error: 'unsupported_fields', message: '请求包含不支持的字段' };
  }
  const imageRef = typeof body.imageRef === 'string' ? body.imageRef.trim() : '';
  if (!imageRef || imageRef.length > 8192) {
    return { ok: false, error: 'invalid_image_ref', message: '请选择有效的图片' };
  }
  if (body.refresh != null && typeof body.refresh !== 'boolean') {
    return { ok: false, error: 'invalid_refresh', message: '重新识别参数无效' };
  }
  return { ok: true, imageRef, refresh: body.refresh === true };
}

function looksLikeVisionModel(model) {
  return /(?:^|[-_.])(vl|ocr)(?:[-_.]|$)/i.test(String(model || ''));
}

async function resolveQwenOcrConfig(tenantId) {
  const [
    providerSetting,
    llmKeySetting,
    llmModelSetting,
    llmEndpointSetting,
    dashscopeKeySetting,
    ocrKeySetting,
    ocrModelSetting,
    ocrEndpointSetting,
  ] = await Promise.all([
    getSetting('llm_provider', tenantId),
    getSetting('llm_api_key', tenantId),
    getSetting('llm_model', tenantId),
    getSetting('llm_api_endpoint', tenantId),
    getSetting('dashscope_api_key', tenantId),
    getSetting('qwen_ocr_api_key', tenantId),
    getSetting('qwen_ocr_model', tenantId),
    getSetting('qwen_ocr_api_endpoint', tenantId),
  ]);

  const provider = String(providerSetting || process.env.LLM_PROVIDER || '').trim().toLowerCase();
  const qwenProvider = QWEN_PROVIDER_ALIASES.has(provider);
  const llmKey = String(llmKeySetting || process.env.LLM_API_KEY || '').trim();
  const apiKey = String(
    ocrKeySetting ||
    process.env.QWEN_OCR_API_KEY ||
    dashscopeKeySetting ||
    process.env.DASHSCOPE_API_KEY ||
    (qwenProvider ? llmKey : ''),
  ).trim();
  if (!apiKey) {
    throw new ImageTextExtractionError(
      'ocr_not_configured',
      '图片文字识别服务尚未配置，请联系管理员',
      503,
    );
  }

  const llmModel = String(llmModelSetting || process.env.LLM_MODEL || '').trim();
  const model = String(
    ocrModelSetting ||
    process.env.QWEN_OCR_MODEL ||
    (qwenProvider && looksLikeVisionModel(llmModel) ? llmModel : DEFAULT_MODEL),
  ).trim();
  const rawEndpoint = String(
    ocrEndpointSetting ||
    process.env.QWEN_OCR_API_ENDPOINT ||
    (qwenProvider ? (llmEndpointSetting || process.env.LLM_API_ENDPOINT) : '') ||
    DEFAULT_ENDPOINT,
  ).replace(/\/+$/, '');

  let parsedEndpoint;
  try {
    parsedEndpoint = new URL(rawEndpoint);
  } catch {
    throw new ImageTextExtractionError('invalid_ocr_endpoint', '图片文字识别服务配置无效，请联系管理员', 503);
  }
  const localHttp = parsedEndpoint.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(parsedEndpoint.hostname);
  if (parsedEndpoint.protocol !== 'https:' && !localHttp) {
    throw new ImageTextExtractionError('invalid_ocr_endpoint', '图片文字识别服务配置无效，请联系管理员', 503);
  }
  parsedEndpoint.search = '';
  parsedEndpoint.hash = '';
  parsedEndpoint.pathname = parsedEndpoint.pathname.replace(/\/chat\/completions\/?$/, '');
  const endpoint = parsedEndpoint.toString().replace(/\/+$/, '');
  return { apiKey, model, endpoint };
}

function publicLocalPath(url) {
  let root = '';
  let relative = '';
  if (url.startsWith('/media/')) {
    root = resolve(MEDIA_DIR);
    relative = url.slice('/media/'.length);
  } else if (url.startsWith('/images/')) {
    root = LEGACY_IMAGES_DIR;
    relative = url.slice('/images/'.length);
  } else {
    return null;
  }
  try {
    relative = decodeURIComponent(relative);
  } catch {
    return null;
  }
  const target = resolve(root, relative);
  if (target === root || !target.startsWith(`${root}${sep}`)) return null;
  return target;
}

function mimeFromPath(pathOrUrl) {
  let pathname = String(pathOrUrl || '');
  try {
    pathname = new URL(pathOrUrl).pathname;
  } catch {
    // Local public path.
  }
  return MIME_BY_EXTENSION[extname(pathname).toLowerCase()] || '';
}

function normalizeImageMime(value, source) {
  const fromHeader = String(value || '').split(';')[0].trim().toLowerCase();
  if (ALLOWED_IMAGE_MIMES.has(fromHeader)) return fromHeader;
  if (fromHeader && !['application/octet-stream', 'binary/octet-stream'].includes(fromHeader)) {
    throw new ImageTextExtractionError(
      'unsupported_image',
      '读取到的内容不是受支持的图片',
      415,
    );
  }
  const mime = mimeFromPath(source);
  if (!ALLOWED_IMAGE_MIMES.has(mime)) {
    throw new ImageTextExtractionError(
      'unsupported_image',
      '暂不支持这张图片的格式，请使用 JPG、PNG、WEBP、BMP、TIFF 或 HEIC 图片',
      415,
    );
  }
  return mime;
}

function detectedImageMime(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return '';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.subarray(0, 2).toString('ascii') === 'BM') return 'image/bmp';
  if (
    bytes.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) ||
    bytes.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))
  ) {
    return 'image/tiff';
  }
  if (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (bytes.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = bytes.subarray(8, 12).toString('ascii').toLowerCase();
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
  }
  return '';
}

function verifiedImageMime(bytes, declaredMime) {
  const detected = detectedImageMime(bytes);
  if (!detected) {
    throw new ImageTextExtractionError('invalid_image_bytes', '读取到的内容不是有效图片', 415);
  }
  return detected || declaredMime;
}

function assertImageSize(size) {
  if (size > MAX_IMAGE_BYTES) {
    throw new ImageTextExtractionError(
      'image_too_large',
      '图片超过 7 MB，暂时无法识别',
      413,
    );
  }
}

async function responseBytes(response) {
  const declared = Number(response.headers?.get?.('content-length') || 0);
  if (declared) assertImageSize(declared);

  if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      total += buffer.length;
      assertImageSize(total);
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, total);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  assertImageSize(buffer.length);
  return buffer;
}

async function fetchRemoteImage(url, platform, fetchImpl) {
  let current = url;
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    if (!isAllowedMediaHost(current)) {
      throw new ImageTextExtractionError('image_host_not_allowed', '这张图片无法安全读取', 403);
    }
    let response;
    try {
      response = await fetchImpl(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'image/*',
          ...(resolveReferer(current, platform) ? { Referer: resolveReferer(current, platform) } : {}),
        },
      });
    } catch (error) {
      const timeout = error?.name === 'AbortError' || error?.name === 'TimeoutError';
      throw new ImageTextExtractionError(
        timeout ? 'image_fetch_timeout' : 'image_fetch_failed',
        timeout ? '图片读取超时，请稍后重试' : '图片读取失败，可能已失效，请重新采集后再试',
        timeout ? 504 : 502,
      );
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location || redirect === 3) {
        throw new ImageTextExtractionError('image_redirect_failed', '图片读取失败，请重新采集后再试', 502);
      }
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) {
      throw new ImageTextExtractionError(
        'image_fetch_failed',
        response.status === 403
          ? '图片链接已失效，请重新采集后再试'
          : '图片读取失败，请稍后重试',
        502,
      );
    }
    const declaredMime = normalizeImageMime(response.headers.get('content-type'), current);
    const bytes = await responseBytes(response);
    return { bytes, mime: verifiedImageMime(bytes, declaredMime) };
  }
  throw new ImageTextExtractionError('image_redirect_failed', '图片读取失败，请重新采集后再试', 502);
}

async function loadImage(candidate, platform, fetchImpl) {
  const localPath = publicLocalPath(candidate.url);
  if (localPath) {
    try {
      const file = await stat(localPath);
      assertImageSize(file.size);
      const bytes = await readFile(localPath);
      assertImageSize(bytes.length);
      const declaredMime = normalizeImageMime('', localPath);
      return { bytes, mime: verifiedImageMime(bytes, declaredMime) };
    } catch (error) {
      if (error instanceof ImageTextExtractionError) throw error;
      // 本地副本丢失时，回落到该副本对应的平台原图。
      if (candidate.sourceUrl && /^https?:\/\//i.test(candidate.sourceUrl)) {
        return fetchRemoteImage(candidate.sourceUrl, platform, fetchImpl);
      }
      throw new ImageTextExtractionError('image_unavailable', '图片已失效，请重新采集后再试', 502);
    }
  }
  if (/^https?:\/\//i.test(candidate.url)) {
    return fetchRemoteImage(candidate.url, platform, fetchImpl);
  }
  throw new ImageTextExtractionError('image_unavailable', '图片已失效，请重新采集后再试', 502);
}

export function normalizeOcrContent(content) {
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map(item => typeof item === 'string' ? item : String(item?.text || ''))
      .filter(Boolean)
      .join('\n');
  }
  text = text.trim();
  const fenced = text.match(/^```(?:text|markdown)?\s*\n?([\s\S]*?)\n?```$/i);
  if (fenced) text = fenced[1].trim();
  return text.slice(0, MAX_TEXT_CHARS);
}

function isCoordinateOnlyOcr(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  if (lines.length < 3) return false;

  const coordinateLine = /^\[?\s*-?\d+(?:\.\d+)?(?:\s*,\s*-?\d+(?:\.\d+)?){4,7}\s*\]?$/;
  const coordinateLines = lines.filter(line => coordinateLine.test(line)).length;
  return coordinateLines / lines.length >= 0.8;
}

export async function requestQwenOcr({ config, dataUrl, fetchImpl = fetch }) {
  let response;
  try {
    response = await fetchImpl(`${config.endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: OCR_PROMPT },
            {
              type: 'image_url',
              image_url: { url: dataUrl },
              min_pixels: OCR_MIN_PIXELS,
              max_pixels: OCR_MAX_PIXELS,
            },
          ],
        }],
        temperature: 0,
        max_tokens: 4096,
      }),
      signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
    });
  } catch (error) {
    const timeout = error?.name === 'AbortError' || error?.name === 'TimeoutError';
    throw new ImageTextExtractionError(
      timeout ? 'ocr_timeout' : 'ocr_unavailable',
      timeout ? '图片文字识别超时，请稍后重试' : '图片文字识别服务暂时不可用，请稍后重试',
      timeout ? 504 : 502,
    );
  }

  if (!response.ok) {
    // 消耗响应体以便连接复用，但绝不把上游正文或配置返回给客户。
    await response.text().catch(() => '');
    if (response.status === 429) {
      throw new ImageTextExtractionError('ocr_rate_limited', '识别请求较多，请稍后再试', 429);
    }
    if (response.status === 401 || response.status === 403) {
      throw new ImageTextExtractionError('ocr_auth_failed', '图片文字识别服务配置无效，请联系管理员', 503);
    }
    throw new ImageTextExtractionError('ocr_failed', '图片文字识别失败，请稍后重试', 502);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new ImageTextExtractionError('ocr_invalid_response', '图片文字识别返回异常，请稍后重试', 502);
  }
  const choice = data?.choices?.[0];
  const message = choice?.message;
  if (!message || !Object.prototype.hasOwnProperty.call(message, 'content')) {
    throw new ImageTextExtractionError('ocr_invalid_response', '图片文字识别返回异常，请稍后重试', 502);
  }
  const text = normalizeOcrContent(message.content);
  if (isCoordinateOnlyOcr(text)) {
    throw new ImageTextExtractionError('ocr_invalid_response', '图片文字识别返回异常，请稍后重试', 502);
  }
  return {
    text,
    usage: {
      promptTokens: Number(data?.usage?.prompt_tokens) || null,
      completionTokens: Number(data?.usage?.completion_tokens) || null,
    },
    truncated: choice?.finish_reason === 'length',
  };
}

function tenantConcurrencyLimit() {
  const configured = Number(process.env.IMAGE_OCR_TENANT_CONCURRENCY);
  return Number.isInteger(configured) && configured > 0 ? Math.min(configured, 5) : 2;
}

function acquireTenantSlot(tenantId) {
  const active = ACTIVE_BY_TENANT.get(tenantId) || 0;
  if (active >= tenantConcurrencyLimit()) {
    throw new ImageTextExtractionError('ocr_busy', '当前正在识别其他图片，请稍后再试', 429);
  }
  ACTIVE_BY_TENANT.set(tenantId, active + 1);
}

function releaseTenantSlot(tenantId) {
  const next = Math.max(0, (ACTIVE_BY_TENANT.get(tenantId) || 1) - 1);
  if (next === 0) ACTIVE_BY_TENANT.delete(tenantId);
  else ACTIVE_BY_TENANT.set(tenantId, next);
}

async function cachedOcr({ tenantId, recordId, imageHash, model }) {
  return queryOne(
    `SELECT text, model, is_truncated, updated_at
     FROM record_image_ocr
     WHERE tenant_id = $1 AND record_id = $2 AND image_hash = $3
       AND model = $4 AND prompt_version = $5 AND status = 'done'`,
    [tenantId, recordId, imageHash, model, PROMPT_VERSION],
  );
}

async function reserveOcr({ tenantId, recordId, imageHash, model, actorUserId, refresh }) {
  if (refresh) {
    const updated = await queryOne(
      `UPDATE record_image_ocr
       SET status = 'processing', error_code = '',
           actor_user_id = $6, updated_at = now()
       WHERE tenant_id = $1 AND record_id = $2 AND image_hash = $3
         AND model = $4 AND prompt_version = $5
         AND (
           (status <> 'processing' AND updated_at < now() - interval '10 seconds')
           OR updated_at < now() - interval '2 minutes'
         )
       RETURNING id`,
      [tenantId, recordId, imageHash, model, PROMPT_VERSION, actorUserId || null],
    );
    if (updated) return true;
  }

  const inserted = await queryOne(
    `INSERT INTO record_image_ocr
       (tenant_id, record_id, image_hash, model, prompt_version, status, actor_user_id)
     VALUES ($1, $2, $3, $4, $5, 'processing', $6)
     ON CONFLICT (tenant_id, record_id, image_hash, model, prompt_version) DO NOTHING
     RETURNING id`,
    [tenantId, recordId, imageHash, model, PROMPT_VERSION, actorUserId || null],
  );
  if (inserted) return true;

  const reclaimed = await queryOne(
    `UPDATE record_image_ocr
     SET status = 'processing', text = '', error_code = '',
         actor_user_id = $6, updated_at = now()
     WHERE tenant_id = $1 AND record_id = $2 AND image_hash = $3
       AND model = $4 AND prompt_version = $5
       AND (status = 'failed' OR updated_at < now() - interval '2 minutes')
     RETURNING id`,
    [tenantId, recordId, imageHash, model, PROMPT_VERSION, actorUserId || null],
  );
  return Boolean(reclaimed);
}

async function saveOcrSuccess({
  tenantId,
  recordId,
  imageHash,
  model,
  text,
  usage,
  truncated,
}) {
  await execute(
    `UPDATE record_image_ocr
     SET status = 'done', text = $6, prompt_tokens = $7,
         completion_tokens = $8, is_truncated = $9,
         error_code = '', updated_at = now()
     WHERE tenant_id = $1 AND record_id = $2 AND image_hash = $3
       AND model = $4 AND prompt_version = $5`,
    [
      tenantId,
      recordId,
      imageHash,
      model,
      PROMPT_VERSION,
      text,
      usage.promptTokens,
      usage.completionTokens,
      truncated === true,
    ],
  );
}

async function saveOcrFailure({
  tenantId,
  recordId,
  imageHash,
  model,
  code,
  preserveSuccess = false,
}) {
  await execute(
    `UPDATE record_image_ocr
     SET status = CASE WHEN $7 THEN 'done' ELSE 'failed' END,
         text = CASE WHEN $7 THEN text ELSE '' END,
         error_code = $6, updated_at = now()
     WHERE tenant_id = $1 AND record_id = $2 AND image_hash = $3
       AND model = $4 AND prompt_version = $5`,
    [
      tenantId,
      recordId,
      imageHash,
      model,
      PROMPT_VERSION,
      String(code || 'ocr_failed').slice(0, 80),
      preserveSuccess,
    ],
  );
}

async function extractRecordImageTextWithinSlot({
  tenantId,
  recordId,
  imageRef,
  actorUserId = null,
  refresh = false,
  fetchImpl = fetch,
}) {
  const record = await queryOne(
    `SELECT id, platform, cover_url, cover_local, image_urls, image_local_urls
     FROM records
     WHERE id = $1 AND tenant_id = $2`,
    [recordId, tenantId],
  );
  if (!record) {
    throw new ImageTextExtractionError('not_found', '内容不存在', 404);
  }

  const images = recordImageCandidates(record);
  const candidate = images.find(item => item.ref === imageRef);
  if (!candidate) {
    throw new ImageTextExtractionError('image_not_found', '这张图片不存在或已被更新', 404);
  }

  const config = await resolveQwenOcrConfig(tenantId);
  const { bytes, mime } = await loadImage(candidate, record.platform, fetchImpl);
  const imageHash = createHash('sha256').update(bytes).digest('hex');
  const inflightKey = `${tenantId}:${recordId}:${imageHash}:${config.model}:${PROMPT_VERSION}`;
  const previousCached = await cachedOcr({
    tenantId,
    recordId,
    imageHash,
    model: config.model,
  });

  if (!refresh && previousCached) {
    return {
      ok: true,
      text: String(previousCached.text || ''),
      cached: true,
      model: previousCached.model,
      truncated: previousCached.is_truncated === true,
      recognizedAt: previousCached.updated_at,
    };
  }

  if (INFLIGHT.has(inflightKey)) return INFLIGHT.get(inflightKey);

  const pending = (async () => {
    let reserved = false;
    try {
      reserved = await reserveOcr({
        tenantId,
        recordId,
        imageHash,
        model: config.model,
        actorUserId,
        refresh,
      });
      if (!reserved) {
        const cached = await cachedOcr({ tenantId, recordId, imageHash, model: config.model });
        if (cached && !refresh) {
          return {
            ok: true,
            text: String(cached.text || ''),
            cached: true,
            model: cached.model,
            truncated: cached.is_truncated === true,
            recognizedAt: cached.updated_at,
          };
        }
        if (cached && refresh) {
          throw new ImageTextExtractionError(
            'ocr_refresh_too_soon',
            '刚刚完成识别，请稍后再重新识别',
            429,
          );
        }
        throw new ImageTextExtractionError('ocr_in_progress', '这张图片正在识别，请稍后再试', 409);
      }

      const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
      const result = await requestQwenOcr({ config, dataUrl, fetchImpl });
      await saveOcrSuccess({
        tenantId,
        recordId,
        imageHash,
        model: config.model,
        text: result.text,
        usage: result.usage,
        truncated: result.truncated,
      });
      return {
        ok: true,
        text: result.text,
        cached: false,
        model: config.model,
        truncated: result.truncated,
        recognizedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (reserved) {
        await saveOcrFailure({
          tenantId,
          recordId,
          imageHash,
          model: config.model,
          code: error?.code,
          preserveSuccess: Boolean(previousCached),
        }).catch(() => {});
      }
      throw error;
    }
  })();

  INFLIGHT.set(inflightKey, pending);
  try {
    return await pending;
  } finally {
    INFLIGHT.delete(inflightKey);
  }
}

/**
 * 租户并发槽覆盖数据库查询、图片读取、Base64 编码和模型调用。
 * 超出上限的请求在读取大图之前即被拒绝，避免并发图片占满进程内存。
 */
export async function extractRecordImageText(options) {
  acquireTenantSlot(options.tenantId);
  try {
    return await extractRecordImageTextWithinSlot(options);
  } finally {
    releaseTenantSlot(options.tenantId);
  }
}
