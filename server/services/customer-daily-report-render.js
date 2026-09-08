import ExcelJS from 'exceljs';

const PLATFORMS = {xiaohongshu: '小红书', douyin: '抖音', weibo: '微博', unknown: '未知平台'};
const QUALITY = {
  measured: '可靠实测', measured_ingestion_time: '指标已核实，实测时间未核实',
  legacy_unverified: '历史入库记录，实测时间及可靠性未核实',
};
const HEADERS = ['日期', '监控数量', 'SDB范畴', '正向', '中性', '冷处理', '处理中', '已处理'];

function esc(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char])); }
function url(value) {
  try { const parsed = new URL(String(value || '')); return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : ''; }
  catch { return ''; }
}
function text(value) { return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''); }
function oneLine(value) { return text(value).replace(/\s+/g, ' ').trim(); }
function n(value) { return Number(value) || 0; }
export function customerDailyTime(value) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '时间未确认';
  return new Date(new Date(value).getTime() + 8 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');
}
export function customerDailyReportTitle(snapshot) {
  const time = snapshot.mode === 'realtime' ? ` · 实时截至${customerDailyTime(snapshot.cutoffAt).slice(-5)}` : '';
  return `${snapshot.tenantName ? `${oneLine(snapshot.tenantName)} · ` : ''}舆情日报 ${snapshot.reportDate}${time}${snapshot.version ? ` · v${snapshot.version}` : ''}`;
}
export function customerDailyReportNotes(snapshot) {
  return [
    `新增/互动统计截至${customerDailyTime(snapshot.cutoffAt)}；复核及冷处理状态截至${customerDailyTime(snapshot.assessedAt)}（北京时间）。`,
    `监控按首次成功入库的唯一主帖计数；复采不重复计数。SDB仅扣除「已复核-非监控内容」。MTD为本月1日至报表日的首次入库集合。`,
    `负面共${n(snapshot.summary?.day?.negative)}条，其中冷处理${n(snapshot.summary?.day?.cold)}条；MTD负面共${n(snapshot.summary?.mtd?.negative)}条，其中冷处理${n(snapshot.summary?.mtd?.cold)}条。`,
    '处理中、已处理由客户飞书表维护，系统生成时留空，空白不代表0。客户可在交付的飞书文档或Excel中填写并保存。',
    '本页及Excel是系统生成版本；客户后续编辑不反向同步系统，客户当前稿以其飞书工作文档或自行保存的文件为准。',
  ];
}
function summaryValues(label, counts = {}) {
  // These two cells must stay empty even if a later client accidentally sends values.
  return [label, n(counts.monitor), n(counts.sdb), n(counts.positive), n(counts.neutral), n(counts.cold), null, null];
}
function summaryRows(snapshot) {
  const [, month, day] = String(snapshot.reportDate || '').split('-');
  return [summaryValues(`${Number(month)}月${Number(day)}日`, snapshot.summary?.day), summaryValues('MTD', snapshot.summary?.mtd)];
}
function sourceLabel(post) {
  const unavailable = post.status === 'unavailable' ? ' · 已不可见' : '';
  return `${PLATFORMS[post.platform] || post.platform || '未知平台'}${unavailable}`;
}
function qualityLabel(post) { return QUALITY[post.quality] || '观测质量未确认'; }
function heatDescription(post) {
  return `${post.stale ? '最近热度' : '热度'}${n(post.heat)}${post.comparisonText ? `｜${post.comparisonText.startsWith('暂无') ? '' : '较昨日'}${post.comparisonText}` : ''}｜${post.timeSource === 'capture_timestamp' ? '实测' : '入库'}时间 ${customerDailyTime(post.observedAt)}｜${qualityLabel(post)}${post.previousObservedAt ? `｜昨日实测 ${customerDailyTime(post.previousObservedAt)}` : ''}`;
}
function coldEmpty(snapshot) {
  return snapshot.evidence?.cold?.coverageComplete ? '当日无新增冷处理负面帖子。' : '暂未检出，历史标记记录不完整。';
}
function heatNote(snapshot) {
  const heat = snapshot.evidence?.heat || {};
  return `发布时间窗口：${customerDailyTime(snapshot.heatStart)}至${customerDailyTime(snapshot.cutoffAt)}（不含上界）。热度=点赞+评论+收藏+分享；按最近可用完整观测排序，全部列出≥200的帖子。上榜本日可靠实测${n(heat.updatedCount)}篇，历史/时间未核实${n(heat.unverifiedCount)}篇，本日未更新${n(heat.staleCount)}篇。`;
}

