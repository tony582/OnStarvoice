const state = {
  user: null,
  tenants: [],
  tenantId: '',
  page: 'overview',
  cache: new Map(),
};

function toggleTheme() {
  const html = document.documentElement;
  const isDark = html.getAttribute('data-theme') === 'dark';
  if (isDark) {
    html.removeAttribute('data-theme');
    localStorage.setItem('osv_theme', 'light');
  } else {
    html.setAttribute('data-theme', 'dark');
    localStorage.setItem('osv_theme', 'dark');
  }
}

const ICONS = {
  overview: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>',
  triage: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
  issues: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  reports: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  monitor: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><path d="M20.2 20.2c2.04-2.03.02-7.36-4.5-11.9-4.54-4.52-9.87-6.54-11.9-4.5-2.04 2.03-.02 7.36 4.5 11.9 4.54 4.52 9.87 6.54 11.9 4.5Z"/><path d="M15.7 15.7c4.52-4.54 6.54-9.87 4.5-11.9-2.03-2.04-7.36-.02-11.9 4.5-4.52 4.54-6.54 9.87-4.5 11.9 2.03 2.04 7.36.02 11.9-4.5Z"/></svg>',
  data: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
  tenants: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
  users: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  'auth-codes': '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  settings: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
};

const KPI_ICONS = {
  today: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>',
  negative: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  issues: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  triage: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
  label: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>',
};

const NAV = [
  { section: 'Workspace', items: [
    { id: 'overview', label: '总览' },
    { id: 'triage', label: '舆情收件箱' },
    { id: 'issues', label: '问题处置' },
    { id: 'reports', label: '报告中心' },
    { id: 'monitor', label: '监控任务' },
    { id: 'data', label: '数据资产' },
  ] },
  { section: 'Administration', internal: true, items: [
    { id: 'tenants', label: '租户管理' },
    { id: 'users', label: '用户账号', platformAdmin: true },
    { id: 'auth-codes', label: '激活码' },
    { id: 'settings', label: '系统设置' },
  ] },
];

const LABELS = {
  sentiment: { positive: '正面', neutral: '中性', negative: '负面', '': '待标注' },
  category: {
    safety_rescue: '安全救援',
    feature_usage: '功能使用',
    renewal_billing: '续费收费',
    privacy: '隐私安全',
    app_issue: 'App问题',
    service_quality: '服务质量',
    brand_image: '品牌形象',
    other: '其他',
    '': '待分类',
  },
  triage: {
    unhandled: '新线索',
    reviewing: '待复核',
    issue_linked: '已转问题',
    official_responded: '官方已响应',
    archived: '已归档',
    false_positive: '误报',
  },
  priority: { low: '低', normal: '普通', high: '高', urgent: '紧急' },
  issueStatus: {
    new: '新建',
    triage: '分诊',
    in_progress: '处理中',
    waiting: '等待',
    review: '复核',
    resolved: '已解决',
    closed: '已关闭',
    ignored: '忽略',
  },
  severity: { low: '低', medium: '中', high: '高', critical: '严重' },
  reportType: { daily: '日报', weekly: '周报', monthly: '月报' },
  reportStatus: { generating: '生成中', generated: '待发送', sent: '已发送', skipped: '无新增', failed: '失败' },
  role: {
    platform_admin: '平台管理员',
    internal_operator: '内部运营',
    tenant_admin: '客户管理员',
    tenant_analyst: '分析员',
    tenant_viewer: '只读',
    '': '无',
  },
};

document.addEventListener('DOMContentLoaded', boot);

// Close action dropdowns on outside click
document.addEventListener('click', (e) => {
  if (!e.target.closest('.action-dropdown')) {
    document.querySelectorAll('.action-dropdown.open').forEach(d => d.classList.remove('open'));
  }
});

async function boot() {
  try {
    const me = await api('/auth/me', { skipTenant: true, quiet: true });
    if (me.ok) {
      state.user = me.user;
      await enterApp();
      return;
    }
  } catch (_) {}
  showLogin();
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (!options.skipTenant && state.tenantId) headers['x-tenant-id'] = state.tenantId;
  const fetchOptions = {
    method: options.method || 'GET',
    credentials: 'same-origin',
    headers,
  };
  if (options.body !== undefined) fetchOptions.body = JSON.stringify(options.body);
  const resp = await fetch('/api' + path, fetchOptions);
  let data;
  try { data = await resp.json(); } catch (_) { data = { ok: false, message: '响应格式错误' }; }
  if (!resp.ok && !options.quiet) throw new Error(data.message || data.error || '请求失败');
  return data;
}

function showLogin() {
  document.getElementById('loginView').hidden = false;
  document.getElementById('appView').hidden = true;
}

async function login() {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errorEl = document.getElementById('loginError');
  errorEl.textContent = '';
  try {
    const data = await api('/auth/login', { method: 'POST', skipTenant: true, body: { email, password } });
    state.user = data.user;
    await enterApp();
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

async function logout() {
  await api('/auth/logout', { method: 'POST', skipTenant: true, quiet: true });
  state.user = null;
  state.tenantId = '';
  state.cache.clear();
  showLogin();
}

async function enterApp() {
  document.getElementById('loginView').hidden = true;
  document.getElementById('appView').hidden = false;
  document.getElementById('userBadge').textContent = `${state.user.name || state.user.email} · ${LABELS.role[state.user.globalRole] || currentTenantRoleLabel()}`;
  await loadTenants();
  renderNav();
  const savedPage = localStorage.getItem('osv_page') || 'overview';
  loadPage(savedPage);
}

async function loadTenants() {
  if (isInternal()) {
    const data = await api('/admin/tenants', { skipTenant: true });
    state.tenants = data.tenants || [];
  } else {
    state.tenants = (state.user.memberships || [])
      .filter(m => m.status === 'active')
      .map(m => ({ id: m.tenantId, name: m.tenantName }));
  }
  const saved = localStorage.getItem('osv_tenant_id');
  state.tenantId = state.tenants.some(t => t.id === saved) ? saved : (state.tenants[0]?.id || '');
  const select = document.getElementById('tenantSelect');
  select.innerHTML = state.tenants.map(t => `<option value="${escAttr(t.id)}">${esc(t.name)}</option>`).join('');
  select.value = state.tenantId;
  select.disabled = state.tenants.length <= 1;
}

function switchTenant(tenantId) {
  state.tenantId = tenantId;
  localStorage.setItem('osv_tenant_id', tenantId);
  state.cache.clear();
  loadPage(state.page);
}

function renderNav() {
  const nav = document.getElementById('navList');
  nav.innerHTML = NAV.map(group => {
    if (group.internal && !isInternal()) return '';
    const items = group.items.map(item => {
      if (item.platformAdmin && state.user.globalRole !== 'platform_admin') return '';
      const icon = ICONS[item.id] || '';
      return `<button class="nav-item" data-page="${escAttr(item.id)}" onclick="loadPage('${escAttr(item.id)}')"><span class="nav-icon">${icon}</span><span>${esc(item.label)}</span></button>`;
    }).join('');
    return `<div class="nav-section">${esc(group.section)}</div>${items}`;
  }).join('');
}

function loadPage(page) {
  if (page === 'users' && state.user.globalRole !== 'platform_admin') page = 'overview';
  if (['tenants', 'auth-codes', 'settings'].includes(page) && !isInternal()) page = 'overview';
  state.page = page;
  localStorage.setItem('osv_page', page);
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.page === page));
  const title = {
    overview: ['Workspace', '总览'],
    triage: ['Triage Inbox', '舆情收件箱'],
    issues: ['Issue Desk', '问题处置'],
    reports: ['Reports', '报告中心'],
    monitor: ['Monitoring', '监控任务'],
    data: ['Data Assets', '数据资产'],
    tenants: ['Administration', '租户管理'],
    users: ['Administration', '用户账号'],
    'auth-codes': ['Administration', '激活码'],
    settings: ['Administration', '系统设置'],
  }[page] || ['Workspace', '总览'];
  document.getElementById('pageEyebrow').textContent = title[0];
  document.getElementById('pageTitle').textContent = title[1];

  const loaders = {
    overview: renderOverview,
    triage: renderTriage,
    issues: renderIssues,
    reports: renderReports,
    monitor: renderMonitor,
    data: renderData,
    tenants: renderTenants,
    users: renderUsers,
    'auth-codes': renderAuthCodes,
    settings: renderSettings,
  };
  loaders[page]();
}

