/**
 * 阿里云百炼(DashScope)Paraformer 录音文件识别客户端。
 *
 * 流程:提交异步任务(X-DashScope-Async: enable)→ 轮询任务 → 取结果 JSON → 拼成纯文本。
 * 约束:百炼只识别「公网可访问的 URL」,不收二进制流/本地文件。所以调用方需先把媒体
 *  托管到公网临时 URL(见 asr-media-host.js),再把该 URL 传进来。
 *
 * key 与 qwen LLM 同一个 DashScope 账号 key 通用。
 */

const SUBMIT_ENDPOINT =
  process.env.DASHSCOPE_ASR_ENDPOINT ||
  'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription';
const TASK_ENDPOINT =
  process.env.DASHSCOPE_TASK_ENDPOINT ||
  'https://dashscope.aliyuncs.com/api/v1/tasks';
const ASR_MODEL = process.env.DASHSCOPE_ASR_MODEL || 'paraformer-v2';

function authHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

async function readJson(resp) {
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

/** 提交异步转写任务,返回 task_id。 */
export async function submitTranscriptionTask({ apiKey, fileUrl, languageHints = ['zh', 'en'] }) {
  const resp = await fetch(SUBMIT_ENDPOINT, {
    method: 'POST',
    headers: { ...authHeaders(apiKey), 'X-DashScope-Async': 'enable' },
    body: JSON.stringify({
      model: ASR_MODEL,
      input: { file_urls: [fileUrl] },
      parameters: { language_hints: languageHints },
    }),
  });
  const data = await readJson(resp);
  if (!resp.ok) {
    throw new Error(
      `提交转写任务失败 ${resp.status}: ${data?.message || data?.code || data?._raw || ''}`.trim(),
    );
  }
  const taskId = data?.output?.task_id;
  if (!taskId) {
    throw new Error(`提交转写任务未返回 task_id: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return taskId;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询任务直到 SUCCEEDED / FAILED。返回 output.results 数组。 */
export async function waitForTranscription({ apiKey, taskId, timeoutMs = 180000, intervalMs = 3000 }) {
  const deadline = Date.now() + timeoutMs;
  // 注:此处用 Date.now() 仅做超时判断,非业务持久化,可接受。
  while (Date.now() < deadline) {
    const resp = await fetch(`${TASK_ENDPOINT}/${encodeURIComponent(taskId)}`, {
      headers: authHeaders(apiKey),
    });
    const data = await readJson(resp);
    const status = String(data?.output?.task_status || '').toUpperCase();
    if (status === 'SUCCEEDED') return data?.output?.results || [];
    if (status === 'FAILED') {
      throw new Error(
        `转写任务失败: ${data?.output?.message || data?.message || JSON.stringify(data?.output || data).slice(0, 300)}`,
      );
    }
    await sleep(intervalMs);
  }
  throw new Error('转写任务超时');
}

/** 取单个结果文件(transcription_url 指向的 JSON)并拼成纯文本 + 语言。 */
export async function fetchTranscriptText(transcriptionUrl) {
  const resp = await fetch(transcriptionUrl);
  if (!resp.ok) throw new Error(`拉取转写结果失败 ${resp.status}`);
  const data = await readJson(resp);
  // paraformer 结果结构:{ transcripts: [ { text, sentences: [...] , channel_id } ] }
  const transcripts = Array.isArray(data?.transcripts) ? data.transcripts : [];
  let text = transcripts
    .map((t) => String(t?.text || '').trim())
    .filter(Boolean)
    .join('\n');
  if (!text) {
    // 兜底:从 sentences 拼
    text = transcripts
      .flatMap((t) => (Array.isArray(t?.sentences) ? t.sentences : []))
      .map((s) => String(s?.text || '').trim())
      .filter(Boolean)
      .join('');
  }
  const lang =
    transcripts[0]?.language ||
    data?.properties?.language ||
    (Array.isArray(data?.transcripts?.[0]?.sentences) ? data.transcripts[0].sentences[0]?.language : '') ||
    '';
  return { text: text.trim(), lang: String(lang || '') };
}

/** 高层:给一个公网音/视频 URL,返回 { text, lang }。 */
export async function transcribeFileUrl({ apiKey, fileUrl, languageHints, timeoutMs }) {
  const taskId = await submitTranscriptionTask({ apiKey, fileUrl, languageHints });
  const results = await waitForTranscription({ apiKey, taskId, timeoutMs });
  const ok = results.find(
    (r) => String(r?.subtask_status || '').toUpperCase() === 'SUCCEEDED' && r?.transcription_url,
  );
  if (!ok) {
    const failMsg = results.map((r) => r?.message).filter(Boolean).join('; ');
    throw new Error(`转写无成功结果: ${failMsg || JSON.stringify(results).slice(0, 200)}`);
  }
  return await fetchTranscriptText(ok.transcription_url);
}