export function renderCustomerDailyReportText(snapshot) {
  const notes = customerDailyReportNotes(snapshot);
  const lines = [customerDailyReportTitle(snapshot), notes[0], '', '一、监控汇总',
    ['日期', '监控数量', 'SDB范畴', '正向', '中性', '负面·冷处理', '负面·处理中', '负面·已处理'].join('\t'),
    ...summaryRows(snapshot).map(row => row.map(value => value ?? '').join('\t')),
    ...notes.slice(1), '', '二、近7天发布、热度≥200的负面帖子', heatNote(snapshot),
  ];
  if (!snapshot.highHeat?.length) lines.push('暂未检出符合条件的帖子；缺测情况见数据说明。');
  for (const [index, post] of (snapshot.highHeat || []).entries()) {
    lines.push(`TOP${index + 1}：${oneLine(post.title)} — ${sourceLabel(post)}｜${heatDescription(post)}`, url(post.url) || '原帖链接待补');
  }
  lines.push('', '三、当天新增冷处理负面帖链接', `标记动作日期：${snapshot.reportDate}；仅列本版复核截止时仍为负面、仍处于冷处理的帖子。`);
  if (!snapshot.coldMarked?.length) lines.push(coldEmpty(snapshot));
  for (const [index, post] of (snapshot.coldMarked || []).entries()) {
    lines.push(`${index + 1}、${oneLine(post.title)} — ${sourceLabel(post)}｜标记时间 ${customerDailyTime(post.markedAt)}`, url(post.url) || '原帖链接待补');
  }
  if (snapshot.warnings?.length) lines.push('', '数据说明', ...snapshot.warnings.map(w => `· ${oneLine(w.message)}`));
  return lines.join('\n');
}

