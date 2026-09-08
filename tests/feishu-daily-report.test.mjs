import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { buildFeishuDailyDocumentPlan, createFeishuDailyClient, FeishuDailyError } from '../server/services/feishu-daily-report.js';

const CONFIG = { appId: 'cli_test', appSecret: 'private-app-secret', folderToken: 'folder_daily',
  documentBaseUrl: 'https://example.feishu.cn', channel: 'app', chatId: 'oc_customer', editorType: 'openid', editorId: 'ou_customer' };
const UUID = '82ac15ac-069c-44b9-b3ed-d9d9ff8cf623';
const counts = { monitor: 100, sdb: 80, positive: 30, neutral: 35, negative: 15, cold: 6, inProgress: null, processed: null, unclassified: 0, nonMonitor: 20 };
function snapshot(overrides = {}) {
  return { id: 'report_one', schemaVersion: 1, tenantId: 'tenant_one', tenantName: '客户', version: 1,
    reportDate: '2026-09-07', mode: 'formal', cutoffAt: '2026-09-07T16:00:00.000Z', assessedAt: '2026-09-08T02:00:00.000Z',
    heatStart: '2026-08-31T16:00:00.000Z', summary: { day: { ...counts }, mtd: { ...counts, monitor: 300, sdb: 280 } },
    highHeat: [{ recordId: 'r1', title: '高热原帖 <script>', platform: 'xiaohongshu', url: 'https://www.xiaohongshu.com/explore/123',
      heat: 320, observedAt: '2026-09-07T04:00:00Z', comparisonText: '暂无昨日数据' }],
    coldMarked: [{ recordId: 'r2', title: '旧帖本日冷处理', platform: 'douyin', url: 'https://www.douyin.com/video/456', markedAt: '2026-09-07T05:00:00Z' }],
    warnings: [], ...overrides };
}
const ok = data => ({ status: 200, json: async () => ({ code: 0, data }) });
const auth = () => ({ status: 200, json: async () => ({ code: 0, tenant_access_token: 'secret-token', expire: 7200 }) });
function harness({ members = [], permissions = {}, before, after } = {}) {
  const requests = [];
  const root = { block_id: 'doc_one', block_type: 1, children: [] };
  const blocks = [root];
  let nextId = 0;
  const policy = { external_access_entity: 'open', link_share_entity: 'closed', security_entity: 'anyone_can_edit', copy_entity: 'anyone_can_edit', ...permissions };
  const fetchImpl = async (url, options) => {
    const request = { url: new URL(url), method: options.method, options, body: options.body ? JSON.parse(options.body) : undefined };
    requests.push(request);
    const early = await before?.(request, { blocks, members });
    if (early) return early;
    const path = request.url.pathname;
    let response;
    if (path.endsWith('/tenant_access_token/internal')) response = auth();
    else if (path === '/open-apis/docx/v1/documents' && request.method === 'POST') response = ok({ document: { document_id: 'doc_one' } });
    else if (path.endsWith('/blocks') && request.method === 'GET') response = ok({ items: structuredClone(blocks), has_more: false });
    else if (path.endsWith('/descendant')) {
      const relations = request.body.descendants.map(block => ({ temporary_block_id: block.block_id, block_id: `remote_${nextId++}` }));
      const ids = new Map(relations.map(item => [item.temporary_block_id, item.block_id]));
      const addedRoots = request.body.children_id.map(temp => ids.get(temp));
      root.children.push(...addedRoots);
      blocks.push(...request.body.descendants.map(block => ({ ...structuredClone(block), block_id: ids.get(block.block_id),
        children: block.children.map(child => ids.get(child)) })));
      response = ok({ block_id_relations: relations });
    } else if (request.method === 'PATCH' && path.includes('/blocks/')) {
      const table = blocks.find(block => block.block_id === path.split('/').at(-1));
      table.table.property.merge_info ||= Array.from({ length: 32 }, () => ({ row_span: 1, col_span: 1 }));
      const merge = request.body.merge_table_cells;
      table.table.property.merge_info[merge.row_start_index * 8 + merge.column_start_index] = {
        row_span: merge.row_end_index - merge.row_start_index, col_span: merge.column_end_index - merge.column_start_index };
      response = ok({ block: structuredClone(table) });
    } else if (path.endsWith('/members') && request.method === 'GET') response = ok({ items: structuredClone(members) });
    else if (path.includes('/members') && ['POST', 'PUT'].includes(request.method)) {
      const body = request.body;
      const memberId = body.member_id || decodeURIComponent(path.split('/').at(-1));
      const member = { member_type: body.member_type, member_id: memberId, perm: body.perm, external_label: true };
      const existing = members.find(item => item.member_type === member.member_type && item.member_id === member.member_id);
      if (existing) Object.assign(existing, member); else members.push(member);
      response = ok({ member });
    } else if (path.endsWith('/public')) response = ok({ permission_public: policy });
    else if (path.endsWith('/messages')) response = ok({ message_id: 'om_message' });
    else if (path.includes('/bot/v2/hook/')) response = ok({});
    else throw new Error(`Unhandled request ${path}`);
    return await after?.(request, { blocks, members, response }) || response;
  };
  return { requests, blocks, members, policy, fetchImpl,
    client: createFeishuDailyClient(CONFIG, { fetchImpl, minWriteIntervalMs: 0 }) };
}
function mutations(h) { return h.requests.filter(r => r.method !== 'GET' && !r.url.pathname.includes('/auth/')); }
function savedProgress() {
  let progress;
  return { get: () => structuredClone(progress), save: async value => { progress = structuredClone(value); } };
}

