/**
 * StarVoice 用户数据中心 — 客户端逻辑
 */

let authCode = '';
let recordsPage = 1;
let cachedRecords = [];

const SENTIMENT_LABEL = { positive: '正面', neutral: '中性', negative: '负面' };
const PLATFORM_LABEL = { xiaohongshu: '小红书', douyin: '抖音', weibo: '微博', unknown: '未知' };
const CATEGORY_LABEL = {
  safety_rescue: '安全救援', feature_usage: '功能使用', renewal_billing: '续费收费',
  privacy: '隐私安全', app_issue: 'App问题', service_quality: '服务质量',
  brand_image: '品牌形象', other: '其他',
};
const ACCOUNT_TYPE_LABEL = { enterprise: '企业号', personal: '个人号', professional: '专业号' };

function toggleTheme() {
  var html = document.documentElement;
  var isDark = html.getAttribute('data-theme') === 'dark';
  if (isDark) {
    html.removeAttribute('data-theme');
    localStorage.setItem('osv_theme', 'light');
  } else {
    html.setAttribute('data-theme', 'dark');
    localStorage.setItem('osv_theme', 'dark');
  }
}

// ==================== API ====================

async function api(path, options) {
  options = options || {};
  var headers = {
    'Content-Type': 'application/json',
    'x-auth-code': authCode,
    ...(options.headers || {}),
  };
  var fetchOpts = { ...options, headers: headers };
  if (options.body) fetchOpts.body = JSON.stringify(options.body);
  var resp = await fetch('/api/user' + path, fetchOpts);
  return resp.json();
}

// ==================== Toast ====================

function showToast(msg, type) {
  type = type || 'info';
  var el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(function() { el.remove(); }, 3000);
}

// ==================== Auth ====================

async function doLogin() {
  var code = document.getElementById('loginCode').value.trim();
  if (!code) return;
  authCode = code;

  try {
    var resp = await fetch('/api/user/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-code': code },
      body: JSON.stringify({ code: code }),
    });
    var data = await resp.json();

    if (data.ok) {
      document.getElementById('loginOverlay').style.display = 'none';
      document.getElementById('app').style.display = 'block';
      localStorage.setItem('osv_user_code', code);
      document.getElementById('userInfo').textContent = data.owner || code.slice(0, 8);
      loadStats();
      loadRecords();
    } else {
      document.getElementById('loginError').style.display = 'block';
      document.getElementById('loginError').textContent = data.message || '激活码无效';
    }
  } catch (err) {
    document.getElementById('loginError').style.display = 'block';
    document.getElementById('loginError').textContent = '连接失败: ' + err.message;
  }
}

function doLogout() {
  localStorage.removeItem('osv_user_code');
  authCode = '';
  location.reload();
}

// Enter key
document.getElementById('loginCode').addEventListener('keyup', function(e) {
  if (e.key === 'Enter') doLogin();
});

// Auto-login
(async function autoLogin() {
  var saved = localStorage.getItem('osv_user_code');
  if (!saved) return;
  authCode = saved;
  try {
    var resp = await fetch('/api/user/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-code': saved },
      body: JSON.stringify({ code: saved }),
    });
    var data = await resp.json();
    if (data.ok) {
      document.getElementById('loginOverlay').style.display = 'none';
      document.getElementById('app').style.display = 'block';
      document.getElementById('userInfo').textContent = data.owner || saved.slice(0, 8);
      loadStats();
      loadRecords();
    } else {
      localStorage.removeItem('osv_user_code');
      authCode = '';
    }
  } catch(e) {
    localStorage.removeItem('osv_user_code');
    authCode = '';
  }
})();

// ==================== Stats ====================

async function loadStats() {
  var data = await api('/stats?days=7');
  if (!data.ok) return;
  var s = data.stats;
  document.getElementById('statTotal').textContent = s.totalRecords;
  document.getElementById('statRecent').textContent = s.recentRecords;
  document.getElementById('statPlatforms').textContent = s.platformDist ? s.platformDist.length : 0;
}

// ==================== Records ====================