async function renderOverview() {
  const el = content();
  el.innerHTML = loading();
  const data = await api('/workspace/overview?days=7');
  const k = data.kpi || {};
  el.innerHTML = `
    <div class="kpi-grid">
      ${kpi('今日新增', k.today_new, '', KPI_ICONS.today)}
      ${kpi('负面内容', k.negative_period, 'negative', KPI_ICONS.negative)}
      ${kpi('待处理问题', k.open_issues, 'warning', KPI_ICONS.issues)}
      ${kpi('高危问题', k.high_open_issues, 'negative', KPI_ICONS.negative)}
      ${kpi('待分诊', k.unhandled, 'warning', KPI_ICONS.triage)}
      ${kpi('待标注', k.pending_label, '', KPI_ICONS.label)}
    </div>
    <div class="layout-grid">
      <div>
        ${panel('需要处理', renderPendingRecords(data.pendingRecords || []), 'panel-accent')}
        ${panel('风险趋势（近7日）', renderTrend(data.riskTrend || []))}
      </div>
      <div>
        ${panel('平台覆盖', renderPlatformCoverage(data.platformCoverage || []))}
        ${panel('报告状态', renderReportMini(data.reports || []))}
        ${panel('监控健康', renderMonitorMini(data.monitorHealth || []))}
      </div>
    </div>
  `;
}

async function renderTriage() {
  const el = content();
  const statusTabs = [
    { value: '', label: '待处理' },
    { value: 'unhandled', label: '新线索' },
    { value: 'reviewing', label: '待复核' },
    { value: 'issue_linked', label: '已转问题' },
    { value: 'official_responded', label: '已响应' },
    { value: 'archived', label: '已归档' },
  ];
  el.innerHTML = `
    <div class="page-intro">
      <div>
        <strong>默认只展示需要处理的线索</strong>
        <span>已归档、误报、已转问题和官方已响应内容会从默认队列移出，可通过状态筛选查看。</span>
      </div>
    </div>
    <div class="filter-tabs" id="triageStatusTabs">
      ${statusTabs.map(t => `<button class="filter-tab ${t.value === '' ? 'active' : ''}" data-value="${escAttr(t.value)}" onclick="setTriageStatus(this)">${esc(t.label)}</button>`).join('')}
    </div>
    <div class="toolbar">
      <div class="toolbar-left">
        <select id="triageSentiment" onchange="loadTriageTable()">
          <option value="">全部情感</option>
          ${option('negative', '🔴 负面')}
          ${option('neutral', '⚪ 中性')}
          ${option('positive', '🟢 正面')}
        </select>
        <div class="search-box">
          <svg class="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input id="triageKeyword" placeholder="搜索标题、正文、关键词…" onkeydown="if(event.key==='Enter')loadTriageTable()">
        </div>
      </div>
    </div>
    <input type="hidden" id="triageStatus" value="">
    <div id="triageTable"></div>
  `;
  await loadTriageTable();
}

function setTriageStatus(btn) {
  document.getElementById('triageStatus').value = btn.dataset.value;
  document.querySelectorAll('#triageStatusTabs .filter-tab').forEach(t => t.classList.toggle('active', t === btn));
  loadTriageTable();
}

async function loadTriageTable(page = 1) {
  const params = new URLSearchParams({
    page,
    pageSize: 30,
    status: valueOf('triageStatus'),
    queue: valueOf('triageStatus') ? '' : 'active',
    sentiment: valueOf('triageSentiment'),
    keyword: valueOf('triageKeyword'),
  });
  const data = await api('/triage/records?' + params);
  state.cache.set('triageRecords', data.records || []);
  document.getElementById('triageTable').innerHTML = recordTable(data.records || [], data.pagination, true, 'loadTriageTable');
}

async function renderIssues() {
  const el = content();
  el.innerHTML = loading();
  const data = await api('/issues?limit=100');
  const rows = (data.issues || []).map(i => `
    <tr>
      <td><button class="ghost" onclick="openIssue('${escAttr(i.id)}')">${esc(i.title || '未命名问题')}</button><div class="subtext">${esc(i.primary_record_platform || '')} ${esc(i.primary_record_title || '')}</div></td>
      <td>${badge(LABELS.severity[i.severity] || i.severity, i.severity)}</td>
      <td>${badge(LABELS.issueStatus[i.status] || i.status, i.status)}</td>
      <td>${esc(i.owner_name || '未分配')}</td>
      <td>${n(i.record_count)}</td>
      <td>${date(i.updated_at)}</td>
      <td>${canWrite() ? issueActions(i) : ''}</td>
    </tr>`).join('');
  el.innerHTML = `<div class="table-wrap"><table><thead><tr><th>问题</th><th>级别</th><th>状态</th><th>负责人</th><th>内容</th><th>更新时间</th><th>操作</th></tr></thead><tbody>${rows || emptyRow(7)}</tbody></table></div>`;
}

async function renderReports() {
  const el = content();
  el.innerHTML = `
    <div class="report-workbench">
      <section class="report-hero-panel">
        <div>
          <div class="eyebrow">Report Center</div>
          <h2>企业舆情报告看板</h2>
          <p>先生成后台可视化报告，再发送兼容邮件摘要。日报看新增风险，周报看趋势复盘，月报看管理层长期问题。</p>
        </div>
        <div class="report-generate-grid">
          <button class="report-generate-card" ${!canWrite() ? 'disabled' : ''} onclick="generateReport('daily')">
            <span>日报</span><strong>今日风险与待处理</strong><small>新增线索、负面评论、官方响应</small>
          </button>
          <button class="report-generate-card" ${!canWrite() ? 'disabled' : ''} onclick="generateReport('weekly')">
            <span>周报</span><strong>趋势变化与复盘</strong><small>主题演化、重点问题、行动建议</small>
          </button>
          <button class="report-generate-card" ${!canWrite() ? 'disabled' : ''} onclick="generateReport('monthly')">
            <span>月报</span><strong>管理层总结</strong><small>重复问题、处置效率、长期风险</small>
          </button>
        </div>
      </section>
      <section class="report-flow-grid">
        <div class="report-flow-card"><strong>1. 生成</strong><span>聚合帖子、评论、问题、告警和官方响应</span></div>
        <div class="report-flow-card"><strong>2. 预览</strong><span>检查管理报告、数据看板和邮件摘要</span></div>
        <div class="report-flow-card"><strong>3. 发送</strong><span>发送给系统设置里的邮件收件人</span></div>
      </section>
    </div>
    <div class="page-intro compact">
      <div>
        <strong>历史报告</strong>
        <span>同周期重复生成会更新同一份报告；发送失败时会保留错误原因，方便补配置后重发。</span>
      </div>
      <div class="action-row">
        <button class="secondary" onclick="loadReports()">刷新</button>
      </div>
    </div>
    <div id="reportsTable">${loading()}</div>
  `;
  await loadReports();
}