test('native table preserves grouped headers and empty unknown cells; links remain text links', () => {
  const plan = buildFeishuDailyDocumentPlan(snapshot());
  const blocks = plan.batches.flatMap(batch => batch.descendants);
  const table = blocks.find(block => block.block_type === 31);
  assert.equal(table.table.property.row_size, 4);
  assert.equal(table.table.property.column_size, 8);
  assert.equal(table.table.property.merge_info, undefined);
  const map = new Map(blocks.map(block => [block.block_id, block]));
  const cellText = cellIndex => map.get(map.get(table.children[cellIndex]).children[0]).text.elements[0].text_run.content;
  for (const cellIndex of [22, 23, 30, 31]) assert.equal(cellText(cellIndex), '');
  assert.equal(cellText(5), '负面');
  assert.equal(cellText(13), '冷处理');
  assert.equal(cellText(14), '处理中');
  assert.equal(cellText(15), '已处理');
  const encoded = blocks.flatMap(block => block.text?.elements || []).find(e => e.text_run?.content === '高热原帖 <script>');
  assert.equal(encoded.text_run.text_element_style.link.url, encodeURIComponent('https://www.xiaohongshu.com/explore/123'));
  assert.equal(plan.merges.length, 6);
});

test('full lists are batched within API descendant limit, including large multi-page reports', () => {
  const rows = Array.from({ length: 650 }, (_, index) => ({ ...snapshot().highHeat[0], recordId: `r${index}`, title: `帖子${index}` }));
  const plan = buildFeishuDailyDocumentPlan(snapshot({ highHeat: rows }));
  assert.ok(plan.batches.length > 3);
  assert.ok(plan.batches.every(batch => batch.descendants.length <= 180 && batch.children_id.length <= 1000));
  assert.ok(JSON.stringify(plan).includes('TOP650'));
});

test('each hot post distinguishes measured observations from ingestion evidence and identifies comparison timestamp', () => {
  const base = snapshot().highHeat[0];
  const plan = buildFeishuDailyDocumentPlan(snapshot({ highHeat: [
    { ...base, quality: 'measured', timeSource: 'capture_timestamp', comparisonText: '↑180%', previousObservedAt: '2026-09-06T03:00:00Z' },
    { ...base, quality: 'legacy_unverified', timeSource: 'ingestion_time', comparisonText: '暂无昨日数据', stale: true },
    { ...base, quality: 'measured_ingestion_time', timeSource: 'ingestion_time', observedAt: null },
  ] }));
  const top = plan.batches.flatMap(batch => batch.descendants).filter(block => block.text?.elements?.[0]?.text_run?.content?.startsWith('TOP'))
    .map(block => block.text.elements.map(element => element.text_run.content).join(''));
  assert.match(top[0], /较昨日↑180%.*实测时间 2026\/09\/07 12:00.*可靠实测.*昨日实测时间 2026\/09\/06 11:00/);
  assert.match(top[1], /最近热度.*暂无昨日数据.*入库时间 2026\/09\/07 12:00.*历史入库记录，实测时间及可靠性未核实.*本日未更新/);
  assert.doesNotMatch(top[1], /较昨日暂无/);
  assert.match(top[2], /入库时间 未记录.*指标已核实，实测时间未核实/);
  assert.doesNotMatch(top.join(''), /更新于|1970/);
});

