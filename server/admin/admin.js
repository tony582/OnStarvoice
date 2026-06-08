/**
 * OnStarVoice Admin Dashboard Client Logic
 */

let adminToken = '';
let currentPage = 'dashboard';
let recordsPage = 1;

const SENTIMENT_LABEL = { positive: '正面', neutral: '中性', negative: '负面' };
const SENTIMENT_COLOR = { positive: '#10B981', neutral: '#6B7280', negative: '#DC2626' };
const CATEGORY_LABEL = {
  safety_rescue: '安全救援', feature_usage: '功能使用', renewal_billing: '续费收费',
  privacy: '隐私安全', app_issue: 'App问题', service_quality: '服务质量',
  brand_image: '品牌形象', other: '其他',
};
const LEVEL_LABEL = { critical: '重度', warning: '中度', info: '轻度' };
const TYPE_LABEL = { trial: '试用', annual: '年度', permanent: '永久' };
const STATUS_LABEL = { active: '有效', expired: '已过期', frozen: '已冻结' };

// ==================== API 调用 ====================

async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'x-admin-token': adminToken,
    ...options.headers,
  };
  const fetchOpts = { ...options, headers };
  if (options.body) fetchOpts.body = JSON.stringify(options.body);
  const resp = await fetch('/api' + path, fetchOpts);
  return resp.json();
}

// ==================== Toast ====================

function showToast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ==================== Login ====================

async function doLogin() {
  const pw = document.getElementById('loginPassword').value.trim();
  if (!pw) return;
  adminToken = pw;

  try {
    const resp = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': pw },
      body: '{}',
    });
    const data = await resp.json();

    if (data.ok) {
      document.getElementById('loginOverlay').style.display = 'none';
      document.getElementById('app').style.display = 'flex';
      localStorage.setItem('osv_admin_token', pw);
      loadPage('dashboard');
    } else {
      document.getElementById('loginError').style.display = 'block';
      document.getElementById('loginError').textContent = data.message || '密码错误';
    }
  } catch (err) {
    document.getElementById('loginError').style.display = 'block';
    document.getElementById('loginError').textContent = '连接服务器失败: ' + err.message;
  }
}

// Enter key login
document.getElementById('loginPassword').addEventListener('keyup', function(e) {
  if (e.key === 'Enter') doLogin();
});

// Auto-login from saved token
(async function autoLogin() {
  const saved = localStorage.getItem('osv_admin_token');
  if (!saved) return;
  adminToken = saved;
  try {
    const resp = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': saved },
      body: '{}',
    });
    const data = await resp.json();
    if (data.ok) {
      document.getElementById('loginOverlay').style.display = 'none';
      document.getElementById('app').style.display = 'flex';
      loadPage('dashboard');
    } else {
      // 清除无效的 token
      localStorage.removeItem('osv_admin_token');
      adminToken = '';
    }
  } catch (e) {
    localStorage.removeItem('osv_admin_token');
    adminToken = '';
  }
})();

// ==================== Navigation ====================

document.querySelectorAll('.sidebar-nav li').forEach(function(li) {
  li.addEventListener('click', function() {
    loadPage(li.dataset.page);
  });
});

function loadPage(page) {
  currentPage = page;
  document.querySelectorAll('.sidebar-nav li').forEach(function(li) {
    li.classList.toggle('active', li.dataset.page === page);
  });
  document.querySelectorAll('.page').forEach(function(p) { p.style.display = 'none'; });

  var pageId = {
    'dashboard': 'pageDashboard',
    'auth-codes': 'pageAuthCodes',
    'records': 'pageRecords',
    'alerts': 'pageAlerts',
    'settings': 'pageSettings',
  }[page];

  if (pageId) document.getElementById(pageId).style.display = 'block';

  if (page === 'dashboard') loadDashboard();
  else if (page === 'auth-codes') loadAuthCodes();
  else if (page === 'records') loadRecords();
  else if (page === 'alerts') loadAlerts();
  else if (page === 'settings') loadSettings();
}

