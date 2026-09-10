import { createHash, createHmac, randomUUID } from 'node:crypto';
import {renderCustomerDailySummaryPng} from './customer-daily-report-image.js';
import {buildFeishuDailyPost, FEISHU_DAILY_POST_IMAGE_PLACEHOLDER} from './feishu-daily-report-message.js';
import {CUSTOMER_DAILY_SECTIONS, customerDailySummaryRows, customerDailyPostComparison, customerDailyPostPlatform,
  customerDailyColdTitle, customerDailyColdPostLabel, customerDailyColdEmpty} from './customer-daily-report-presentation.js';

// Official contracts: /document/develop-robots/add-bot-to-external-group,
// docx-v1/document-block-descendant/create, document-block/patch,
// drive-v2/permission-public/get and drive-v1/permission-member/{create,list}.
const API_ORIGIN = 'https://open.feishu.cn';
const ID = /^[A-Za-z0-9_-]{1,200}$/;
const IMAGE_KEY = /^img_[A-Za-z0-9_-]{1,196}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EDIT = new Set(['edit', 'full_access']);
const TEXT_KEY = { 2: 'text', 3: 'heading1', 4: 'heading2' };
const MERGES = [
  ...Array.from({ length: 5 }, (_, column) => [0, 2, column, column + 1]),
  [0, 1, 5, 8],
];

export class FeishuDailyError extends Error {
  constructor(code, message, { ambiguous = false, retryable = false, needsAttention = false, status, apiCode } = {}) {
    super(message);
    this.name = 'FeishuDailyError';
    this.safeMessage = message;
    Object.assign(this, { code, ambiguous, retryable, needsAttention: ambiguous || needsAttention });
    if (status !== undefined) this.status = status;
    if (apiCode !== undefined) this.apiCode = apiCode;
  }
}

function invalid(message = '飞书日报配置不完整或格式无效') {
  return new FeishuDailyError('FEISHU_CONFIG_INVALID', message, { needsAttention: true });
}
function uncertain(message = '飞书操作结果待确认，请核对后继续') {
  return new FeishuDailyError('FEISHU_RESULT_UNKNOWN', message, { ambiguous: true });
}
function id(value) {
  if (!ID.test(String(value || ''))) throw invalid('飞书资源标识格式无效');
  return String(value);
}
function plain(value, limit = 20000) {
  const result = String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  if (result.length > limit) throw invalid('日报单项内容过长，无法完整写入飞书');
  return result;
}
function clone(value) { return structuredClone(value); }
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function validHttpUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}
function documentOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw invalid('请配置飞书文档域名'); }
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.feishu\.cn$/.test(url.hostname)
      || url.username || url.password || url.port || !['', '/'].includes(url.pathname) || url.search || url.hash) {
    throw invalid('文档域名必须是飞书组织的 HTTPS 域名');
  }
  return url.origin;
}
function webhookUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw invalid('请配置飞书群 Webhook'); }
  if (url.origin !== API_ORIGIN || url.username || url.password || url.search || url.hash
      || !/^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]{10,200}$/.test(url.pathname)) {
    throw invalid('Webhook 必须使用飞书官方群机器人地址');
  }
  return url.href;
}
function run(content, url, bold = false) {
  const style = {};
  if (bold) style.bold = true;
  if (url) style.link = { url: encodeURIComponent(url) };
  return { text_run: { content: plain(content), ...(Object.keys(style).length ? { text_element_style: style } : {}) } };
}
function textNode(content, type = 2) {
  return { block_type: type, [TEXT_KEY[type]]: { elements: Array.isArray(content) ? content : [run(content)] } };
}