test('untrusted URL is not inserted as an executable link; history gap is not zero cold posts', () => {
  const plan = buildFeishuDailyDocumentPlan(snapshot({ highHeat: [{ title: '点击', platform: 'douyin', url: 'javascript:alert(1)', heat: 300 }],
    coldMarked: [], warnings: [{ code: 'cold_history_incomplete', message: '历史标记记录不完整' }] }));
  assert.ok(!JSON.stringify(plan).includes('javascript:'));
  assert.ok(JSON.stringify(plan).includes('原帖链接待补'));
  assert.ok(JSON.stringify(plan).includes('暂未检出，历史标记记录不完整'));
});

test('create uses exact specified folder; no default root; secrets go only to fixed official endpoint', async () => {
  const h = harness();
  assert.deepEqual(await h.client.createDocument({ title: '客户日报' }), { documentId: 'doc_one', url: 'https://example.feishu.cn/docx/doc_one' });
  assert.equal(mutations(h)[0].body.folder_token, 'folder_daily');
  assert.ok(h.requests.every(r => r.url.origin === 'https://open.feishu.cn' && r.options.redirect === 'error'));
  const client = createFeishuDailyClient({ ...CONFIG, folderToken: '' }, { fetchImpl: h.fetchImpl });
  await assert.rejects(client.createDocument({ title: '日报' }), { code: 'FEISHU_CONFIG_INVALID' });
  assert.equal(mutations(h).length, 1);
});

test('writes checkpoint before each append/merge and completed documents are never overwritten', async () => {
  const saved = savedProgress();
  const h = harness({ before(request) {
    if (request.url.pathname.endsWith('/descendant') || request.method === 'PATCH') assert.ok(saved.get()?.pending);
  } });
  const result = await h.client.writeDocument({ documentId: 'doc_one', snapshot: snapshot(), onProgress: saved.save });
  assert.equal(result.done, true);
  assert.equal(result.pending, null);
  assert.equal(result.completed.filter(step => step.key.startsWith('merge:')).length, 6);
  assert.equal(mutations(h).length, 7);
  // The customer changes the document; returning the completed checkpoint must not write or read it.
  h.blocks[1].heading1.elements[0].text_run.content = '客户修改';
  const requestCount = h.requests.length;
  await h.client.writeDocument({ documentId: 'doc_one', snapshot: snapshot(), onProgress: saved.save, progress: result });
  assert.equal(h.requests.length, requestCount);
});

test('failed pre-write checkpoint performs no remote mutation and redacts callback details', async () => {
  const h = harness();
  await assert.rejects(h.client.writeDocument({ documentId: 'doc_one', snapshot: snapshot(), onProgress: async () => { throw new Error('private db details'); } }),
    error => error.code === 'FEISHU_CHECKPOINT_FAILED' && !error.message.includes('private'));
  assert.equal(mutations(h).length, 0);
});

test('lost append response is ambiguous and recovery confirms exact subtree without another append', async () => {
  let lose = true;
  const saved = savedProgress();
  const h = harness({ after(request) {
    if (request.url.pathname.endsWith('/descendant') && lose) { lose = false; throw new Error('lost response private URL'); }
  } });
  await assert.rejects(h.client.writeDocument({ documentId: 'doc_one', snapshot: snapshot(), onProgress: saved.save }), error => error.ambiguous === true);
  assert.equal(saved.get().pending.key, 'body:0');
  const result = await h.client.writeDocument({ documentId: 'doc_one', snapshot: snapshot(), onProgress: saved.save, progress: saved.get() });
  assert.equal(result.done, true);
  assert.equal(h.requests.filter(r => r.url.pathname.endsWith('/descendant')).length, 1);
});

test('ambiguous append with no visible blocks never blindly retries', async () => {
  const saved = savedProgress();
  const h = harness({ before(request) {
    if (request.url.pathname.endsWith('/descendant')) throw new Error('connection reset');
  } });
  await assert.rejects(h.client.writeDocument({ documentId: 'doc_one', snapshot: snapshot(), onProgress: saved.save }), error => error.ambiguous);
  await assert.rejects(h.client.writeDocument({ documentId: 'doc_one', snapshot: snapshot(), onProgress: saved.save, progress: saved.get() }), error => error.ambiguous);
  assert.equal(h.requests.filter(r => r.url.pathname.endsWith('/descendant')).length, 1);
});