async function loadRecords(page) {
  recordsPage = page || 1;
  var platform = document.getElementById('filterPlatform').value || '';
  var sentiment = document.getElementById('filterSentiment').value || '';
  var keyword = document.getElementById('filterKeyword').value || '';

  var params = new URLSearchParams({ page: recordsPage, pageSize: 30 });
  if (platform) params.set('platform', platform);
  if (sentiment) params.set('sentiment', sentiment);
  if (keyword) params.set('keyword', keyword);

  var data = await api('/records?' + params);
  if (!data.ok) return;
  cachedRecords = data.records;

  var el = document.getElementById('recordsTable');
  if (data.records.length === 0) {
    el.innerHTML = '<div class="empty-state">暂无采集数据，请先在扩展中采集并同步</div>';
    document.getElementById('recordsPagination').innerHTML = '';
    return;
  }

  var thumbHtml = function(r) {
    var cover = r.cover_url || '';
    if (!cover) {
      try { var imgs = JSON.parse(r.image_urls || '[]'); if (imgs.length) cover = typeof imgs[0] === 'string' ? imgs[0] : (imgs[0].url || ''); } catch(e) {}
    }
    var icon = r.video_url ? '▶' : '📷';
    if (cover && /^https?:\/\//i.test(cover)) {
      return '<div class="cell-thumb"><img src="' + escHtml(cover) + '" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentElement.textContent=\'' + icon + '\'"></div>';
    }
    return '<div class="cell-thumb">' + icon + '</div>';
  };

  el.innerHTML = '<table><thead><tr><th></th><th>内容</th><th>平台</th><th>博主</th><th>粉丝</th><th>互动数据</th><th>情感</th><th>评论</th><th>时间</th></tr></thead><tbody>' +
    data.records.map(function(r, idx) {
      var contentPreview = r.content ? r.content.slice(0, 50) : '';
      if (r.content && r.content.length > 50) contentPreview += '...';
      return '<tr onclick="showRecordDetail(' + idx + ')">' +
        '<td>' + thumbHtml(r) + '</td>' +
        '<td><div class="cell-title"><div class="cell-title-text">' + escHtml(r.title || '(无标题)') + '</div>' + (contentPreview ? '<div class="preview">' + escHtml(contentPreview) + '</div>' : '') + '</div></td>' +
        '<td><span class="badge badge-type">' + escHtml(PLATFORM_LABEL[r.platform] || r.platform) + '</span></td>' +
        '<td class="cell-truncate">' + escHtml(r.author_name || '-') + '</td>' +
        '<td class="cell-nowrap">' + (r.author_fans > 0 ? formatNum(r.author_fans) : '-') + '</td>' +
        '<td class="cell-nowrap">' + formatNum(r.likes || 0) + ' / ' + formatNum(r.comments_count || 0) + ' / ' + formatNum(r.collects || 0) + ' / ' + formatNum(r.shares || 0) + '</td>' +
        '<td>' + (r.sentiment ? '<span class="badge badge-' + escHtml(r.sentiment) + '">' + escHtml(SENTIMENT_LABEL[r.sentiment] || r.sentiment) + '</span>' : '<span class="badge badge-neutral">待标注</span>') + '</td>' +
        '<td>' + escHtml(r.comments_total_captured > 0 ? r.comments_total_captured + '条' : (r.comments_capture_status || '-')) + '</td>' +
        '<td class="cell-nowrap">' + escHtml(r.created_at ? r.created_at.slice(0, 10) : '-') + '</td>' +
        '</tr>';
    }).join('') + '</tbody></table>';

  var p = data.pagination;
  var pagEl = document.getElementById('recordsPagination');
  if (p.totalPages <= 1) { pagEl.innerHTML = ''; return; }
  var html = '<button ' + (p.page <= 1 ? 'disabled' : '') + ' onclick="loadRecords(' + (p.page - 1) + ')">上一页</button>';
  var start = Math.max(1, p.page - 3);
  var end = Math.min(p.totalPages, start + 6);
  for (var i = start; i <= end; i++) {
    html += '<button class="' + (i === p.page ? 'active' : '') + '" onclick="loadRecords(' + i + ')">' + i + '</button>';
  }
  html += '<button ' + (p.page >= p.totalPages ? 'disabled' : '') + ' onclick="loadRecords(' + (p.page + 1) + ')">下一页</button>';
  pagEl.innerHTML = html;
}

// ==================== Helpers ====================

function escHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

function safeHref(url) {
  var value = String(url || '');
  return /^https?:\/\//i.test(value) ? value : '';
}

function linkHtml(url, label) {
  var href = safeHref(url);
  if (!href) return escHtml(label || '-');
  return '<a href="' + escHtml(href) + '" target="_blank" rel="noopener noreferrer">' + escHtml(label || href) + '</a>';
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value || '[]'); } catch(e) { return []; }
}