// ==================== Dashboard ====================

async function loadDashboard() {
  var days = document.getElementById('dashboardDays').value || 7;
  var data = await api('/admin/stats?days=' + days);
  if (!data.ok) return;
  var s = data.stats;

  document.getElementById('statTotal').textContent = s.totalRecords;
  document.getElementById('statRecent').textContent = s.recentRecords;
  var alertTotal = s.recentAlerts.reduce(function(sum, a) { return sum + a.count; }, 0);
  document.getElementById('statAlerts').textContent = alertTotal;
  document.getElementById('statCodes').textContent = s.activeCodes;

  var sentimentEl = document.getElementById('sentimentChart');
  var totalSentiment = s.sentimentDist.reduce(function(sum, d) { return sum + d.count; }, 0);
  if (totalSentiment > 0) {
    sentimentEl.innerHTML = s.sentimentDist.map(function(d) {
      var pct = (d.count / totalSentiment * 100).toFixed(1);
      return '<div class="chart-bar"><div class="chart-bar-label">' + (SENTIMENT_LABEL[d.sentiment] || d.sentiment) + '</div><div class="chart-bar-track"><div class="chart-bar-fill" style="width:' + pct + '%;background:' + (SENTIMENT_COLOR[d.sentiment] || '#6B7280') + '">' + pct + '%</div></div><div class="chart-bar-count">' + d.count + '</div></div>';
    }).join('');
  } else {
    sentimentEl.innerHTML = '<div class="empty-state">暂无数据</div>';
  }

  var categoryEl = document.getElementById('categoryChart');
  var totalCat = s.categoryDist.reduce(function(sum, d) { return sum + d.count; }, 0);
  if (totalCat > 0) {
    categoryEl.innerHTML = s.categoryDist.slice(0, 8).map(function(d) {
      var pct = (d.count / totalCat * 100).toFixed(1);
      return '<div class="chart-bar"><div class="chart-bar-label">' + (CATEGORY_LABEL[d.category] || d.category) + '</div><div class="chart-bar-track"><div class="chart-bar-fill" style="width:' + pct + '%;background:var(--primary)">' + pct + '%</div></div><div class="chart-bar-count">' + d.count + '</div></div>';
    }).join('');
  } else {
    categoryEl.innerHTML = '<div class="empty-state">暂无数据</div>';
  }

  var topEl = document.getElementById('topInteractionTable');
  if (s.topInteraction.length > 0) {
    topEl.innerHTML = '<table><thead><tr><th>标题</th><th>平台</th><th>情感</th><th>点赞</th><th>评论</th><th>收藏</th><th>作者</th></tr></thead><tbody>' +
      s.topInteraction.map(function(r) {
        return '<tr><td><a href="' + r.url + '" target="_blank" class="truncate-lg" style="display:block">' + (r.title || '(无标题)') + '</a></td><td>' + r.platform + '</td><td>' + (r.sentiment ? '<span class="badge badge-' + r.sentiment + '">' + (SENTIMENT_LABEL[r.sentiment] || r.sentiment) + '</span>' : '-') + '</td><td>' + r.likes + '</td><td>' + r.comments_count + '</td><td>' + r.collects + '</td><td class="truncate">' + (r.author_name || '-') + '</td></tr>';
      }).join('') + '</tbody></table>';
  } else {
    topEl.innerHTML = '<div class="empty-state">暂无数据</div>';
  }
}

// ==================== Auth Codes ====================