test('lost completed checkpoint is recovered from persisted pending; changed content is blocked', async () => {
  let state;
  const h = harness();
  const persist = async progress => {
    if (progress.completed.length) throw new Error('storage failure after remote success');
    state = structuredClone(progress);
  };
  await assert.rejects(h.client.writeDocument({ documentId: 'doc_one', snapshot: snapshot(), onProgress: persist }), error => error.ambiguous);
  h.blocks[1].heading1.elements[0].text_run.content = '客户编辑过了';
  await assert.rejects(h.client.writeDocument({ documentId: 'doc_one', snapshot: snapshot(), onProgress: async () => {}, progress: state }), error => error.ambiguous);
  assert.equal(h.requests.filter(r => r.url.pathname.endsWith('/descendant')).length, 1);
});

test('lost merge response is reconciled using merge_info rather than merging twice', async () => {
  let lose = true;
  const saved = savedProgress();
  const h = harness({ after(request) { if (request.method === 'PATCH' && lose) { lose = false; throw new Error('lost'); } } });
  await assert.rejects(h.client.writeDocument({ documentId: 'doc_one', snapshot: snapshot(), onProgress: saved.save }), error => error.ambiguous);
  assert.equal(saved.get().pending.key, 'merge:0');
  const result = await h.client.writeDocument({ documentId: 'doc_one', snapshot: snapshot(), onProgress: saved.save, progress: saved.get() });
  assert.equal(result.done, true);
  assert.equal(h.requests.filter(r => r.method === 'PATCH').length, 6);
});

test('known rate-limit rejection clears pending and allows later retry', async () => {
  let reject = true;
  const saved = savedProgress();
  const h = harness({ before(request) {
    if (request.url.pathname.endsWith('/descendant') && reject) { reject = false; return { status: 429, json: async () => ({ code: 99991400 }) }; }
  } });
  await assert.rejects(h.client.writeDocument({ documentId: 'doc_one', snapshot: snapshot(), onProgress: saved.save }), error => error.retryable && !error.ambiguous);
  assert.equal(saved.get().pending, null);
  assert.equal((await h.client.writeDocument({ documentId: 'doc_one', snapshot: snapshot(), onProgress: saved.save, progress: saved.get() })).done, true);
});

test('snapshot or document checkpoint mismatch cannot mutate', async () => {
  const saved = savedProgress();
  const h = harness();
  await h.client.writeDocument({ documentId: 'doc_one', snapshot: snapshot(), onProgress: saved.save });
  const size = h.requests.length;
  await assert.rejects(h.client.writeDocument({ documentId: 'doc_one', snapshot: snapshot({ version: 2 }), progress: saved.get(), onProgress: saved.save }), error => error.ambiguous);
  await assert.rejects(h.client.writeDocument({ documentId: 'doc_two', snapshot: snapshot(), progress: saved.get(), onProgress: saved.save }), error => error.ambiguous);
  assert.equal(h.requests.length, size);
});

test('grants only configured external editor, re-reads editable and retention policy, no all-web patch', async () => {
  const saved = savedProgress();
  const h = harness();
  const result = await h.client.ensureEditable({ documentId: 'doc_one', onProgress: saved.save });
  assert.equal(result.editable, true);
  assert.equal(result.retentionAllowed, true);
  const writes = mutations(h);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body, { member_type: 'openid', member_id: 'ou_customer', perm: 'edit', type: 'user' });
  assert.ok(!h.requests.some(r => r.url.pathname.endsWith('/public') && r.method !== 'GET'));
  await h.client.ensureEditable({ documentId: 'doc_one', progress: saved.get(), onProgress: saved.save });
  assert.equal(mutations(h).length, 1);
});

test('an existing viewer is upgraded through PUT, rather than duplicate member creation', async () => {
  const h = harness({ members: [{ member_type: 'openid', member_id: 'ou_customer', perm: 'view', external_label: true }] });
  await h.client.ensureEditable({ documentId: 'doc_one' });
  assert.equal(mutations(h)[0].method, 'PUT');
  assert.equal(mutations(h)[0].url.pathname, '/open-apis/drive/v1/permissions/doc_one/members/ou_customer');
  assert.equal(mutations(h)[0].body.perm, 'edit');
});