/** Pure document plan. Every table cell, including unknown counts, is editable text. */
export function buildFeishuDailyDocumentPlan(snapshot) {
  if (!snapshot || !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.reportDate || '') || !snapshot.summary?.day || !snapshot.summary?.mtd) {
    throw invalid('日报快照不完整');
  }
  const rows = [
    ['日期', '监控数量', 'SDB范畴', '正向', '中性', '负面', '', ''],
    ['', '', '', '', '', '冷处理', '处理中', '已处理'],
    ...customerDailySummaryRows(snapshot).map(row => row.map(value => value === null ? '' : String(value))),
  ];
  const table = { block_type: 31, table: { property: { row_size: 4, column_size: 8,
    column_width: [120, 100, 100, 80, 80, 100, 100, 100], header_row: true } },
  nodes: rows.flatMap((row, rowIndex) => row.map(value => ({ block_type: 32, table_cell: {},
    nodes: [textNode([run(value, null, rowIndex < 2)])] }))) };
  const nodes = [
    textNode(`${snapshot.tenantName || '客户'}舆情日报｜${snapshot.reportDate}${snapshot.mode === 'realtime' ? ' · 实时版' : ''}` , 3),
    textNode(CUSTOMER_DAILY_SECTIONS.summary, 4), table,
    textNode(CUSTOMER_DAILY_SECTIONS.heat, 4),
  ];
  const high = snapshot.highHeat || [];
  if (!high.length) nodes.push(textNode('暂未检出。'));
  high.forEach((post, index) => {
    const url = validHttpUrl(post.url);
    const description = ` - ${customerDailyPostPlatform(post)} | 热度 ${post.heat ?? '—'} | ${customerDailyPostComparison(post)}`
      + (url ? '' : '｜原帖链接待补');
    nodes.push(textNode([run(`TOP${index + 1}：`), run(String(post.title || '未命名帖子').replace(/\s+/g,' ').trim(), url), run(description)]));
  });
  nodes.push(textNode(customerDailyColdTitle(snapshot), 4));
  const cold = snapshot.coldMarked || [];
  if (!cold.length) {
    nodes.push(textNode(customerDailyColdEmpty(snapshot)));
  }
  cold.forEach((post, index) => {
    const url = validHttpUrl(post.url);
    nodes.push(textNode([run(`${index + 1}、`), run(String(post.title || '未命名帖子').replace(/\s+/g,' ').trim(), url),
      run(`${customerDailyColdPostLabel(post) ? '【历史帖】' : ''} - ${customerDailyPostPlatform(post)}${url ? '' : '｜原帖链接待补'}`)]));
  });
  let sequence = 0;
  function flatten(node, descendants) {
    const block = { block_id: `daily_${sequence++}`, ...node };
    delete block.nodes;
    descendants.push(block);
    block.children = (node.nodes || []).map(child => flatten(child, descendants));
    return block.block_id;
  }
  const batches = [];
  let batch = { children_id: [], descendants: [], index: -1 };
  for (const node of nodes) {
    const descendants = [];
    const root = flatten(node, descendants);
    // Below Feishu's 1000 descendant limit; also bound payload bytes for large titles.
    if (batch.descendants.length && (batch.descendants.length + descendants.length > 180
        || Buffer.byteLength(JSON.stringify(batch)) + Buffer.byteLength(JSON.stringify(descendants)) > 160000)) {
      batches.push(batch);
      batch = { children_id: [], descendants: [], index: -1 };
    }
    batch.children_id.push(root);
    batch.descendants.push(...descendants);
  }
  if (batch.descendants.length) batches.push(batch);
  return { schemaVersion: 1, batches, merges: MERGES };
}

function normalizedText(block) {
  const elements = block[TEXT_KEY[block.block_type]]?.elements || [];
  return elements.map(element => {
    if (!element.text_run) return ['unsupported'];
    const style = element.text_run.text_element_style || {};
    let link = style.link?.url || '';
    try { link = decodeURIComponent(link); } catch { /* Compare literal malformed URL. */ }
    return [element.text_run.content || '', Boolean(style.bold), link];
  });
}
function shape(blockId, map, depth = 0) {
  const block = map.get(blockId);
  if (!block || depth > 8) throw uncertain('飞书正文结构无法核实，未继续写入');
  return [block.block_type, TEXT_KEY[block.block_type] ? normalizedText(block) : null,
    block.block_type === 31 ? [block.table?.property?.row_size, block.table?.property?.column_size] : null,
    (block.children || []).map(child => shape(child, map, depth + 1))];
}
function rootIds(blocks, documentId) {
  const root = blocks.find(block => block.block_id === documentId && block.block_type === 1);
  // Feishu omits children on a newly created document containing only its page root.
  if (root && blocks.length === 1 && !Object.hasOwn(root, 'children')) return [];
  if (!root || !Array.isArray(root.children)) throw uncertain('无法读取飞书文档根节点，未继续写入');
  return root.children;
}