async function loadReports() {
  const data = await api('/reports?limit=100');
  const rows = (data.reports || []).map(r => `
    <tr>
      <td><div class="report-type-cell">${badge(LABELS.reportType[r.report_type] || r.report_type, 'neutral')}<strong>${esc(r.subject || '未命名报告')}</strong></div></td>
      <td>${esc(dateRange(r.period_start, r.period_end))}</td>
      <td>${badge(LABELS.reportStatus[r.status] || r.status, r.status)}${r.error_message ? `<div class="subtext danger-text">${esc(r.error_message)}</div>` : ''}</td>
      <td>${date(r.generated_at || r.created_at)}</td>
      <td>${date(r.sent_at)}</td>
      <td><div class="action-row"><button class="secondary" onclick="previewReport('${escAttr(r.id)}')">预览</button><button class="primary" ${!canWrite() ? 'disabled' : ''} onclick="sendReport('${escAttr(r.id)}')">发送</button></div></td>
    </tr>`).join('');
  document.getElementById('reportsTable').innerHTML = `<div class="table-wrap report-table"><table><thead><tr><th>报告</th><th>周期</th><th>状态</th><th>生成</th><th>发送</th><th>操作</th></tr></thead><tbody>${rows || emptyRow(6)}</tbody></table></div>`;
}