test('external sharing, retention and public link failures do not pass client edit verification', async () => {
  const policies = [
    [{ external_access_entity: 'closed' }, 'FEISHU_EXTERNAL_EDIT_BLOCKED'],
    [{ security_entity: 'only_full_access' }, 'FEISHU_RETENTION_BLOCKED'],
    [{ copy_entity: 'only_full_access' }, 'FEISHU_RETENTION_BLOCKED'],
    [{ link_share_entity: 'anyone_editable' }, 'FEISHU_PUBLIC_SHARING_UNSAFE'],
  ];
  for (const [permissions, code] of policies) {
    const h = harness({ members: [{ member_type: 'openid', member_id: 'ou_customer', perm: 'edit', external_label: true }], permissions });
    await assert.rejects(h.client.ensureEditable({ documentId: 'doc_one' }), error => error.code === code && error.needsAttention);
    assert.equal(mutations(h).length, 0);
  }
});

test('a verified customer-owned same-organization editor can retain internal documents', async () => {
  const h = harness({ members: [{ member_type: 'openid', member_id: 'ou_customer', perm: 'edit', external_label: false }],
    permissions: { external_access_entity: 'closed' } });
  assert.equal((await h.client.ensureEditable({ documentId: 'doc_one' })).external, false);
});

test('lost grant response is reconciled against exact member without granting twice', async () => {
  const saved = savedProgress();
  let lose = true;
  const h = harness({ after(request) {
    if (request.url.pathname.endsWith('/members') && request.method === 'POST' && lose) { lose = false; throw new Error('lost'); }
  } });
  await assert.rejects(h.client.ensureEditable({ documentId: 'doc_one', onProgress: saved.save }), error => error.ambiguous);
  assert.equal(saved.get().pending, true);
  assert.equal((await h.client.ensureEditable({ documentId: 'doc_one', onProgress: saved.save, progress: saved.get() })).editable, true);
  assert.equal(mutations(h).length, 1);
});

test('send-time verifyOnly never restores removed customer permissions', async () => {
  const saved = savedProgress();
  const h = harness();
  await h.client.ensureEditable({ documentId: 'doc_one', onProgress: saved.save });
  h.members.splice(0);
  await assert.rejects(h.client.ensureEditable({ documentId: 'doc_one', progress: saved.get(), verifyOnly: true }),
    error => error.code === 'FEISHU_EDITOR_NOT_VERIFIED' && error.needsAttention);
  assert.equal(mutations(h).length, 1);
});

test('email authorization persists canonical openid for later read-only verification', async () => {
  const saved = savedProgress();
  const h = harness({ after(request, state) {
    if (request.url.pathname.endsWith('/members') && request.method === 'POST') {
      state.members[0].member_type = 'openid';
      state.members[0].member_id = 'ou_email_resolved';
      return ok({ member: structuredClone(state.members[0]) });
    }
  } });
  const client = createFeishuDailyClient({ ...CONFIG, editorType: 'email', editorId: 'customer@example.test' }, { fetchImpl: h.fetchImpl });
  await client.ensureEditable({ documentId: 'doc_one', onProgress: saved.save });
  assert.equal(saved.get().member.member_id, 'ou_email_resolved');
  assert.equal((await client.ensureEditable({ documentId: 'doc_one', progress: saved.get(), verifyOnly: true })).editable, true);
  assert.equal(mutations(h).length, 1);
});

test('app message uses persisted UUID and includes editable document link without business counts or mentions', async () => {
  const h = harness();
  const sent = await h.client.sendReport({ documentUrl: 'https://example.feishu.cn/docx/doc_one', snapshot: snapshot(), uuid: UUID });
  assert.equal(sent.messageId, 'om_message');
  const write = mutations(h)[0];
  assert.equal(write.body.uuid, UUID);
  assert.equal(write.body.receive_id, 'oc_customer');
  const card = JSON.parse(write.body.content);
  assert.match(card.header.title.content, /正式日报 · v1$/);
  assert.equal(card.elements[1].actions[0].url, 'https://example.feishu.cn/docx/doc_one');
  assert.ok(!write.body.content.includes('320'));
  assert.ok(!write.body.content.includes('监控数量'));
  assert.ok(!write.body.content.includes('<at'));
});

test('updated version card preserves old-document context without copying business counts', async () => {
  const h = harness();
  await h.client.sendReport({ documentUrl: 'https://example.feishu.cn/docx/doc_one', snapshot: snapshot({ version: 3 }), uuid: UUID });
  const content = mutations(h)[0].body.content;
  const card = JSON.parse(content);
  assert.match(card.header.title.content, /v3$/);
  assert.match(card.elements[0].text.content, /旧版文档保留.*更正版交付.*合并客户已有修改/);
  assert.doesNotMatch(content, /320|监控数量|处理中|<at/);
});