export function createFeishuDailyClient(config, { fetchImpl = globalThis.fetch, timeoutMs = 15000, now = () => Date.now(), minWriteIntervalMs = 350, renderSummaryImage = renderCustomerDailySummaryPng } = {}) {
  if (typeof fetchImpl !== 'function') throw invalid();
  // Capture a private copy; never include config, endpoint, response body or cause in errors.
  const settings = { ...config };
  const origin = documentOrigin(settings.documentBaseUrl);
  const requestTimeout = Math.max(10, Math.min(Number(timeoutMs) || 15000, 30000));
  let token = '';
  let tokenUntil = 0;
  let authPending;
  let previousDocWrite = 0;

  async function request(path, { method = 'GET', body, form, auth = true, mutation = method !== 'GET', webhook = false } = {}) {
    const url = webhook ? webhookUrl(path) : `${API_ORIGIN}${path}`;
    if (!webhook && (!path.startsWith('/open-apis/') || path.includes('#') || new URL(url).origin !== API_ORIGIN)) throw invalid();
    const headers = form ? {} : { 'Content-Type': 'application/json; charset=utf-8' };
    if (auth) headers.Authorization = `Bearer ${await accessToken()}`;
    if (mutation && path.startsWith('/open-apis/docx/')) {
      const wait = Math.min(1000, Math.max(0, Number(minWriteIntervalMs) || 0)) - (Date.now() - previousDocWrite);
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      previousDocWrite = Date.now();
    }
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, requestTimeout);
    });
    try {
      const response = await Promise.race([fetchImpl(url, { method, headers, redirect: 'error', signal: controller.signal,
        ...(form ? {body:form} : body === undefined ? {} : { body: JSON.stringify(body) }) }), timeout]);
      const status = response.status;
      if (status >= 500 || status === 408 || (status >= 300 && status < 400)) {
        throw new FeishuDailyError('FEISHU_REMOTE_UNCERTAIN', '飞书暂时无法确认操作结果',
          { ambiguous: mutation, retryable: !mutation, status });
      }
      let payload;
      try { payload = await Promise.race([response.json(), timeout]); } catch {
        throw new FeishuDailyError('FEISHU_RESPONSE_INVALID', '飞书返回结果无法核实', { ambiguous: mutation, retryable: !mutation, status });
      }
      const apiCode = typeof payload?.code === 'number' ? payload.code
        : webhook && typeof payload?.StatusCode === 'number' ? payload.StatusCode : undefined;
      if (status < 200 || status >= 300 || apiCode !== 0) {
        const retryable = status === 429 || apiCode === 99991400 || apiCode === 1063006 || apiCode === 11232;
        // Missing result codes and internal-error business codes may conceal a completed write.
        const ambiguous = mutation && (apiCode === undefined || [1771001, 1771002, 1771006, 1066001, 1066002].includes(apiCode));
        throw new FeishuDailyError('FEISHU_API_REJECTED', retryable ? '飞书请求受到限流，稍后可重试' : '飞书未完成请求，请检查应用权限、资源及群配置',
          { ambiguous, retryable: retryable && !ambiguous, needsAttention: !retryable, status, apiCode });
      }
      return payload;
    } catch (error) {
      if (error instanceof FeishuDailyError) throw error;
      throw new FeishuDailyError('FEISHU_NETWORK_UNCERTAIN', '飞书连接中断或超时，操作结果待核实', { ambiguous: mutation, retryable: !mutation });
    } finally { clearTimeout(timer); }
  }

  async function accessToken() {
    if (token && now() < tokenUntil) return token;
    if (authPending) return authPending;
    if (!ID.test(settings.appId || '') || !settings.appSecret) throw invalid('请配置日报写入应用');
    authPending = (async () => {
      const response = await request('/open-apis/auth/v3/tenant_access_token/internal', { method: 'POST', auth: false, mutation: false,
        body: { app_id: settings.appId, app_secret: settings.appSecret } });
      if (typeof response.tenant_access_token !== 'string' || !response.tenant_access_token || !Number.isFinite(response.expire)) {
        throw new FeishuDailyError('FEISHU_AUTH_INVALID', '飞书应用认证结果无效', { needsAttention: true });
      }
      token = response.tenant_access_token;
      tokenUntil = now() + Math.max(0, response.expire - 60) * 1000;
      return token;
    })();
    try { return await authPending; } finally { authPending = null; }
  }

  async function createDocument({ title }) {
    // API permits tenant token creation in an application-created folder. Never silently use root.
    const folder = id(settings.folderToken);
    const response = await request('/open-apis/docx/v1/documents', { method: 'POST',
      body: { title: plain(title, 800), folder_token: folder } });
    const documentId = response.data?.document?.document_id;
    if (!ID.test(documentId || '')) throw uncertain('飞书可能已创建文档，但未返回可核实的文档标识');
    return { documentId, url: `${origin}/docx/${documentId}` };
  }

  async function allBlocks(documentId) {
    const blocks = [];
    const visited = new Set();
    let pageToken = '';
    do {
      const response = await request(`/open-apis/docx/v1/documents/${id(documentId)}/blocks?page_size=500&document_revision_id=-1${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`);
      const data = response.data;
      if (!Array.isArray(data?.items)) throw uncertain('飞书文档内容读取不完整');
      blocks.push(...data.items);
      if (!data.has_more) return blocks;
      pageToken = data.page_token;
      if (!pageToken || visited.has(pageToken) || visited.size >= 100) throw uncertain('飞书文档内容分页无法核实');
      visited.add(pageToken);
    } while (true);
  }

  async function writeDocument({ documentId, snapshot, progress, onProgress }) {
    id(documentId);
    if (typeof onProgress !== 'function') throw invalid('文档写入必须配置持久化进度回调');
    const plan = buildFeishuDailyDocumentPlan(snapshot);
    // Report identity stays bound to the checkpoint even when version labels are hidden from customers.
    const planHash = digest({plan,reportId:snapshot.id || null,tenantId:snapshot.tenantId || null,
      reportDate:snapshot.reportDate,version:snapshot.version || 1,mode:snapshot.mode});
    let state = progress && Object.keys(progress).length ? clone(progress) : { schemaVersion: 1, documentId, planHash, completed: [], pending: null, baseRootIds: null, done: false };
    if (state.schemaVersion !== 1 || state.documentId !== documentId || state.planHash !== planHash || !Array.isArray(state.completed)) throw uncertain('日报写入进度与版本不一致');
    if (state.done) return state; // Do not read or overwrite the customer's completed working document.
    async function save(next, afterMutation = false) {
      try { await onProgress(clone(next)); } catch {
        if (afterMutation) throw uncertain('飞书操作已执行，但本地进度保存失败');
        throw new FeishuDailyError('FEISHU_CHECKPOINT_FAILED', '日报写入进度未保存，未执行下一步', { ambiguous: true });
      }
      state = next;
    }
    function priorRootIds() { return [...state.baseRootIds, ...state.completed.flatMap(step => step.rootIds || [])]; }
    const complete = (key) => state.completed.some(step => step.key === key);
    async function finish(step) {
      await save({ ...state, completed: [...state.completed, step], pending: null }, true);
    }
    async function executeStep(pending, operation, knownResult) {
      await save({ ...state, pending });
      try {
        const result = await operation();
        await finish(await knownResult(result));
      } catch (error) {
        if (error instanceof FeishuDailyError && !error.ambiguous) await save({ ...state, pending: null });
        throw error;
      }
    }
    if (state.baseRootIds === null) {
      const existing = await allBlocks(documentId);
      const roots = rootIds(existing, documentId);
      const map = new Map(existing.map(block => [block.block_id, block]));
      if (roots.some(root => map.get(root)?.block_type !== 2 || normalizedText(map.get(root)).some(item => item[0] !== ''))) {
        throw uncertain('目标文档已有正文，未覆盖现有内容');
      }
      await save({ ...state, baseRootIds: roots });
    }
    for (let index = 0; index < plan.batches.length; index++) {
      const key = `body:${index}`;
      if (complete(key)) continue;
      const batch = plan.batches[index];
      const blocks = await allBlocks(documentId);
      const roots = rootIds(blocks, documentId);
      const before = priorRootIds();
      if (state.pending) {
        if (state.pending.key !== key || JSON.stringify(state.pending.beforeRootIds) !== JSON.stringify(before)
            || JSON.stringify(roots.slice(0, before.length)) !== JSON.stringify(before)
            || roots.length !== before.length + batch.children_id.length) {
          throw uncertain('上一次正文写入结果尚未确认，未重复追加');
        }
        const actualMap = new Map(blocks.map(block => [block.block_id, block]));
        const expectedMap = new Map(batch.descendants.map(block => [block.block_id, block]));
        const added = roots.slice(before.length);
        if (JSON.stringify(added.map(root => shape(root, actualMap))) !== JSON.stringify(batch.children_id.map(root => shape(root, expectedMap)))) {
          throw uncertain('飞书正文与待确认内容不一致，未继续写入');
        }
        await finish({ key, rootIds: added,
          ...(added.find(root => actualMap.get(root)?.block_type === 31) ? { tableId: added.find(root => actualMap.get(root)?.block_type === 31) } : {}) });
        continue;
      }
      if (JSON.stringify(roots) !== JSON.stringify(before)) throw uncertain('飞书文档结构已变化，未继续追加');
      const pending = { key, clientToken: randomUUID(), beforeRootIds: before };
      await executeStep(pending, () => request(`/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/descendant?document_revision_id=-1&client_token=${pending.clientToken}`,
        { method: 'POST', body: batch }), response => {
        const relations = response.data?.block_id_relations;
        if (!Array.isArray(relations)) throw uncertain('飞书可能已写入正文，但未返回块标识');
        const ids = new Map(relations.map(row => [row.temporary_block_id, row.block_id]));
        const added = batch.children_id.map(root => ids.get(root));
        if (added.some(value => !ID.test(value || '')) || new Set(added).size !== added.length) throw uncertain('飞书正文标识无法核实');
        const table = batch.descendants.find(block => block.block_type === 31);
        return { key, rootIds: added, ...(table ? { tableId: ids.get(table.block_id) } : {}) };
      });
    }
    const tableId = state.completed.find(step => step.tableId)?.tableId;
    if (!tableId) throw uncertain('未找到日报原生表格');
    for (let index = 0; index < plan.merges.length; index++) {
      const key = `merge:${index}`;
      if (complete(key)) continue;
      const [rowStart, rowEnd, colStart, colEnd] = plan.merges[index];
      if (state.pending) {
        if (state.pending.key !== key) throw uncertain('表格写入进度不一致');
        const blocks = await allBlocks(documentId);
        const table = blocks.find(block => block.block_id === tableId);
        const cell = table?.table?.property?.merge_info?.[rowStart * 8 + colStart];
        if (cell?.row_span !== rowEnd - rowStart || cell?.col_span !== colEnd - colStart) throw uncertain('表头合并结果待确认，未重复修改');
        await finish({ key });
        continue;
      }
      const pending = { key, clientToken: randomUUID() };
      await executeStep(pending, () => request(`/open-apis/docx/v1/documents/${documentId}/blocks/${id(tableId)}?document_revision_id=-1&client_token=${pending.clientToken}`,
        { method: 'PATCH', body: { merge_table_cells: { row_start_index: rowStart, row_end_index: rowEnd,
          column_start_index: colStart, column_end_index: colEnd } } }), () => ({ key }));
    }
    await save({ ...state, done: true });
    return state;
  }

  async function ensureEditable({ documentId, progress, onProgress, verifyOnly = false }) {
    id(documentId);
    const editorType = settings.editorType;
    const editorId = String(settings.editorId || '').trim();
    if (!['email', 'openid', 'openchat'].includes(editorType) || !editorId
        || (editorType === 'email' ? !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(editorId) : !ID.test(editorId))) {
      throw invalid('请指定客户可编辑协作者或客户群');
    }
    let state = progress && Object.keys(progress).length ? clone(progress) : { schemaVersion: 1, documentId, targetHash: digest([editorType, editorId]), pending: false };
    if (state.schemaVersion !== 1 || state.documentId !== documentId || state.targetHash !== digest([editorType, editorId])) throw uncertain('客户授权目标与保存进度不一致');
    async function save(next, after = false) {
      if (onProgress) {
        try { await onProgress(clone(next)); } catch {
          throw after ? uncertain('客户授权已执行，但本地进度未保存')
            : new FeishuDailyError('FEISHU_CHECKPOINT_FAILED', '客户授权进度未保存，未发起授权', { ambiguous: true });
        }
      }
      state = next;
    }
    async function listMembers() {
      const response = await request(`/open-apis/drive/v1/permissions/${documentId}/members?type=docx&fields=external_label`);
      if (!Array.isArray(response.data?.items)) throw uncertain('无法核验客户文档权限');
      return response.data.items;
    }
    function matches(member) {
      return (member.member_type === editorType && (editorType === 'email' ? member.member_id?.toLowerCase() === editorId.toLowerCase() : member.member_id === editorId))
        || (state.member && member.member_type === state.member.member_type && member.member_id === state.member.member_id);
    }
    let members = await listMembers();
    let editor = members.find(member => matches(member) && EDIT.has(member.perm));
    if (!editor) {
      if (verifyOnly) throw new FeishuDailyError('FEISHU_EDITOR_NOT_VERIFIED', '客户编辑权限已变化或无法核实，未更改权限或发送消息', { needsAttention: true });
      if (state.pending) throw uncertain('上一次客户编辑授权待确认，未重复授权');
      const body = { member_type: editorType, member_id: editorId, perm: 'edit', type: editorType === 'openchat' ? 'chat' : 'user' };
      const existing = members.find(matches);
      if (existing) delete body.member_id;
      await save({ ...state, pending: true });
      try {
        const response = await request(`/open-apis/drive/v1/permissions/${documentId}/members${existing ? `/${encodeURIComponent(editorId)}` : ''}?type=docx&need_notification=false`,
          { method: existing ? 'PUT' : 'POST', body });
        const member = response.data?.member;
        if (!member?.member_id || !member.member_type || !EDIT.has(member.perm)) throw uncertain('客户授权响应无法核验');
        await save({ ...state, pending: false, member: { member_id: member.member_id, member_type: member.member_type } }, true);
      } catch (error) {
        if (error instanceof FeishuDailyError && !error.ambiguous) await save({ ...state, pending: false });
        throw error;
      }
      members = await listMembers();
      editor = members.find(member => matches(member) && EDIT.has(member.perm));
    }
    if (!editor) throw new FeishuDailyError('FEISHU_EDITOR_NOT_VERIFIED', '尚未核实指定客户拥有编辑权限', { needsAttention: true });
    if (state.pending) await save({ ...state, pending: false, member: { member_id: editor.member_id, member_type: editor.member_type } }, true);
    const response = await request(`/open-apis/drive/v2/permissions/${documentId}/public?type=docx`);
    const permissions = response.data?.permission_public;
    if (!permissions || !permissions.link_share_entity || /^anyone_/.test(permissions.link_share_entity)) {
      throw new FeishuDailyError('FEISHU_PUBLIC_SHARING_UNSAFE', '日报链接分享须限定协作者，不能全网开放', { needsAttention: true });
    }
    if (editor.external_label !== false && permissions.external_access_entity !== 'open') {
      throw new FeishuDailyError('FEISHU_EXTERNAL_EDIT_BLOCKED', '文档尚未允许客户跨组织协作，请核对目录与组织策略', { needsAttention: true });
    }
    const retain = value => ['anyone_can_view', 'anyone_can_edit'].includes(value) || (value === 'only_full_access' && editor.perm === 'full_access');
    if (!retain(permissions.security_entity) || !retain(permissions.copy_entity)) {
      throw new FeishuDailyError('FEISHU_RETENTION_BLOCKED', '客户尚不能复制、下载或保存副本，请核对文档留存权限', { needsAttention: true });
    }
    await save({ ...state, done: true });
    return { editable: true, retentionAllowed: true, external: editor.external_label !== false, progress: state };
  }

  async function prepareSummaryImage({snapshot, progress, onProgress}) {
    const png = Buffer.from(await renderSummaryImage(snapshot));
    if (png.length > 10 * 1024 * 1024 || png.length < 24 || !png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw invalid('日报表格图片生成失败');
    const imageHash = createHash('sha256').update(png).digest('hex');
    if (progress?.imageHash === imageHash && IMAGE_KEY.test(progress.imageKey || '') && progress.imageKey !== FEISHU_DAILY_POST_IMAGE_PLACEHOLDER) return progress;
    const form = new FormData();
    form.append('image_type','message');
    form.append('image',new Blob([png],{type:'image/png'}),'daily-summary.png');
    let response;
    try {
      response = await request('/open-apis/im/v1/images',{method:'POST',form});
    } catch (error) {
      if (error.apiCode === 99991672) throw new FeishuDailyError('FEISHU_IMAGE_PERMISSION_MISSING','请在飞书应用中添加「上传图片和附件」权限并发布版本。',{needsAttention:true});
      // An unconfirmed image upload can leave an unused asset, but no chat message was attempted.
      if (error.ambiguous) throw new FeishuDailyError('FEISHU_IMAGE_UPLOAD_UNCONFIRMED','表格图片上传结果未确认，可稍后重试。',{retryable:true});
      throw error;
    }
    const imageKey = response.data?.image_key;
    if (!IMAGE_KEY.test(imageKey || '') || imageKey === FEISHU_DAILY_POST_IMAGE_PLACEHOLDER) throw new FeishuDailyError('FEISHU_IMAGE_UPLOAD_UNCONFIRMED','表格图片上传结果未确认，可稍后重试。',{retryable:true});
    const result = {imageHash,imageKey};
    if (onProgress) {
      try {await onProgress(result);} catch {throw new FeishuDailyError('FEISHU_IMAGE_CHECKPOINT_FAILED','图片发送进度未保存，请稍后重试。',{retryable:true});}
    }
    return result;
  }

  async function sendReport({ documentUrl, snapshot, uuid, summaryImageProgress, onSummaryImageProgress }) {
    let url;
    try { url = new URL(documentUrl); } catch { throw invalid('日报文档链接无效'); }
    if (url.origin !== origin || !/^\/docx\/[A-Za-z0-9_-]+$/.test(url.pathname) || url.search || url.hash || url.username || url.password) throw invalid('日报文档链接与配置不符');
    const reportDate = plain(snapshot?.reportDate, 30);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) throw invalid('日报日期无效');
    if (settings.channel === 'app') {
      if (!UUID.test(uuid || '')) throw invalid('群消息缺少持久化发送标识或通道无效');
      id(settings.chatId);
    } else if (settings.channel === 'webhook') {
      webhookUrl(settings.webhookUrl);
      if (!settings.webhookSecret) throw invalid('请配置群机器人签名密钥');
    } else throw invalid('群发送通道无效');
    // Validate content before any upload; the image is uploaded separately from the rich-text payload.
    try {buildFeishuDailyPost({snapshot,documentUrl:url.href});}
    catch {throw invalid('日报图文内容无法生成，请检查帖子内容或使用飞书文档交付。');}
    const picture = await prepareSummaryImage({snapshot,progress:summaryImageProgress,onProgress:onSummaryImageProgress});
    const post = buildFeishuDailyPost({snapshot,imageKey:picture.imageKey,documentUrl:url.href});
    if (settings.channel === 'webhook') {
      const hook = webhookUrl(settings.webhookUrl);
      if (!settings.webhookSecret) throw invalid('请配置群机器人签名密钥');
      const timestamp = String(Math.floor(now() / 1000));
      const sign = createHmac('sha256', `${timestamp}\n${settings.webhookSecret}`).update('').digest('base64');
      const response = await request(hook, { method: 'POST', auth: false, webhook: true,
        body: { timestamp, sign, msg_type: 'post', content:post } });
      return { messageId: null, acknowledged: true, channel: 'webhook', apiCode: response.code ?? response.StatusCode };
    }
    if (settings.channel !== 'app' || !UUID.test(uuid || '')) throw invalid('群消息缺少持久化发送标识或通道无效');
    const response = await request('/open-apis/im/v1/messages?receive_id_type=chat_id', { method: 'POST',
      body: { receive_id: id(settings.chatId), msg_type: 'post', content: JSON.stringify(post), uuid } });
    const messageId = response.data?.message_id;
    if (!ID.test(messageId || '')) throw uncertain('飞书可能已发送群消息，但未返回消息标识');
    return { messageId, acknowledged: true, channel: 'app' };
  }
  return { createDocument, writeDocument, ensureEditable, prepareSummaryImage, sendReport };
}