function formatNum(n) {
  if (n >= 10000) return (n / 10000).toFixed(1) + 'w';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function formatDateTime(ts) {
  if (!ts) return '-';
  if (typeof ts === 'number') return new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
  return String(ts).slice(0, 16).replace('T', ' ');
}

// ==================== Detail Modal ====================

function showRecordDetail(idx) {
  var r = cachedRecords[idx];
  if (!r) return;

  var tags = parseJsonArray(r.tags);
  var imageUrls = parseJsonArray(r.image_urls);

  var html = '<table class="detail-table">';
  var rows = [
    ['采集平台', escHtml(PLATFORM_LABEL[r.platform] || r.platform)],
    ['博主', escHtml(r.author_name || '-')],
    ['博主主页', r.blogger_profile_url ? linkHtml(r.blogger_profile_url, '查看主页') : '-'],
    ['粉丝数', r.author_fans > 0 ? r.author_fans.toLocaleString() : '-'],
    ['点赞与收藏数', r.blogger_liked_collected > 0 ? r.blogger_liked_collected.toLocaleString() : '-'],
    ['账号属性', escHtml(ACCOUNT_TYPE_LABEL[r.blogger_account_type] || r.blogger_account_type || '-')],
    ['标题', escHtml(r.title || '-')],
    ['笔记链接', r.url ? linkHtml(r.url, r.url.slice(0, 60) + (r.url.length > 60 ? '...' : '')) : '-'],
    ['正文', '<div class="detail-content">' + escHtml(r.content || '(无内容)') + '</div>'],
    ['话题标签', tags.length > 0 ? tags.map(function(t) { return '<span class="tag-chip">' + escHtml(typeof t === 'string' ? t : (t.name || t.tagName || '')) + '</span>'; }).join(' ') : '-'],
    ['笔记类型', r.video_url ? '视频' : '图文'],
    ['封面链接', r.cover_url ? linkHtml(r.cover_url, '查看封面') : '-'],
    ['图片链接', imageUrls.length > 0 ? imageUrls.length + ' 张 - ' + linkHtml(imageUrls[0], '查看首张') : '-'],
    ['视频链接', r.video_url ? linkHtml(r.video_url, '查看视频') : '-'],
    ['视频时长', escHtml(r.video_duration || '-')],
    ['点赞 / 收藏 / 评论 / 转发', r.likes + ' / ' + r.collects + ' / ' + r.comments_count + ' / ' + r.shares],
    ['评论内容', r.comments_text ? '<div class="detail-content">' + escHtml(r.comments_text.slice(0, 600)) + (r.comments_text.length > 600 ? '...' : '') + '</div>' : '-'],
    ['评论采集状态', escHtml(r.comments_capture_status || '-')],
    ['评论采集条数', r.comments_total_captured > 0 ? String(r.comments_total_captured) : '-'],
    ['采集时间', formatDateTime(r.capture_timestamp || r.created_at)],
    ['笔记编辑时间', escHtml(r.publish_time || '-')],
    ['搜索关键词', escHtml(r.keyword || '-')],
  ];

  if (r.sentiment) {
    rows.push(['AI 情感分析', '<span class="badge badge-' + r.sentiment + '">' + (SENTIMENT_LABEL[r.sentiment] || r.sentiment) + '</span>']);
  }
  if (r.category) {
    rows.push(['AI 分类', escHtml(CATEGORY_LABEL[r.category] || r.category)]);
  }
  if (r.ai_summary) {
    rows.push(['AI 摘要', escHtml(r.ai_summary)]);
  }

  rows.forEach(function(row) {
    html += '<tr><th>' + row[0] + '</th><td>' + row[1] + '</td></tr>';
  });
  html += '</table>';

  document.getElementById('recordDetailContent').innerHTML = html;
  document.getElementById('recordDetailModal').classList.remove('modal-hidden');
}

function closeModal() {
  document.getElementById('recordDetailModal').classList.add('modal-hidden');
}

// Close on overlay click
document.getElementById('recordDetailModal').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});

// ==================== CSV Export ====================

async function exportRecordsCsv() {
  showToast('正在导出...', 'info');
  var platform = document.getElementById('filterPlatform').value || '';
  var sentiment = document.getElementById('filterSentiment').value || '';
  var keyword = document.getElementById('filterKeyword').value || '';

  var params = new URLSearchParams({ page: 1, pageSize: 10000 });
  if (platform) params.set('platform', platform);
  if (sentiment) params.set('sentiment', sentiment);
  if (keyword) params.set('keyword', keyword);

  var data = await api('/records?' + params);
  if (!data.ok || data.records.length === 0) { showToast('没有数据可导出', 'error'); return; }

  var header = [
    '采集平台', '博主', '博主主页', '封面链接', '标题', '笔记链接', '正文',
    '话题标签', '图片链接', '评论内容', '笔记类型', '采集时间', '笔记最近编辑时间',
    '点赞数', '收藏数', '评论数', '转发数', '粉丝数', '点赞与收藏数', '账号属性',
    '视频链接', '视频时长', '评论采集状态', '评论采集条数'
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
      tags.map(function(t) { return typeof t === 'string' ? t : (t.name || t.tagName || ''); }).join(', '),
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
  a.download = 'onstarvoice-data-' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click();
  URL.revokeObjectURL(url);
  showToast('导出成功 ' + data.records.length + ' 条记录', 'success');
}