test('signed webhook sends only to official hook, contains correct signature, and returns explicit acknowledgment', async () => {
  const h = harness();
  const timestamp = 1700000000;
  const client = createFeishuDailyClient({ ...CONFIG, channel: 'webhook', webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/12345678-1234-1234-1234-123456789012',
    webhookSecret: 'private-signing-key' }, { fetchImpl: h.fetchImpl, now: () => timestamp * 1000 });
  assert.deepEqual(await client.sendReport({ documentUrl: 'https://example.feishu.cn/docx/doc_one', snapshot: snapshot() }),
    { messageId: null, acknowledged: true, channel: 'webhook', apiCode: 0 });
  const write = mutations(h)[0];
  assert.equal(write.body.timestamp, String(timestamp));
  assert.equal(write.body.sign, createHmac('sha256', `${timestamp}\nprivate-signing-key`).update('').digest('base64'));
  assert.equal(write.options.headers.Authorization, undefined);
  assert.equal(h.requests.length, 1);
});

test('unsafe endpoint, injected document origin, absent webhook signature fail before network', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('should not call'); };
  for (const documentBaseUrl of ['https://example.feishu.cn.evil.test', 'https://example.feishu.cn@evil.test', 'http://example.feishu.cn', 'https://example.feishu.cn/private']) {
    assert.throws(() => createFeishuDailyClient({ ...CONFIG, documentBaseUrl }, { fetchImpl }), FeishuDailyError);
  }
  for (const webhookUrl of ['https://evil.test/hook/private', 'https://open.feishu.cn/open-apis/bot/v2/hook/1234567890?leak=1', 'https://open.feishu.cn/open-apis/docx/v1/documents']) {
    const client = createFeishuDailyClient({ ...CONFIG, channel: 'webhook', webhookUrl, webhookSecret: 's' }, { fetchImpl });
    await assert.rejects(client.sendReport({ documentUrl: 'https://example.feishu.cn/docx/doc_one', snapshot: snapshot() }), { code: 'FEISHU_CONFIG_INVALID' });
  }
  const unsigned = createFeishuDailyClient({ ...CONFIG, channel: 'webhook', webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/1234567890' }, { fetchImpl });
  await assert.rejects(unsigned.sendReport({ documentUrl: 'https://example.feishu.cn/docx/doc_one', snapshot: snapshot() }), { code: 'FEISHU_CONFIG_INVALID' });
  assert.equal(calls, 0);
});

test('network failure, 5xx, invalid result and request timeout are ambiguous without leaking secrets or retrying', async () => {
  const failures = [
    async () => { throw new Error('private-app-secret https://open.feishu.cn/hook/private-token'); },
    async () => ({ status: 503, json: async () => ({ msg: 'private-app-secret' }) }),
    async () => ({ status: 200, json: async () => ({ msg: 'private-app-secret' }) }),
    async () => new Promise(() => {}),
  ];
  for (const failure of failures) {
    let count = 0;
    const fetchImpl = async url => {
      if (url.includes('/auth/')) return auth();
      count++;
      return failure();
    };
    const client = createFeishuDailyClient(CONFIG, { fetchImpl, timeoutMs: 15, minWriteIntervalMs: 0 });
    await assert.rejects(client.createDocument({ title: '日报' }), error => {
      assert.equal(error.ambiguous, true);
      assert.equal(error.retryable, false);
      assert.equal(error.safeMessage, error.message);
      assert.ok(!JSON.stringify(error).includes('private-app-secret'));
      assert.ok(!error.message.includes('http'));
      return true;
    });
    assert.equal(count, 1);
  }
});

test('unknown webhook delivery is surfaced for confirmation and never automatically resent', async () => {
  let calls = 0;
  const client = createFeishuDailyClient({ ...CONFIG, channel: 'webhook',
    webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/123456789012', webhookSecret: 'private-signing-key' },
  { fetchImpl: async () => { calls++; return { status: 502, json: async () => ({ msg: 'unknown' }) }; } });
  await assert.rejects(client.sendReport({ documentUrl: 'https://example.feishu.cn/docx/doc_one', snapshot: snapshot() }),
    error => error.ambiguous && error.needsAttention && !error.retryable);
  assert.equal(calls, 1);
});