async function renderMonitor() {
  const el = content();
  el.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-left">
        <button class="primary" ${!canWrite() ? 'disabled' : ''} onclick="createSubscription()">新建监控</button>
      </div>
    </div>
    <div id="monitorTable">${loading()}</div>
  `;
  const data = await api('/monitor/subscriptions');
  const rows = (data.subscriptions || []).map(s => `
    <tr>
      <td>${esc(s.name || s.keyword)}<div class="subtext">${esc(s.keyword)}</div></td>
      <td>${esc(platformName(s.platform))}</td>
      <td>${badge(s.status === 'active' ? '运行中' : s.status, s.status)}</td>
      <td>${n(s.cadence_minutes)} 分钟</td>
      <td>${date(s.last_run_at)}</td>
      <td>${date(s.next_run_at)}</td>
      <td><button class="secondary" ${!canWrite() ? 'disabled' : ''} onclick="runMonitorNow('${escAttr(s.id)}')">立即执行</button></td>
    </tr>`).join('');
  document.getElementById('monitorTable').innerHTML = `<div class="table-wrap"><table><thead><tr><th>任务</th><th>平台</th><th>状态</th><th>频率</th><th>上次</th><th>下次</th><th>操作</th></tr></thead><tbody>${rows || emptyRow(7)}</tbody></table></div>`;
}

async function renderData() {
  const el = content();
  el.innerHTML = `<div id="dataTable">${loading()}</div>`;
  const data = await api('/triage/records?pageSize=50');
  state.cache.set('triageRecords', data.records || []);
  document.getElementById('dataTable').innerHTML = recordTable(data.records || [], data.pagination, false, 'renderDataPage');
}

async function renderDataPage(page) {
  const data = await api('/triage/records?pageSize=50&page=' + page);
  state.cache.set('triageRecords', data.records || []);
  document.getElementById('dataTable').innerHTML = recordTable(data.records || [], data.pagination, false, 'renderDataPage');
}

async function renderTenants() {
  const data = await api('/admin/tenants', { skipTenant: true });
  const rows = (data.tenants || []).map(t => `<tr><td>${esc(t.name)}</td><td>${badge(t.status, t.status)}</td><td>${date(t.created_at)}</td></tr>`).join('');
  content().innerHTML = `<div class="table-wrap"><table><thead><tr><th>租户</th><th>状态</th><th>创建时间</th></tr></thead><tbody>${rows || emptyRow(3)}</tbody></table></div>`;
}

async function renderUsers() {
  const el = content();
  el.innerHTML = `
    ${panel('创建账号', `
      <div class="form-grid">
        <label>邮箱<input id="newUserEmail" type="email"></label>
        <label>姓名<input id="newUserName"></label>
        <label>初始密码<input id="newUserPassword" type="password"></label>
        <label>账号类型<select id="newUserType" onchange="toggleUserFields()"><option value="tenant">客户账号</option><option value="internal">内部账号</option></select></label>
        <label id="newUserTenantWrap">租户<select id="newUserTenant"></select></label>
        <label id="newUserTenantRoleWrap">租户角色<select id="newUserRole"><option value="tenant_viewer">只读</option><option value="tenant_analyst">分析员</option><option value="tenant_admin">客户管理员</option></select></label>
        <label id="newUserGlobalRoleWrap" hidden>内部角色<select id="newUserGlobalRole"><option value="internal_operator">内部运营</option><option value="platform_admin">平台管理员</option></select></label>
      </div>
      <div class="toolbar"><div></div><button class="primary" onclick="createUser()">创建账号</button></div>
    `)}
    <div id="usersTable">${loading()}</div>
  `;
  document.getElementById('newUserTenant').innerHTML = state.tenants.map(t => `<option value="${escAttr(t.id)}">${esc(t.name)}</option>`).join('');
  toggleUserFields();
  await loadUsers();
}

async function loadUsers() {
  const data = await api('/admin/users', { skipTenant: true });
  const rows = (data.users || []).map(u => `
    <tr>
      <td>${esc(u.name || u.email)}<div class="subtext">${esc(u.email)}</div></td>
      <td>${badge(u.is_internal ? (LABELS.role[u.global_role] || u.global_role) : tenantRoleText(u.memberships), u.global_role || 'viewer')}</td>
      <td>${badge(u.status === 'active' ? '启用' : '禁用', u.status)}</td>
      <td>${date(u.last_login_at)}</td>
      <td><div class="action-row"><button class="secondary" onclick="resetPassword('${escAttr(u.id)}')">重置密码</button><button class="danger" onclick="setUserStatus('${escAttr(u.id)}','${u.status === 'active' ? 'disabled' : 'active'}')">${u.status === 'active' ? '禁用' : '启用'}</button></div></td>
    </tr>`).join('');
  document.getElementById('usersTable').innerHTML = `<div class="table-wrap"><table><thead><tr><th>用户</th><th>角色</th><th>状态</th><th>最近登录</th><th>操作</th></tr></thead><tbody>${rows || emptyRow(5)}</tbody></table></div>`;
}

async function renderAuthCodes() {
  const data = await api('/admin/auth-codes', { skipTenant: true });
  const rows = (data.codes || []).map(c => `
    <tr>
      <td><code>${esc(c.code)}</code><div class="subtext">${esc(c.tenant_name || '')}</div></td>
      <td>${badge(c.type, c.type)}</td>
      <td>${badge(c.status, c.status)}</td>
      <td>${esc(c.owner_name || c.owner_email || '-')}</td>
      <td>${n(c.binding_count)} / ${n(c.max_bindings)}</td>
      <td>${date(c.expires_at)}</td>
    </tr>`).join('');
  content().innerHTML = `<div class="toolbar"><div></div><button class="primary" onclick="createAuthCode()">创建激活码</button></div><div class="table-wrap"><table><thead><tr><th>激活码</th><th>类型</th><th>状态</th><th>客户</th><th>绑定</th><th>过期</th></tr></thead><tbody>${rows || emptyRow(6)}</tbody></table></div>`;
}

async function renderSettings() {
  const [data, officialData] = await Promise.all([
    api('/admin/settings'),
    api('/admin/official-accounts'),
  ]);
  const s = data.settings || {};
  content().innerHTML = `
    <div class="layout-grid">
      ${panel('AI 模型', `<div class="form-grid"><label>提供商<input id="llm_provider" value="${escAttr(s.llm_provider || '')}"></label><label>模型<input id="llm_model" value="${escAttr(s.llm_model || '')}"></label><label class="full">API Key<input id="llm_api_key" type="password" value=""></label></div><div class="toolbar"><div></div><button class="primary" onclick="saveSettings('llm')">保存</button></div>`)}
      ${panel('品牌相关性', renderBrandSettingsForm(s))}
      ${panel('报告时间', `<div class="form-grid"><label>日报时间<input id="report_daily_time" value="${escAttr(s.report_daily_time || '09:00')}"></label><label>周报时间<input id="report_weekly_time" value="${escAttr(s.report_weekly_time || '09:00')}"></label><label>月报日期<input id="report_monthly_day" value="${escAttr(s.report_monthly_day || '1')}"></label><label>月报时间<input id="report_monthly_time" value="${escAttr(s.report_monthly_time || '09:00')}"></label></div><div class="toolbar"><div></div><button class="primary" onclick="saveSettings('report')">保存</button></div>`)}
      ${panel('邮件发送', renderEmailSettingsForm(s))}
      ${panel('官方账号识别', renderOfficialAccountsForm(officialData.accounts || []))}
    </div>
  `;
}

function renderBrandSettingsForm(s) {
  return `
    <div class="form-grid">
      <label>品牌名<input id="brand_name" value="${escAttr(s.brand_name || '安吉星')}" placeholder="例如：安吉星"></label>
      <label>品牌别名<input id="brand_aliases" value="${escAttr(s.brand_aliases || 'OnStar, 安吉星')}" placeholder="多个用逗号分隔"></label>
      <label class="full">业务语境<textarea id="brand_business_context" rows="3" placeholder="说明这个品牌/产品到底做什么">${esc(s.brand_business_context || '汽车车联网、车辆安全救援、远程控制、车况检测、客服、续费和车主服务。')}</textarea></label>
      <label class="full">强相关词<textarea id="brand_relevance_terms" rows="3" placeholder="多个用逗号或换行分隔">${esc(s.brand_relevance_terms || '车联网, 车主, 车辆, 汽车, 远程启动, 远程控制, 车况检测, 道路救援, 紧急救援, SOS, 续费, 套餐, 客服, App, 车机, 定位, 流量, 别克, 凯迪拉克, 雪佛兰')}</textarea></label>
      <label class="full">常见误命中词<textarea id="brand_noise_terms" rows="3" placeholder="多个用逗号或换行分隔">${esc(s.brand_noise_terms || '安吉县, 安吉, 地名, 小区, 楼盘, 酒店, 民宿, 景区, 招聘, 店铺, 人名, 谐音, 星座, 明星, 宠物, 餐饮')}</textarea></label>
    </div>
    <p class="subtext">AI 会先判断内容是否与当前品牌真实相关。无关内容默认不进入舆情待处理队列，也不计入报告声量、负面率和趋势。</p>
    <div class="toolbar"><div></div><button class="primary" onclick="saveSettings('brand')">保存</button></div>
  `;
}

function renderEmailSettingsForm(s) {
  return `
    <div class="form-grid">
      <label>SMTP 主机<input id="smtp_host" placeholder="smtp.example.com" value="${escAttr(s.smtp_host || '')}"></label>
      <label>SMTP 端口<input id="smtp_port" type="number" min="1" placeholder="465" value="${escAttr(s.smtp_port || '465')}"></label>
      <label>安全连接
        <select id="smtp_secure">
          <option value="true" ${s.smtp_secure !== 'false' ? 'selected' : ''}>SSL/TLS（推荐 465）</option>
          <option value="false" ${s.smtp_secure === 'false' ? 'selected' : ''}>STARTTLS/非 SSL（常见 587）</option>
        </select>
      </label>
      <label>SMTP 账号<input id="smtp_user" autocomplete="username" value="${escAttr(s.smtp_user || '')}"></label>
      <label class="full">SMTP 密码/授权码<input id="smtp_pass" type="password" autocomplete="new-password" placeholder="${s.smtp_pass ? '已保存，留空不修改' : '邮箱服务商 SMTP 授权码'}"></label>
      <label>发件人<input id="email_from" placeholder="OnStarVoice <noreply@example.com>" value="${escAttr(s.email_from || '')}"></label>
      <label>收件人<input id="email_to" placeholder="a@example.com,b@example.com" value="${escAttr(s.email_to || '')}"></label>
    </div>
    <p class="subtext">报告发送按钮会把邮件发给“收件人”。多个地址用英文逗号分隔；SMTP 密码留空不会覆盖已保存配置。</p>
    <div class="toolbar"><div></div><button class="primary" onclick="saveSettings('email')">保存</button></div>
  `;
}

function recordTable(records, pagination, withActions, pageHandlerName) {
  const rows = records.map(r => `
    <tr>
      <td>${recordListCell(r)}</td>
      <td>${esc(r.author_name || '-')}</td>
      <td>${aiJudgementCell(r)}</td>
      <td class="number-group">${n(r.likes)} / ${n(r.comments_count)} / ${n(r.collects)} / ${n(r.shares)}</td>
      <td>${commentRiskCell(r)}</td>
      <td>${officialResponseCell(r)}</td>
      <td>${badge(LABELS.triage[r.triage_status] || r.triage_status, r.triage_status)}</td>
      ${withActions ? `<td>${triageActions(r)}</td>` : ''}
    </tr>`).join('');
  const cols = withActions ? 8 : 7;
  return `<div class="table-wrap"><table><thead><tr><th>内容</th><th>作者</th><th>AI判断</th><th>互动</th><th>评论风险</th><th>官方响应</th><th>处理状态</th>${withActions ? '<th>分流动作</th>' : ''}</tr></thead><tbody>${rows || emptyRow(cols)}</tbody></table></div>${paginationHtml(pagination, pageHandlerName)}`;
}

function recordListCell(record) {
  const title = recordTitle(record);
  const cover = recordImageUrls(record)[0];
  return `
    <div class="record-list-cell">
      ${cover ? imageBox(cover, 'record-row-thumb', title) : `<button class="record-row-thumb is-empty" onclick="openRecord('${escAttr(record.id)}')" aria-label="查看内容"><span>${esc(noteTypeLabel(record.note_type) || platformName(record.platform).slice(0, 2))}</span></button>`}
      <div class="record-list-main">
        <div class="record-list-meta">${badge(platformName(record.platform), 'neutral')}<span>${date(record.last_seen_at || record.created_at)}</span></div>
        <button class="ghost truncate" onclick="openRecord('${escAttr(record.id)}')">${esc(title)}</button>
        <div class="subtext">${esc(compact(record.content || record.ai_summary || '', 86))}</div>
      </div>
    </div>
  `;
}

function aiJudgementCell(record) {
  const ai = parseObject(record.ai_result);
  if (ai.relevance === 'irrelevant') {
    return `<div class="mini-stack">
      ${badge('无关内容', 'muted')}
      <span class="subtext">${esc(compact(ai.relevanceReason || ai.summary || 'AI 判定与当前品牌无关', 44))}</span>
    </div>`;
  }
  if (ai.relevance === 'uncertain') {
    return `<div class="mini-stack">
      ${badge('待确认相关性', 'warning')}
      ${badge(LABELS.sentiment[record.sentiment] || record.sentiment || '待标注', record.sentiment || 'muted')}
    </div>`;
  }
  return `<div class="mini-stack">
    ${badge(LABELS.sentiment[record.sentiment] || record.sentiment || '待标注', record.sentiment || 'muted')}
    ${badge(LABELS.category[record.category] || record.category || '待分类', record.category ? 'neutral' : 'muted')}
  </div>`;
}

function commentRiskCell(record) {
  const count = Number(record.negative_comment_count || 0);
  if (count <= 0) return '<span class="subtext">暂无负面评论</span>';
  return `<div class="mini-stack">
    ${badge(`负面评论 ${n(count)}`, 'negative')}
    <span class="subtext">${esc(compact(record.latest_negative_comment || '', 44))}</span>
  </div>`;
}

function officialResponseCell(record) {
  if (record.official_response_status === 'responded') return badge('官方已响应', 'positive');
  if (record.official_response_status === 'needs_followup') return badge('响应后仍有风险', 'warning');
  if (record.official_replied) return badge('已发现回复', 'neutral');
  return '<span class="subtext">未发现</span>';
}

function triageActions(r) {
  if (!canWrite()) return '';
  return `<div class="action-group">
    <button class="primary" onclick="linkRecordIssue('${escAttr(r.id)}')">转问题</button>
    <div class="action-dropdown">
      <button class="secondary action-more" onclick="this.parentElement.classList.toggle('open')">更多</button>
      <div class="action-menu">
        <button onclick="markOfficialResponded('${escAttr(r.id)}'); this.closest('.action-dropdown').classList.remove('open')">标为已响应</button>
        <button onclick="updateTriage('${escAttr(r.id)}','reviewing'); this.closest('.action-dropdown').classList.remove('open')">移入待复核</button>
        <button onclick="updateTriage('${escAttr(r.id)}','archived'); this.closest('.action-dropdown').classList.remove('open')">归档</button>
        <button onclick="updateTriage('${escAttr(r.id)}','false_positive'); this.closest('.action-dropdown').classList.remove('open')">标为误报</button>
      </div>
    </div>
  </div>`;
}

function issueActions(i) {
  return `<div class="action-row">
    <button class="secondary" onclick="updateIssue('${escAttr(i.id)}','in_progress')">处理</button>
    <button class="primary" onclick="updateIssue('${escAttr(i.id)}','resolved')">解决</button>
  </div>`;
}

async function updateTriage(recordId, status) {
  await api('/triage/records/' + recordId, { method: 'PATCH', body: { status } });
  toast('分诊已更新', 'success');
  if (state.page === 'overview') renderOverview(); else loadTriageTable();
}

async function markOfficialResponded(recordId) {
  await api('/records/' + recordId + '/official-response', { method: 'PATCH', body: { status: 'responded' } });
  toast('已标记为官方已响应', 'success');
  if (state.page === 'triage') loadTriageTable();
}

async function linkRecordIssue(recordId) {
  const title = prompt('问题标题');
  if (title === null) return;
  await api('/triage/records/' + recordId + '/issues', { method: 'POST', body: { title } });
  toast('已转入问题处置', 'success');
  if (state.page === 'triage') loadTriageTable();
}

async function openRecord(recordId) {
  const records = state.cache.get('triageRecords') || [];
  const record = records.find(r => r.id === recordId);
  if (!record) return;
  const images = recordImageUrls(record);
  const title = recordTitle(record);
  const originalUrl = safeUrl(record.url);
  const profileUrl = safeUrl(record.blogger_profile_url);
  const [commentData, observationData] = await Promise.all([
    api('/records/' + recordId + '/comments', { quiet: true }).catch(() => ({ comments: [], officialResponses: [] })),
    api('/records/' + recordId + '/observations', { quiet: true }).catch(() => ({ observations: [] })),
  ]);
  const comments = commentData.comments || [];
  const officialResponses = commentData.officialResponses || [];
  const observations = observationData.observations || [];
  openDrawer('舆情内容', title, `
    <article class="record-detail">
      <section class="record-hero">
        ${images[0] ? imageBox(images[0], 'record-cover', title) : `<div class="record-cover is-empty"><span>暂无封面图</span></div>`}
        <div class="record-summary">
          <div class="record-badges">
            ${badge(platformName(record.platform), 'neutral')}
            ${badge(LABELS.sentiment[record.sentiment] || '待标注', record.sentiment || 'muted')}
            ${badge(LABELS.category[record.category] || '待分类', record.category ? 'neutral' : 'muted')}
            ${record.triage_status ? badge(LABELS.triage[record.triage_status] || record.triage_status, record.triage_status) : ''}
          </div>
          <div class="record-author-card">
            ${authorAvatar(record)}
            <div class="record-author-text">
              <strong>${esc(record.author_name || '未知作者')}</strong>
              <span>${esc(authorMeta(record))}</span>
            </div>
          </div>
          <div class="record-stat-grid">
            ${statTile('点赞', record.likes)}
            ${statTile('评论', record.comments_count)}
            ${statTile('收藏', record.collects)}
            ${statTile('转发', record.shares)}
          </div>
          <div class="record-link-row">
            ${originalUrl ? `<a class="primary-link" href="${escAttr(originalUrl)}" target="_blank" rel="noopener noreferrer">打开原文</a>` : '<span class="subtext">暂无原文链接</span>'}
            ${profileUrl ? `<a class="secondary-link" href="${escAttr(profileUrl)}" target="_blank" rel="noopener noreferrer">博主主页</a>` : ''}
          </div>
        </div>
      </section>

      <div class="record-tabs">
        <button class="record-tab active" onclick="switchRecordTab(this, 'post')">帖子内容</button>
        <button class="record-tab" onclick="switchRecordTab(this, 'comments')">评论舆情 ${comments.length ? `(${n(comments.length)})` : ''}</button>
        <button class="record-tab" onclick="switchRecordTab(this, 'official')">官方响应 ${officialResponses.length ? `(${n(officialResponses.length)})` : ''}</button>
        <button class="record-tab" onclick="switchRecordTab(this, 'observations')">采集快照</button>
      </div>

      <section class="record-tab-panel" data-tab-panel="post">
        <div class="record-section">
          <h3>正文</h3>
          <p class="record-content">${esc(record.content || '无正文')}</p>
        </div>
        ${images.length > 1 ? `
          <div class="record-section">
            <h3>图片</h3>
            <div class="record-image-grid">
              ${images.map((url, index) => imageBox(url, 'record-image-tile', `${title} 图片 ${index + 1}`)).join('')}
            </div>
          </div>
        ` : ''}
      </section>

      <section class="record-tab-panel" data-tab-panel="comments" hidden>
        ${renderCommentPanel(comments)}
      </section>

      <section class="record-tab-panel" data-tab-panel="official" hidden>
        ${renderOfficialResponsePanel(record, officialResponses)}
      </section>

      <section class="record-tab-panel" data-tab-panel="observations" hidden>
        ${renderObservationPanel(record, observations)}
      </section>
    </article>
  `);
}

function switchRecordTab(button, tabName) {
  const detail = button.closest('.record-detail');
  detail.querySelectorAll('.record-tab').forEach(tab => tab.classList.toggle('active', tab === button));
  detail.querySelectorAll('[data-tab-panel]').forEach(panel => {
    panel.hidden = panel.dataset.tabPanel !== tabName;
  });
}

function renderCommentPanel(comments) {
  if (!comments.length) return '<div class="empty-state">暂无独立评论数据。需要在插件采集时开启评论采集。</div>';
  return `<div class="comment-list">
    ${comments.map(comment => `
      <div class="comment-item ${comment.is_negative ? 'negative' : ''}">
        <div class="comment-head">
          <strong>${esc(comment.author_name || '未知评论者')}</strong>
          <span>${esc(comment.published_at || date(comment.created_at))}</span>
          ${comment.is_official ? badge('官方回复', 'positive') : ''}
          ${comment.is_negative ? badge(`负面 · ${comment.risk_level || 'low'}`, 'negative') : badge(LABELS.sentiment[comment.sentiment] || '中性', 'muted')}
        </div>
        <p>${esc(comment.content || '')}</p>
        <div class="comment-foot">
          <span>点赞 ${n(comment.like_count)}${comment.ip_location ? ` · IP ${esc(comment.ip_location)}` : ''}</span>
          ${canWrite() && comment.is_negative ? `<button class="secondary" onclick="linkCommentIssue('${escAttr(comment.id)}')">转问题</button>` : ''}
        </div>
      </div>
    `).join('')}
  </div>`;
}

function renderOfficialResponsePanel(record, responses) {
  return `
    <div class="record-section">
      <h3>响应状态</h3>
      <div class="record-info-grid">
        ${infoItem('官方状态', officialResponseCell(record), true)}
        ${infoItem('负面评论', `${n(record.negative_comment_count)} 条`)}
        ${infoItem('最近负评', date(record.latest_negative_comment_at))}
        ${infoItem('最后采集', date(record.last_seen_at || record.created_at))}
      </div>
    </div>
    <div class="record-section">
      <h3>官方回复记录</h3>
      ${responses.length ? `<div class="comment-list">${responses.map(item => `
        <div class="comment-item official">
          <div class="comment-head"><strong>${esc(item.account_name || '官方账号')}</strong><span>${esc(item.published_at || date(item.created_at))}</span>${badge('官方回复', 'positive')}</div>
          <p>${esc(item.content || '')}</p>
        </div>
      `).join('')}</div>` : '<div class="empty-state">暂无官方回复记录</div>'}
    </div>
  `;
}

function renderObservationPanel(record, observations) {
  return `
    <div class="record-section">
      <h3>采集信息</h3>
      <div class="record-info-grid">
        ${infoItem('关键词', record.keyword || '-')}
        ${infoItem('内容类型', noteTypeLabel(record.note_type) || '-')}
        ${infoItem('发布时间', record.publish_time || '-')}
        ${infoItem('首次发现', date(record.first_seen_at))}
        ${infoItem('最近采集', date(record.last_seen_at || record.created_at))}
        ${infoItem('采集次数', `${n(record.seen_count)} 次`)}
        ${infoItem('评论采集', commentsCaptureLabel(record))}
        ${infoItem('关联问题', `${n(record.issue_count)} 个`)}
      </div>
    </div>
    <div class="record-section">
      <h3>快照</h3>
      ${observations.length ? `<div class="mini-list">${observations.slice(0, 10).map(item => `
        <div class="mini-item"><strong>${n(item.likes)} 赞 / ${n(item.comments_count)} 评 / ${n(item.collects)} 藏 / ${n(item.shares)} 转</strong><span class="subtext">${date(item.captured_at)} · ${esc(item.keyword || '-')}</span></div>
      `).join('')}</div>` : '<div class="empty-state">暂无采集快照</div>'}
    </div>
  `;
}

async function linkCommentIssue(commentId) {
  const title = prompt('问题标题', '负面评论跟进');
  if (title === null) return;
  await api('/comments/' + commentId + '/issues', { method: 'POST', body: { title } });
  toast('评论已转入问题处置', 'success');
  closeDrawer();
  if (state.page === 'triage') loadTriageTable();
}

async function openIssue(issueId) {
  const data = await api('/issues/' + issueId);
  const issue = data.issue;
  openDrawer('问题处置', issue.title, `
    <div class="drawer-section">
      ${metric('状态', badge(LABELS.issueStatus[issue.status] || issue.status, issue.status), true)}
      ${metric('级别', badge(LABELS.severity[issue.severity] || issue.severity, issue.severity), true)}
      ${metric('负责人', issue.owner_name || '未分配')}
      ${metric('截止时间', date(issue.due_at))}
    </div>
    <div class="drawer-section"><h3>摘要</h3><p>${esc(issue.summary || '暂无摘要')}</p></div>
    <div class="drawer-section"><h3>处理建议</h3><p>${esc(issue.suggested_action || '暂无建议')}</p></div>
    <div class="drawer-section"><h3>关联内容</h3>${(data.records || []).map(r => `<div class="mini-item"><strong>${esc(r.title || r.content || '(无标题)')}</strong><span class="subtext">${esc(platformName(r.platform))} · ${n(r.likes + r.comments_count + r.collects + r.shares)} 互动</span></div>`).join('') || '<div class="empty-state">暂无关联内容</div>'}</div>
    <div class="drawer-section"><h3>时间线</h3>${(data.events || []).map(e => `<div class="mini-item"><strong>${esc(e.body || e.event_type)}</strong><span class="subtext">${esc(e.actor_name || e.actor_type)} · ${date(e.created_at)}</span></div>`).join('') || '<div class="empty-state">暂无记录</div>'}</div>
  `);
}

async function updateIssue(issueId, status) {
  await api('/issues/' + issueId, { method: 'PATCH', body: { status } });
  toast('问题状态已更新', 'success');
  renderIssues();
}

async function generateReport(type) {
  const data = await api('/reports/generate', { method: 'POST', body: { type, send: false } });
  toast(`${LABELS.reportType[type]}已生成`, 'success');
  await loadReports();
  if (data.report?.id) previewReport(data.report.id);
}

async function previewReport(id) {
  const data = await api('/reports/' + id + '/preview');
  const panes = {
    management: data.managementHtml || data.html || '',
    dashboard: data.dashboardHtml || data.html || '',
    email: data.emailHtml || data.html || '',
  };
  openDrawer('报告预览', data.report.subject || '报告', `
    <div class="report-preview-shell" id="reportPreview_${escAttr(id)}">
      <div class="report-preview-toolbar">
        <div class="segmented-control">
          <button class="active" data-report-tab="management" onclick="switchReportPreviewTab('${escAttr(id)}', 'management')">管理报告</button>
          <button data-report-tab="dashboard" onclick="switchReportPreviewTab('${escAttr(id)}', 'dashboard')">数据看板</button>
          <button data-report-tab="email" onclick="switchReportPreviewTab('${escAttr(id)}', 'email')">邮件摘要</button>
        </div>
        <div class="report-preview-meta">
          ${badge(LABELS.reportType[data.report.report_type] || data.report.report_type, 'neutral')}
          ${badge(LABELS.reportStatus[data.report.status] || data.report.status, data.report.status)}
        </div>
      </div>
      <div class="preview-frame report-preview-pane active" data-report-pane="management">${panes.management || '<div class="empty-state">暂无管理报告</div>'}</div>
      <div class="preview-frame report-preview-pane" data-report-pane="dashboard">${panes.dashboard || '<div class="empty-state">暂无数据看板</div>'}</div>
      <div class="preview-frame report-preview-pane" data-report-pane="email">${panes.email || '<div class="empty-state">暂无邮件摘要</div>'}</div>
    </div>
  `, { className: 'drawer-wide' });
}

async function sendReport(id) {
  try {
    await api('/reports/' + id + '/send', { method: 'POST' });
    toast('报告已发送', 'success');
    loadReports();
  } catch (err) {
    toast(err.message || '报告发送失败，请检查邮件配置', 'error');
    await loadReports();
  }
}

function switchReportPreviewTab(id, tab) {
  const root = document.getElementById('reportPreview_' + id);
  if (!root) return;
  root.querySelectorAll('[data-report-tab]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.reportTab === tab);
  });
  root.querySelectorAll('[data-report-pane]').forEach(pane => {
    pane.classList.toggle('active', pane.dataset.reportPane === tab);
  });
}

async function createSubscription() {
  const keyword = prompt('监控关键词');
  if (!keyword) return;
  const platform = prompt('平台：weibo / xiaohongshu / douyin', 'weibo') || '';
  await api('/monitor/subscriptions', { method: 'POST', body: { keyword, platform, cadenceMinutes: 1440 } });
  toast('监控任务已创建', 'success');
  renderMonitor();
}

async function runMonitorNow(id) {
  await api('/monitor/run-now', { method: 'POST', body: { subscriptionId: id } });
  toast('已创建执行任务', 'success');
}

function toggleUserFields() {
  const isInternalUser = valueOf('newUserType') === 'internal';
  document.getElementById('newUserTenantWrap').hidden = isInternalUser;
  document.getElementById('newUserTenantRoleWrap').hidden = isInternalUser;
  document.getElementById('newUserGlobalRoleWrap').hidden = !isInternalUser;
}

async function createUser() {
  const isInternalUser = valueOf('newUserType') === 'internal';
  await api('/admin/users', {
    method: 'POST',
    skipTenant: true,
    body: {
      email: valueOf('newUserEmail'),
      name: valueOf('newUserName'),
      password: valueOf('newUserPassword'),
      isInternal: isInternalUser,
      globalRole: isInternalUser ? valueOf('newUserGlobalRole') : '',
      tenantId: isInternalUser ? '' : valueOf('newUserTenant'),
      role: isInternalUser ? '' : valueOf('newUserRole'),
    },
  });
  toast('账号已创建', 'success');
  await loadUsers();
}

async function resetPassword(id) {
  const password = prompt('输入新密码，至少 8 位');
  if (!password) return;
  await api('/admin/users/' + id + '/reset-password', { method: 'POST', skipTenant: true, body: { password } });
  toast('密码已重置', 'success');
}

async function setUserStatus(id, status) {
  await api('/admin/users/' + id, { method: 'PATCH', skipTenant: true, body: { status } });
  toast('账号状态已更新', 'success');
  await loadUsers();
}

async function createAuthCode() {
  const ownerName = prompt('客户名称') || '';
  const tenantId = state.tenantId;
  const data = await api('/admin/auth-codes', { method: 'POST', skipTenant: true, body: { type: 'annual', ownerName, tenantId } });
  toast('激活码已创建：' + data.code, 'success');
  renderAuthCodes();
}

async function saveSettings(group) {
  const body = {};
  if (group === 'llm') {
    body.llm_provider = valueOf('llm_provider');
    body.llm_model = valueOf('llm_model');
    if (valueOf('llm_api_key')) body.llm_api_key = valueOf('llm_api_key');
  } else {
    if (group === 'brand') {
      body.brand_name = valueOf('brand_name').trim();
      body.brand_aliases = valueOf('brand_aliases').trim();
      body.brand_business_context = valueOf('brand_business_context').trim();
      body.brand_relevance_terms = valueOf('brand_relevance_terms').trim();
      body.brand_noise_terms = valueOf('brand_noise_terms').trim();
    }
    if (group === 'report') {
      body.report_daily_time = valueOf('report_daily_time');
      body.report_weekly_time = valueOf('report_weekly_time');
      body.report_monthly_day = valueOf('report_monthly_day');
      body.report_monthly_time = valueOf('report_monthly_time');
    }
    if (group === 'email') {
      body.smtp_host = valueOf('smtp_host').trim();
      body.smtp_port = valueOf('smtp_port').trim() || '465';
      body.smtp_secure = valueOf('smtp_secure') || 'true';
      body.smtp_user = valueOf('smtp_user').trim();
      if (valueOf('smtp_pass')) body.smtp_pass = valueOf('smtp_pass');
      body.email_from = valueOf('email_from').trim();
      body.email_to = valueOf('email_to').trim();
    }
  }
  await api('/admin/settings', { method: 'PUT', body });
  toast('设置已保存', 'success');
}

function renderOfficialAccountsForm(accounts) {
  const byPlatform = new Map((accounts || []).map(account => [account.platform, account]));
  const platforms = ['xiaohongshu', 'weibo', 'douyin'];
  return `
    <div class="official-account-list">
      ${platforms.map(platform => officialAccountRow(platform, byPlatform.get(platform))).join('')}
    </div>
    <div class="toolbar">
      <div class="subtext">官方账号发布的内容默认不进入待处理队列；普通用户内容下的官方回复会被记录为处置进展。</div>
      <button class="primary" onclick="saveOfficialAccounts()">保存官方账号</button>
    </div>
  `;
}

function officialAccountRow(platform, account = {}) {
  const aliases = parseArray(account.aliases).join(', ');
  return `
    <div class="official-account-row" data-platform="${escAttr(platform)}">
      <strong>${esc(platformName(platform))}</strong>
      <label>账号名称<input data-field="accountName" value="${escAttr(account.account_name || account.accountName || '')}" placeholder="安吉星OnStar"></label>
      <label>账号ID<input data-field="accountId" value="${escAttr(account.account_id || account.accountId || '')}" placeholder="可选"></label>
      <label>主页URL<input data-field="profileUrl" value="${escAttr(account.profile_url || account.profileUrl || '')}" placeholder="可选"></label>
      <label>别名<input data-field="aliases" value="${escAttr(aliases)}" placeholder="安吉星, OnStar"></label>
    </div>
  `;
}

async function saveOfficialAccounts() {
  const accounts = Array.from(document.querySelectorAll('.official-account-row')).map(row => {
    const field = name => row.querySelector(`[data-field="${name}"]`)?.value || '';
    return {
      platform: row.dataset.platform,
      accountName: field('accountName').trim(),
      accountId: field('accountId').trim(),
      profileUrl: field('profileUrl').trim(),
      aliases: field('aliases').split(',').map(v => v.trim()).filter(Boolean),
      skipContent: true,
    };
  }).filter(account => account.platform && account.accountName);
  await api('/admin/official-accounts', { method: 'PUT', body: { accounts } });
  toast('官方账号配置已保存', 'success');
}

function renderPendingRecords(records) {
  if (!records.length) return emptyState('📭', '暂无待处理内容', '所有舆情内容已处理完毕');
  return `<div class="mini-list">${records.slice(0, 8).map(r => {
    const interactions = Number(r.likes || 0) + Number(r.comments_count || 0) + Number(r.collects || 0) + Number(r.shares || 0);
    return `<div class="mini-item">
      <div class="mini-item-row"><strong class="truncate">${esc(r.title || r.content || '(无标题)')}</strong>${badge(LABELS.sentiment[r.sentiment] || '待标注', r.sentiment || 'muted')}</div>
      <span class="subtext">${badge(platformName(r.platform), 'neutral')} <span>${n(interactions)} 互动</span></span>
    </div>`;
  }).join('')}</div>`;
}

function renderTrend(rows) {
  if (!rows.length) return emptyState('📊', '暂无趋势数据', '采集数据后将显示风险趋势');
  const maxTotal = Math.max(...rows.map(r => Number(r.total) || 1), 1);
  return `<div class="trend-chart">${rows.map(r => {
    const total = Number(r.total) || 0;
    const neg = Number(r.negative) || 0;
    const pct = Math.round(total / maxTotal * 100);
    const negPct = total > 0 ? Math.round(neg / total * 100) : 0;
    const dayLabel = String(r.day || '').slice(5);
    return `<div class="trend-bar-group">
      <div class="trend-bar-wrap">
        <div class="trend-bar" style="height:${pct}%">
          ${neg > 0 ? `<div class="trend-bar-neg" style="height:${negPct}%"></div>` : ''}
        </div>
      </div>
      <span class="trend-label">${esc(dayLabel)}</span>
      <span class="trend-value">${n(total)}</span>
    </div>`;
  }).join('')}</div>
  <div class="trend-legend"><span class="trend-legend-item"><span class="trend-dot trend-dot-total"></span>总计</span><span class="trend-legend-item"><span class="trend-dot trend-dot-neg"></span>负面</span></div>`;
}

function renderPlatformCoverage(rows) {
  if (!rows.length) return emptyState('🌐', '暂无平台数据', '开始采集后将显示平台覆盖');
  const platformIcons = { weibo: '🔴', xiaohongshu: '📕', douyin: '🎵' };
  return `<div class="platform-list">${rows.map(r => `<div class="platform-row">
    <span class="platform-icon">${platformIcons[r.platform] || '🌐'}</span>
    <div class="platform-info">
      <strong>${esc(platformName(r.platform))}</strong>
      <span class="subtext">${n(r.count)} 条 · 新增 ${n(r.period_new)}</span>
    </div>
    <span class="subtext">${date(r.last_seen_at)}</span>
  </div>`).join('')}</div>`;
}

function renderReportMini(rows) {
  if (!rows.length) return emptyState('📄', '暂无报告', '可在报告中心生成日报/周报');
  return `<div class="mini-list">${rows.map(r => `<div class="mini-item"><div class="mini-item-row"><strong>${esc(LABELS.reportType[r.report_type] || r.report_type)}</strong>${badge(LABELS.reportStatus[r.status] || r.status, r.status)}</div><span class="subtext">${esc(dateRange(r.period_start, r.period_end))}</span></div>`).join('')}</div>`;
}

function renderMonitorMini(rows) {
  if (!rows.length) return emptyState('🛰️', '暂无监控任务', '可在监控任务页创建关键词监控');
  return `<div class="mini-list">${rows.map(r => `<div class="mini-item"><div class="mini-item-row"><strong>${esc(r.name || r.keyword)}</strong>${badge(r.status === 'active' ? '运行中' : r.status, r.status)}</div><span class="subtext">${esc(platformName(r.platform))} · 下次 ${date(r.next_run_at)}</span></div>`).join('')}</div>`;
}

function paginationHtml(p, handlerName) {
  if (!p || p.totalPages <= 1) return '';
  const current = Number(p.page);
  const total = Number(p.totalPages);
  return `<div class="toolbar"><div class="subtext">共 ${n(p.total)} 条</div><div class="action-row"><button class="secondary" ${current <= 1 ? 'disabled' : ''} onclick="${escAttr(handlerName)}(${current - 1})">上一页</button><span class="subtext">${current} / ${total}</span><button class="secondary" ${current >= total ? 'disabled' : ''} onclick="${escAttr(handlerName)}(${current + 1})">下一页</button></div></div>`;
}

function kpi(label, value, tone = '', icon = '') {
  return `<div class="kpi ${tone}">
    ${icon ? `<div class="kpi-icon">${icon}</div>` : ''}
    <div class="kpi-content"><strong>${n(value)}</strong><span>${esc(label)}</span></div>
  </div>`;
}

function panel(title, body, extraClass = '') {
  return `<section class="panel ${extraClass}"><div class="panel-head"><h2>${esc(title)}</h2></div><div class="panel-body">${body}</div></section>`;
}

function emptyState(icon, title, desc = '') {
  return `<div class="empty-state"><div class="empty-icon">${icon}</div><div class="empty-title">${esc(title)}</div>${desc ? `<div class="empty-desc">${esc(desc)}</div>` : ''}</div>`;
}

function metric(label, value, raw = false) {
  return `<div class="metric-line"><span>${esc(label)}</span><strong>${raw ? value : esc(value)}</strong></div>`;
}

function infoItem(label, value, raw = false) {
  return `<div class="info-item"><span>${esc(label)}</span><strong>${raw ? value : esc(value)}</strong></div>`;
}

function statTile(label, value) {
  return `<div class="stat-tile"><span>${esc(label)}</span><strong>${n(value)}</strong></div>`;
}

function badge(label, tone = '') {
  return `<span class="badge ${escAttr(tone || 'muted')}">${esc(label || '-')}</span>`;
}

function recordTitle(record) {
  return compact(record.title || record.content || '(无标题)', 72);
}

function recordImageUrls(record) {
  const urls = [
    record.cover_url,
    ...parseArray(record.image_urls).flatMap(item => {
      if (typeof item === 'string') return [item];
      if (item && typeof item === 'object') return [item.url, item.src, item.href, item.coverUrl];
      return [];
    }),
  ];
  return [...new Set(urls.map(safeUrl).filter(Boolean))].slice(0, 12);
}

function imageBox(url, className, alt) {
  const safe = safeUrl(url);
  if (!safe) return `<div class="${escAttr(className)} is-empty"><span>暂无图片</span></div>`;
  return `
    <div class="${escAttr(className)} image-box">
      <img src="${escAttr(safe)}" alt="${escAttr(alt || '内容图片')}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.parentElement.classList.add('is-broken'); this.remove();">
      <span class="image-fallback">图片暂不可用</span>
    </div>
  `;
}

function authorAvatar(record) {
  const avatar = safeUrl(record.author_avatar);
  const initial = authorInitial(record.author_name);
  if (!avatar) return `<div class="record-avatar is-fallback"><span>${esc(initial)}</span></div>`;
  return `
    <div class="record-avatar">
      <img src="${escAttr(avatar)}" alt="${escAttr(record.author_name || '作者头像')}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.parentElement.classList.add('is-fallback'); this.remove();">
      <span>${esc(initial)}</span>
    </div>
  `;
}

function authorInitial(value) {
  const text = String(value || '未').trim();
  return Array.from(text)[0] || '未';
}

function authorMeta(record) {
  const parts = [];
  if (record.author_fans) parts.push(`粉丝 ${n(record.author_fans)}`);
  if (record.publish_time) parts.push(record.publish_time);
  if (record.last_seen_at || record.created_at) parts.push(`采集 ${date(record.last_seen_at || record.created_at)}`);
  return parts.join(' · ') || '暂无作者补充信息';
}

function commentsCaptureLabel(record) {
  const count = Number(record.comments_total_captured || 0);
  if (count > 0) return `${n(count)} 条已采`;
  if (record.comments_capture_status) return record.comments_capture_status;
  return '未采集';
}

function noteTypeLabel(value) {
  return {
    normal: '图文',
    image: '图文',
    video: '视频',
    text: '文字',
    note: '笔记',
  }[value] || value || '';
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [trimmed];
    }
  }
  return [];
}

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (!value || typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function safeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw, window.location.origin);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch (_) {
    return '';
  }
}

function compact(value, limit = 80) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return text.slice(0, Math.max(0, limit - 1)) + '…';
}

function option(value, label) {
  return `<option value="${escAttr(value)}">${esc(label)}</option>`;
}

function content() {
  return document.getElementById('pageContent');
}

function loading() {
  return '<div class="skeleton-grid"><div class="skeleton-row" style="width:60%;height:20px"></div><div class="skeleton-row" style="width:100%;height:48px"></div><div class="skeleton-row" style="width:80%;height:14px"></div><div class="skeleton-row" style="width:45%;height:14px"></div></div>';
}

function emptyRow(cols) {
  return `<tr><td colspan="${cols}"><div class="empty-state">暂无数据</div></td></tr>`;
}

function openDrawer(eyebrow, title, body, options = {}) {
  const drawer = document.getElementById('drawer');
  document.getElementById('drawerEyebrow').textContent = eyebrow;
  document.getElementById('drawerTitle').textContent = title;
  document.getElementById('drawerBody').innerHTML = body;
  drawer.className = `drawer ${options.className || ''}`.trim();
  drawer.hidden = false;
  document.getElementById('drawerScrim').hidden = false;
}

function closeDrawer() {
  document.getElementById('drawer').hidden = true;
  document.getElementById('drawerScrim').hidden = true;
}

function toast(message, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = message;
  document.getElementById('toastHost').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function isInternal() {
  return Boolean(state.user?.isInternal && ['platform_admin', 'internal_operator'].includes(state.user.globalRole));
}

function currentMembership() {
  return (state.user?.memberships || []).find(m => m.tenantId === state.tenantId);
}

function currentTenantRoleLabel() {
  return LABELS.role[currentMembership()?.role || ''] || '成员';
}

function canWrite() {
  if (isInternal()) return true;
  return ['tenant_admin', 'tenant_analyst'].includes(currentMembership()?.role);
}

function tenantRoleText(memberships) {
  return (memberships || []).map(m => `${m.tenantName}: ${LABELS.role[m.role] || m.role}`).join(' / ') || '无租户';
}

function valueOf(id) {
  return document.getElementById(id)?.value || '';
}

function n(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num.toLocaleString('zh-CN') : '0';
}

function date(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('zh-CN', { hour12: false });
}

function dateRange(start, end) {
  return `${dateOnly(start)} - ${dateOnly(end)}`;
}

function dateOnly(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleDateString('zh-CN');
}

function platformName(value) {
  return { weibo: '微博', xiaohongshu: '小红书', douyin: '抖音', unknown: '未知' }[value] || value || '全部平台';
}

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escAttr(value) {
  return esc(value).replace(/`/g, '&#96;');
}