function linkedTitle(post) {
  const href = url(post.url);
  return href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(post.title)}</a><div class="source-url">${esc(href)}</div>` : `${esc(post.title)}<div class="missing">原帖链接待补</div>`;
}
export function renderCustomerDailyReportHtml(snapshot) {
  const notes = customerDailyReportNotes(snapshot);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(customerDailyReportTitle(snapshot))}</title><style>
    :root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#fff;color:#20252b;font:14px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}main{max-width:1000px;padding:32px 28px 48px;margin:auto}h1{font-size:24px;line-height:1.4;margin:0 0 12px}h2{font-size:18px;margin:32px 0 12px}p{margin:8px 0}a{color:#2563eb;text-decoration:underline;text-underline-offset:3px}.meta,.notes{font-size:12px;color:#66717e}.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:640px}th,td{border:1px solid #bcc3cb;padding:10px 9px;text-align:center}th{background:#101316;color:white;font-weight:600}td{font-variant-numeric:tabular-nums}th:first-child,td:first-child{text-align:left}article{padding:14px 0;border-bottom:1px solid #e4e7eb}article h3{font-size:15px;margin:0 0 5px;font-weight:600}.source-url{font-weight:400;font-size:11px;color:#687684;overflow-wrap:anywhere}.missing{color:#9a4c12;font-size:12px}.data-notes{margin-top:28px;padding:14px 18px;background:#f5f7fa;border-left:3px solid #95a5b9}.data-notes ul{padding-left:20px;margin:6px 0}.empty{color:#687684}.foot{margin-top:24px;border-top:1px solid #e4e7eb;padding-top:12px}@media(max-width:600px){main{padding:20px 14px}h1{font-size:21px}}@media print{main{max-width:none;padding:0}body{font-size:11px}th{print-color-adjust:exact;-webkit-print-color-adjust:exact}article{break-inside:avoid}a{color:inherit}h2{break-after:avoid}.table-wrap{overflow:visible}}
  </style></head><body><main><h1>${esc(customerDailyReportTitle(snapshot))}</h1><p class="meta">${esc(notes[0])}</p>
    <h2>一、监控汇总</h2><div class="table-wrap"><table aria-label="客户日报监控汇总"><thead><tr>${HEADERS.slice(0, 5).map(label => `<th rowspan="2" scope="col">${esc(label)}</th>`).join('')}<th colspan="3" scope="colgroup">负面</th></tr><tr>${HEADERS.slice(5).map(label => `<th scope="col">${esc(label)}</th>`).join('')}</tr></thead><tbody>${summaryRows(snapshot).map(row => `<tr>${row.map(value => `<td>${value === null ? '' : esc(value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    ${notes.slice(1, 4).map(note => `<p class="notes">${esc(note)}</p>`).join('')}
    <h2>二、近7天发布、热度≥200的负面帖子</h2><p class="notes">${esc(heatNote(snapshot))}</p>
    ${(snapshot.highHeat || []).map((post, index) => `<article><h3>TOP${index + 1}：${linkedTitle(post)}</h3><p>${esc(sourceLabel(post))}｜${esc(heatDescription(post))}</p></article>`).join('') || '<p class="empty">暂未检出符合条件的帖子；缺测情况见数据说明。</p>'}
    <h2>三、当天新增冷处理负面帖链接</h2><p class="notes">标记动作日期：${esc(snapshot.reportDate)}；仅列本版复核截止时仍为负面、仍处于冷处理的帖子。</p>
    ${(snapshot.coldMarked || []).map((post, index) => `<article><h3>${index + 1}、${linkedTitle(post)}</h3><p>${esc(sourceLabel(post))}｜标记时间 ${esc(customerDailyTime(post.markedAt))}</p></article>`).join('') || `<p class="empty">${esc(coldEmpty(snapshot))}</p>`}
    ${snapshot.warnings?.length ? `<aside class="data-notes"><strong>数据说明</strong><ul>${snapshot.warnings.map(w => `<li>${esc(w.message)}</li>`).join('')}</ul></aside>` : ''}
    <p class="notes foot">${esc(notes[4])}</p></main></body></html>`;
}

function mergedText(sheet, row, lastColumn, value, options = {}) {
  sheet.mergeCells(row, 1, row, lastColumn);
  const cell = sheet.getCell(row, 1);
  cell.value = text(value);
  cell.alignment = {vertical: 'middle', wrapText: true};
  cell.font = {name: 'Microsoft YaHei', size: options.title ? 16 : 10, bold: options.title || false, color: {argb: options.title ? 'FF20252B' : 'FF66717E'}};
  sheet.getRow(row).height = options.height || (options.title ? 32 : 34);
}
function headerRow(sheet, rowNumber) {
  const row = sheet.getRow(rowNumber);
  row.height = 28;
  row.eachCell(cell => {
    cell.fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FF101316'}};
    cell.font = {name: 'Microsoft YaHei', size: 11, bold: true, color: {argb: 'FFFFFFFF'}};
    cell.alignment = {vertical: 'middle', horizontal: 'center', wrapText: true};
    cell.border = {top: {style: 'thin', color: {argb: 'FFBCC3CB'}}, bottom: {style: 'thin', color: {argb: 'FFBCC3CB'}}, left: {style: 'thin', color: {argb: 'FFBCC3CB'}}, right: {style: 'thin', color: {argb: 'FFBCC3CB'}}};
  });
}
function bodyRow(sheet, values) {
  const row = sheet.addRow(values);
  row.height = 42;
  row.eachCell({includeEmpty: true}, cell => {
    cell.font = {name: 'Microsoft YaHei', size: 11, color: {argb: 'FF20252B'}};
    cell.alignment = {vertical: 'top', wrapText: true};
    cell.border = {bottom: {style: 'hair', color: {argb: 'FFE4E7EB'}}};
    if (typeof cell.value === 'number') cell.numFmt = '0';
  });
  return row;
}
function hyperlink(cell, label, href) {
  const safe = url(href);
  cell.value = safe ? {text: text(label), hyperlink: safe} : text(label);
  if (safe) cell.font = {name: 'Microsoft YaHei', size: 11, color: {argb: 'FF2563EB'}, underline: true};
}
function configureSheet(sheet, columnCount) {
  sheet.properties.defaultRowHeight = 23;
  sheet.pageSetup = {paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: {left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2}};
  sheet.headerFooter.oddFooter = '&L系统生成版本；客户可编辑保存&R第 &P 页';
  for (let i = 1; i <= columnCount; i++) sheet.getColumn(i).width = 16;
}
export function buildCustomerDailyReportWorkbook(snapshot) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'StarVoice';
  workbook.title = customerDailyReportTitle(snapshot);
  workbook.subject = '客户舆情日报系统生成版';
  workbook.created = new Date(snapshot.assessedAt);
  workbook.modified = new Date(snapshot.assessedAt);
  const notes = customerDailyReportNotes(snapshot);
  const sheet = workbook.addWorksheet('日报');
  configureSheet(sheet, 8);
  mergedText(sheet, 1, 8, customerDailyReportTitle(snapshot), {title: true});
  mergedText(sheet, 2, 8, notes[0]);
  mergedText(sheet, 3, 8, notes[1]);
  mergedText(sheet, 4, 8, notes[4]);
  for (let i = 1; i <= 5; i++) { sheet.mergeCells(6, i, 7, i); sheet.getCell(6, i).value = HEADERS[i - 1]; }
  sheet.mergeCells('F6:H6'); sheet.getCell('F6').value = '负面';
  HEADERS.slice(5).forEach((value, i) => { sheet.getCell(7, i + 6).value = value; });
  headerRow(sheet, 6); headerRow(sheet, 7);
  for (const values of summaryRows(snapshot)) bodyRow(sheet, values);
  mergedText(sheet, 11, 8, notes[2]);
  mergedText(sheet, 12, 8, notes[3]);
  let noteRow = 14;
  if (snapshot.warnings?.length) {
    mergedText(sheet, noteRow++, 8, '数据说明', {title: true});
    for (const warning of snapshot.warnings) mergedText(sheet, noteRow++, 8, warning.message, {height: 38});
  }
  sheet.views = [{state: 'frozen', ySplit: 7}];
  sheet.pageSetup.printTitlesRow = '6:7';

  const heat = workbook.addWorksheet('高热负面');
  configureSheet(heat, 10);
  [8, 48, 16, 12, 18, 24, 24, 48, 32, 20].forEach((width, i) => { heat.getColumn(i + 1).width = width; });
  mergedText(heat, 1, 10, `${customerDailyReportTitle(snapshot)} · 高热负面`, {title: true});
  mergedText(heat, 2, 10, notes[0]);
  mergedText(heat, 3, 10, heatNote(snapshot), {height: 40});
  heat.getRow(5).values = ['排名', '标题', '平台/访问状态', '热度', '较昨日', '互动更新时间', '昨日实测时间', '原帖完整URL', '观测质量', '更新状态'];
  headerRow(heat, 5);
  for (const [index, post] of (snapshot.highHeat || []).entries()) {
    const row = bodyRow(heat, [index + 1, text(post.title), sourceLabel(post), n(post.heat), post.comparisonText || null,
      customerDailyTime(post.observedAt), post.previousObservedAt ? customerDailyTime(post.previousObservedAt) : null,
      url(post.url) || '原帖链接待补', qualityLabel(post), post.stale ? '本日未更新' : post.quality === 'measured' ? '本日实测' : '实测时间未核实']);
    hyperlink(row.getCell(2), post.title, post.url);
    hyperlink(row.getCell(8), url(post.url) || '原帖链接待补', post.url);
  }
  if (!snapshot.highHeat?.length) mergedText(heat, 6, 10, '暂未检出符合条件的帖子；缺测情况见日报数据说明。');
  heat.views = [{state: 'frozen', ySplit: 5}]; heat.pageSetup.printTitlesRow = '5:5';

  const cold = workbook.addWorksheet('新增冷处理');
  configureSheet(cold, 5);
  [8, 60, 20, 26, 68].forEach((width, i) => { cold.getColumn(i + 1).width = width; });
  mergedText(cold, 1, 5, `${customerDailyReportTitle(snapshot)} · 新增冷处理`, {title: true});
  mergedText(cold, 2, 5, notes[0]);
  mergedText(cold, 3, 5, `标记动作日期：${snapshot.reportDate}；只列本版仍有效的负面冷处理决定。${snapshot.evidence?.cold?.coverageComplete ? '' : '历史标记记录不完整，以下为可核实内容。'}`);
  cold.getRow(5).values = ['序号', '标题', '平台', '标记时间', '原帖完整URL']; headerRow(cold, 5);
  for (const [index, post] of (snapshot.coldMarked || []).entries()) {
    const row = bodyRow(cold, [index + 1, text(post.title), sourceLabel(post), customerDailyTime(post.markedAt), url(post.url) || '原帖链接待补']);
    hyperlink(row.getCell(2), post.title, post.url);
    hyperlink(row.getCell(5), url(post.url) || '原帖链接待补', post.url);
  }
  if (!snapshot.coldMarked?.length) mergedText(cold, 6, 5, coldEmpty(snapshot));
  cold.views = [{state: 'frozen', ySplit: 5}]; cold.pageSetup.printTitlesRow = '5:5';
  return workbook;
}