async function loadAuthCodes() {
  var data = await api('/admin/auth-codes');
  if (!data.ok) return;
  var el = document.getElementById('authCodesTable');

  if (data.codes.length === 0) {
    el.innerHTML = '<div class="empty-state">暂无激活码，点击右上角创建</div>';
    return;
  }

  el.innerHTML = '<table><thead><tr><th>激活码</th><th>类型</th><th>状态</th><th>客户</th><th>绑定</th><th>过期时间</th><th>操作</th></tr></thead><tbody>' +
    data.codes.map(function(c) {
      var expires = c.expires_at ? new Date(c.expires_at).toLocaleDateString('zh-CN') : '-';
      var isExpired = c.expires_at && new Date(c.expires_at) < new Date();
      return '<tr><td><span class="code-display" title="点击复制" onclick="navigator.clipboard.writeText(\'' + c.code + '\');showToast(\'已复制\')">' + c.code + '</span></td><td><span class="badge badge-' + c.type + '">' + (TYPE_LABEL[c.type] || c.type) + '</span></td><td><span class="badge badge-' + (isExpired ? 'expired' : c.status) + '">' + (isExpired ? '已过期' : (STATUS_LABEL[c.status] || c.status)) + '</span></td><td class="truncate">' + (c.owner_name || c.owner_email || '-') + '</td><td>' + c.binding_count + '/' + c.max_bindings + '</td><td>' + expires + '</td><td><button class="btn btn-sm btn-success" onclick="renewCode(' + c.id + ')">续期</button> ' + (c.status === 'active' ? '<button class="btn btn-sm btn-danger" onclick="freezeCode(' + c.id + ')">冻结</button>' : '') + (c.status === 'frozen' ? '<button class="btn btn-sm btn-secondary" onclick="unfreezeCode(' + c.id + ')">解冻</button>' : '') + '</td></tr>';
    }).join('') + '</tbody></table>';
}

function showCreateCodeModal() {
  document.getElementById('createCodeModal').classList.remove('modal-hidden');
}

function closeModal(id) {
  document.getElementById(id).classList.add('modal-hidden');
}

function updateDurationHint() {
  var type = document.getElementById('newCodeType').value;
  var daysInput = document.getElementById('newCodeDays');
  if (type === 'trial') daysInput.placeholder = '默认 7 天';
  else if (type === 'annual') daysInput.placeholder = '默认 365 天';
  else daysInput.placeholder = '永久';
}

async function createAuthCode() {
  var type = document.getElementById('newCodeType').value;
  var durationDays = Number(document.getElementById('newCodeDays').value) || undefined;
  var ownerEmail = document.getElementById('newCodeEmail').value;
  var ownerName = document.getElementById('newCodeName').value;
  var maxBindings = Number(document.getElementById('newCodeBindings').value) || 3;
  var notes = document.getElementById('newCodeNotes').value;

  var data = await api('/admin/auth-codes', {
    method: 'POST',
    body: { type: type, durationDays: durationDays, ownerEmail: ownerEmail, ownerName: ownerName, maxBindings: maxBindings, notes: notes },
  });

  if (data.ok) {
    showToast('激活码已创建: ' + data.code, 'success');
    closeModal('createCodeModal');
    loadAuthCodes();
  } else {
    showToast(data.message || '创建失败', 'error');
  }
}

async function renewCode(id) {
  var days = prompt('续期天数:', '365');
  if (!days) return;
  var data = await api('/admin/auth-codes/' + id + '/renew', { method: 'POST', body: { durationDays: Number(days) } });
  if (data.ok) { showToast('续期成功', 'success'); loadAuthCodes(); }
  else showToast(data.message || '续期失败', 'error');
}

async function freezeCode(id) {
  if (!confirm('确定冻结此激活码？')) return;
  var data = await api('/admin/auth-codes/' + id, { method: 'PATCH', body: { status: 'frozen' } });
  if (data.ok) { showToast('已冻结', 'success'); loadAuthCodes(); }
}

async function unfreezeCode(id) {
  var data = await api('/admin/auth-codes/' + id, { method: 'PATCH', body: { status: 'active' } });
  if (data.ok) { showToast('已解冻', 'success'); loadAuthCodes(); }
}

// ==================== Records ====================

var cachedRecords = [];

const PLATFORM_LABEL = { xiaohongshu: '小红书', douyin: '抖音', weibo: '微博', unknown: '未知' };
const NOTE_TYPE_LABEL = { video: '视频', normal: '图文' };
const ACCOUNT_TYPE_LABEL = { enterprise: '企业号', personal: '个人号', professional: '专业号', '': '' };

async function loadRecords(page) {
  recordsPage = page || 1;
  var platform = document.getElementById('filterPlatform').value || '';
  var sentiment = document.getElementById('filterSentiment').value || '';
  var category = document.getElementById('filterCategory').value || '';
  var keyword = document.getElementById('filterKeyword').value || '';

  var params = new URLSearchParams({ page: recordsPage, pageSize: 30 });
  if (platform) params.set('platform', platform);
  if (sentiment) params.set('sentiment', sentiment);
  if (category) params.set('category', category);
  if (keyword) params.set('keyword', keyword);

  var data = await api('/admin/records?' + params);
  if (!data.ok) return;
  cachedRecords = data.records;

  var el = document.getElementById('recordsTable');
  if (data.records.length === 0) {
    el.innerHTML = '<div class="empty-state">暂无数据</div>';
    document.getElementById('recordsPagination').innerHTML = '';
    return;
  }

  el.innerHTML = '<table><thead><tr><th>标题</th><th>平台</th><th>博主</th><th>粉丝</th><th>情感</th><th>分类</th><th>互动</th><th>评论采集</th><th>时间</th></tr></thead><tbody>' +
    data.records.map(function(r, idx) {
      var contentPreview = r.content ? r.content.slice(0, 40) + (r.content.length > 40 ? '...' : '') : '';
      var noteTypeTag = r.video_url ? '<span style="color:var(--primary);font-size:11px">视频</span>' : '<span style="color:var(--text-muted);font-size:11px">图文</span>';
      return '<tr onclick="showRecordDetail(' + idx + ')" style="cursor:pointer" title="点击查看详情"><td>' + noteTypeTag + ' <span class="truncate-lg" style="display:inline">' + (r.title || '(无标题)') + '</span>' + (contentPreview ? '<div style="font-size:11px;color:var(--text-muted);margin-top:2px" class="truncate-lg">' + escHtml(contentPreview) + '</div>' : '') + '</td><td>' + (PLATFORM_LABEL[r.platform] || r.platform) + '</td><td class="truncate">' + (r.author_name || '-') + '</td><td>' + (r.author_fans > 0 ? formatNum(r.author_fans) : '-') + '</td><td>' + (r.sentiment ? '<span class="badge badge-' + r.sentiment + '">' + (SENTIMENT_LABEL[r.sentiment] || r.sentiment) + '</span>' : '-') + '</td><td>' + (CATEGORY_LABEL[r.category] || r.category || '-') + '</td><td style="white-space:nowrap">' + r.likes + ' / ' + r.comments_count + ' / ' + r.collects + '</td><td>' + (r.comments_total_captured > 0 ? r.comments_total_captured + '条' : (r.comments_capture_status || '-')) + '</td><td style="white-space:nowrap">' + (r.created_at ? r.created_at.slice(0, 10) : '-') + '</td></tr>';
    }).join('') + '</tbody></table>';

  var p = data.pagination;
  var pagEl = document.getElementById('recordsPagination');
  if (p.totalPages <= 1) { pagEl.innerHTML = ''; return; }
  var html = '<button ' + (p.page <= 1 ? 'disabled' : '') + ' onclick="loadRecords(' + (p.page - 1) + ')">‹</button>';
  for (var i = 1; i <= Math.min(p.totalPages, 10); i++) {
    html += '<button class="' + (i === p.page ? 'active' : '') + '" onclick="loadRecords(' + i + ')">' + i + '</button>';
  }
  if (p.totalPages > 10) html += '<span>... ' + p.totalPages + '</span>';
  html += '<button ' + (p.page >= p.totalPages ? 'disabled' : '') + ' onclick="loadRecords(' + (p.page + 1) + ')">›</button>';
  pagEl.innerHTML = html;
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatNum(n) {
  if (n >= 10000) return (n / 10000).toFixed(1) + 'w';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function formatDateTime(ts) {
  if (!ts) return '-';
  if (typeof ts === 'number') {
    var d = new Date(ts);
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
  return String(ts).slice(0, 16).replace('T', ' ');
}

function showRecordDetail(idx) {
  var r = cachedRecords[idx];
  if (!r) return;

  var tags = [];
  try { tags = JSON.parse(r.tags || '[]'); } catch(e) {}
  var imageUrls = [];
  try { imageUrls = JSON.parse(r.image_urls || '[]'); } catch(e) {}

  var html = '<table class="detail-table">';
  var rows = [
    ['采集平台', PLATFORM_LABEL[r.platform] || r.platform],
    ['博主', r.author_name || '-'],
    ['博主主页', r.blogger_profile_url ? '<a href="' + r.blogger_profile_url + '" target="_blank">查看</a>' : '-'],
    ['粉丝数', r.author_fans > 0 ? r.author_fans.toLocaleString() : '-'],
    ['点赞与收藏数', r.blogger_liked_collected > 0 ? r.blogger_liked_collected.toLocaleString() : '-'],
    ['账号属性', ACCOUNT_TYPE_LABEL[r.blogger_account_type] || r.blogger_account_type || '-'],
    ['标题', escHtml(r.title || '-')],
    ['笔记链接', r.url ? '<a href="' + r.url + '" target="_blank">' + r.url.slice(0, 60) + '...</a>' : '-'],
    ['正文', '<div class="detail-content">' + escHtml(r.content || '-') + '</div>'],
    ['话题标签', tags.length > 0 ? tags.map(function(t){ return '<span class="tag-chip">' + escHtml(typeof t === 'string' ? t : (t.name || t.tagName || JSON.stringify(t))) + '</span>'; }).join(' ') : '-'],
    ['笔记类型', r.video_url ? '视频' : '图文'],
    ['封面链接', r.cover_url ? '<a href="' + r.cover_url + '" target="_blank">查看</a>' : '-'],
    ['图片链接', imageUrls.length > 0 ? imageUrls.length + ' 张 <a href="' + imageUrls[0] + '" target="_blank">查看首张</a>' : '-'],
    ['视频链接', r.video_url ? '<a href="' + r.video_url + '" target="_blank">查看</a>' : '-'],
    ['视频时长', r.video_duration || '-'],
    ['互动数据', r.likes + ' 赞 / ' + r.collects + ' 藏 / ' + r.comments_count + ' 评 / ' + r.shares + ' 转'],
    ['评论内容', r.comments_text ? '<div class="detail-content">' + escHtml(r.comments_text.slice(0, 500)) + (r.comments_text.length > 500 ? '...' : '') + '</div>' : '-'],
    ['评论采集状态', r.comments_capture_status || '-'],
    ['评论采集条数', r.comments_total_captured > 0 ? r.comments_total_captured : '-'],
    ['采集时间', formatDateTime(r.capture_timestamp || r.created_at)],
    ['笔记编辑时间', r.publish_time || '-'],
    ['关键词', r.keyword || '-'],
    ['AI 情感', r.sentiment ? (SENTIMENT_LABEL[r.sentiment] || r.sentiment) : '未分析'],
    ['AI 分类', r.category ? (CATEGORY_LABEL[r.category] || r.category) : '未分析'],
    ['AI 摘要', r.ai_summary || '未分析'],
  ];

  rows.forEach(function(row) {
    html += '<tr><th>' + row[0] + '</th><td>' + row[1] + '</td></tr>';
  });
  html += '</table>';

  document.getElementById('recordDetailContent').innerHTML = html;
  document.getElementById('recordDetailModal').classList.remove('modal-hidden');
}

async function exportRecordsCsv() {
  showToast('正在导出...', 'info');
  var platform = document.getElementById('filterPlatform').value || '';
  var sentiment = document.getElementById('filterSentiment').value || '';
  var category = document.getElementById('filterCategory').value || '';
  var keyword = document.getElementById('filterKeyword').value || '';

  var params = new URLSearchParams({ page: 1, pageSize: 10000 });
  if (platform) params.set('platform', platform);
  if (sentiment) params.set('sentiment', sentiment);
  if (category) params.set('category', category);
  if (keyword) params.set('keyword', keyword);

  var data = await api('/admin/records?' + params);
  if (!data.ok || data.records.length === 0) { showToast('没有数据可导出', 'error'); return; }

  var header = [
    '采集平台', '博主', '博主主页', '封面链接', '标题', '笔记链接', '正文',
    '话题标签', '图片链接', '评论内容', '笔记类型', '采集时间', '笔记最近编辑时间',
    '点赞数', '收藏数', '评论数', '转发数', '粉丝数', '点赞与收藏数', '账号属性',
    '视频链接', '视频时长', '评论采集状态', '评论采集条数', '关键词',
    'AI情感', 'AI意图', 'AI分类', 'AI摘要'
  ];

  var rows = data.records.map(function(r) {
    var tags = []; try { tags = JSON.parse(r.tags || '[]'); } catch(e) {}
    var imageUrls = []; try { imageUrls = JSON.parse(r.image_urls || '[]'); } catch(e) {}
    return [
      PLATFORM_LABEL[r.platform] || r.platform,
      r.author_name || '',
      r.blogger_profile_url || '',
      r.cover_url || '',
      r.title || '',
      r.url || '',
      r.content || '',
      tags.map(function(t){ return typeof t === 'string' ? t : (t.name || t.tagName || ''); }).join(', '),
      imageUrls.join('\n'),
      r.comments_text || '',
      r.video_url ? '视频' : '图文',
      formatDateTime(r.capture_timestamp || r.created_at),
      r.publish_time || '',
      r.likes, r.collects, r.comments_count, r.shares,
      r.author_fans, r.blogger_liked_collected,
      ACCOUNT_TYPE_LABEL[r.blogger_account_type] || r.blogger_account_type || '',
      r.video_url || '', r.video_duration || '',
      r.comments_capture_status || '', r.comments_total_captured || '',
      r.keyword || '',
      SENTIMENT_LABEL[r.sentiment] || r.sentiment || '',
      r.intent || '',
      CATEGORY_LABEL[r.category] || r.category || '',
      r.ai_summary || ''
    ];
  });

  var csvContent = [header].concat(rows).map(function(row) {
    return row.map(function(cell) {
      var s = String(cell == null ? '' : cell).replace(/"/g, '""');
      return '"' + s + '"';
    }).join(',');
  }).join('\n');

  var blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'onstarvoice-export-' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click();
  URL.revokeObjectURL(url);
  showToast('导出成功：' + data.records.length + ' 条', 'success');
}

// ==================== Alerts ====================

async function loadAlerts() {
  var level = document.getElementById('filterAlertLevel').value || '';
  var params = level ? '?level=' + level : '';
  var data = await api('/admin/alerts' + params);
  if (!data.ok) return;

  var el = document.getElementById('alertsTable');
  if (data.alerts.length === 0) {
    el.innerHTML = '<div class="empty-state">暂无预警</div>';
    return;
  }

  el.innerHTML = '<table><thead><tr><th>级别</th><th>原因</th><th>标题</th><th>平台</th><th>互动量</th><th>时间</th><th>链接</th></tr></thead><tbody>' +
    data.alerts.map(function(a) {
      return '<tr><td><span class="badge badge-' + a.level + '">' + (LEVEL_LABEL[a.level] || a.level) + '</span></td><td class="truncate-lg">' + a.reason + '</td><td class="truncate">' + (a.title || a.record_title || '-') + '</td><td>' + (a.platform || '-') + '</td><td>' + (a.interaction_total || '-') + '</td><td style="white-space:nowrap">' + (a.created_at ? a.created_at.slice(0, 16).replace('T', ' ') : '-') + '</td><td>' + ((a.url || a.record_url) ? '<a href="' + (a.url || a.record_url) + '" target="_blank">查看</a>' : '-') + '</td></tr>';
    }).join('') + '</tbody></table>';
}

// ==================== Settings ====================

async function loadSettings() {
  var data = await api('/admin/settings');
  if (!data.ok) return;
  var s = data.raw;

  document.getElementById('settingLlmProvider').value = s.llm_provider || 'gemini';
  document.getElementById('settingLlmApiKey').value = s.llm_api_key || '';
  document.getElementById('settingLlmModel').value = s.llm_model || '';
  document.getElementById('settingLlmEndpoint').value = s.llm_api_endpoint || '';
  document.getElementById('settingSmtpHost').value = s.smtp_host || '';
  document.getElementById('settingSmtpPort').value = s.smtp_port || '465';
  document.getElementById('settingSmtpSecure').value = s.smtp_secure || 'true';
  document.getElementById('settingSmtpUser').value = s.smtp_user || '';
  document.getElementById('settingSmtpPass').value = s.smtp_pass || '';
  document.getElementById('settingEmailFrom').value = s.email_from || '';
  document.getElementById('settingEmailTo').value = s.email_to || '';
  document.getElementById('settingAlertThreshold').value = s.alert_high_interaction_threshold || '500';
  document.getElementById('settingAlertBurstCount').value = s.alert_negative_burst_count || '5';
  document.getElementById('settingAlertBurstWindow').value = s.alert_negative_burst_window_minutes || '60';
  document.getElementById('settingAlertKeywords').value = s.alert_high_danger_keywords || '';
  document.getElementById('settingReportDaily').value = s.report_daily_enabled || 'true';
  document.getElementById('settingReportWeekly').value = s.report_weekly_enabled || 'true';
}

async function saveSettings(group) {
  var body = {};
  if (group === 'llm') {
    body = { llm_provider: document.getElementById('settingLlmProvider').value, llm_api_key: document.getElementById('settingLlmApiKey').value, llm_model: document.getElementById('settingLlmModel').value, llm_api_endpoint: document.getElementById('settingLlmEndpoint').value };
  } else if (group === 'email') {
    body = { smtp_host: document.getElementById('settingSmtpHost').value, smtp_port: document.getElementById('settingSmtpPort').value, smtp_secure: document.getElementById('settingSmtpSecure').value, smtp_user: document.getElementById('settingSmtpUser').value, smtp_pass: document.getElementById('settingSmtpPass').value, email_from: document.getElementById('settingEmailFrom').value, email_to: document.getElementById('settingEmailTo').value };
  } else if (group === 'alert') {
    body = { alert_high_interaction_threshold: document.getElementById('settingAlertThreshold').value, alert_negative_burst_count: document.getElementById('settingAlertBurstCount').value, alert_negative_burst_window_minutes: document.getElementById('settingAlertBurstWindow').value, alert_high_danger_keywords: document.getElementById('settingAlertKeywords').value };
  } else if (group === 'report') {
    body = { report_daily_enabled: document.getElementById('settingReportDaily').value, report_weekly_enabled: document.getElementById('settingReportWeekly').value };
  }
  var data = await api('/admin/settings', { method: 'PUT', body: body });
  if (data.ok) showToast('配置已保存', 'success');
  else showToast('保存失败', 'error');
}

async function testEmail() {
  showToast('发送中...', 'info');
  var data = await api('/admin/test-email', { method: 'POST', body: {} });
  if (data.ok) showToast(data.message || '发送成功', 'success');
  else showToast(data.message || '发送失败', 'error');
}

async function runLabeling() {
  showToast('正在执行 AI 标签...', 'info');
  var data = await api('/admin/run-labeling', { method: 'POST', body: { limit: 20 } });
  if (data.ok) showToast('标签完成: ' + data.labeled + '/' + data.total, 'success');
  else showToast(data.message || '标签失败', 'error');
}

async function generateReport(type) {
  showToast('正在生成' + (type === 'weekly' ? '周报' : '日报') + '...', 'info');
  var data = await api('/admin/generate-report', { method: 'POST', body: { type: type } });
  if (data.ok) showToast(data.message || '已发送', 'success');
  else showToast(data.message || '生成失败', 'error');
}
