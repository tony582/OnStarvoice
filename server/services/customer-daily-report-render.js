import ExcelJS from 'exceljs';
import {
  CUSTOMER_DAILY_SECTIONS, customerDailySummaryHeaders, isMonthlyDailyReport,
  customerDailySummaryRows as summaryRows,
  customerDailyPostPlatform as sourceLabel, customerDailyPostComparison, customerDailyColdEmpty as coldEmpty,
  customerDailyColdTitle, customerDailyColdPostLabel,
} from './customer-daily-report-presentation.js';

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
  return `${snapshot.tenantName ? `${oneLine(snapshot.tenantName)} · ` : ''}舆情日报 ${snapshot.reportDate}${time}`;
}
export function customerDailyReportNotes(snapshot) {
  return [
    `新增/互动统计截至${customerDailyTime(snapshot.cutoffAt)}；复核及冷处理状态截至${customerDailyTime(snapshot.assessedAt)}（北京时间）。`,
    `监控按首次成功入库的唯一主帖计数；复采不重复计数。SDB仅扣除「已复核-非监控内容」。MTD为本月1日至报表日的首次入库集合。`,
    `负面共${n(snapshot.summary?.day?.negative)}条，其中冷处理${n(snapshot.summary?.day?.cold)}条；MTD负面共${n(snapshot.summary?.mtd?.negative)}条，其中冷处理${n(snapshot.summary?.mtd?.cold)}条。`,
    isMonthlyDailyReport(snapshot) ? '评论区留言对应同名负面状态；负面处理流程对应负面-飞书表；其他仅计负面且已不可见或隐私设置无法触达。休息日留空并入下一工作日，MTD 按每日数量加总。' : '处理中、已处理初始为空，空白不代表0。可在本页编辑汇总并保存，也可在飞书文档或Excel中填写。',
    '本页保存后，导出和交付使用已保存的汇总。飞书文档或Excel中的修改不会自动同步回本页。',
  ];
}
function heatDescription(post) {
  return `热度 ${n(post.heat)}｜${oneLine(customerDailyPostComparison(post))}`;
}

export function renderCustomerDailyReportText(snapshot) {
  const lines = [customerDailyReportTitle(snapshot), '', CUSTOMER_DAILY_SECTIONS.summary,
    (isMonthlyDailyReport(snapshot) ? customerDailySummaryHeaders(snapshot) : ['日期', '监控数量', 'SDB范畴', '正向', '中性', '负面·冷处理', '负面·处理中', '负面·已处理']).join('\t'),
    ...summaryRows(snapshot).map(row => row.map(value => value ?? '').join('\t')),
    '', renderCustomerDailyReportMessageText(snapshot),
  ];
  return lines.join('\n');
}

export function renderCustomerDailyReportMessageText(snapshot) {
  const lines = [CUSTOMER_DAILY_SECTIONS.heat];
  if (!snapshot.highHeat?.length) lines.push('暂未检出符合条件的帖子。');
  for (const [index, post] of (snapshot.highHeat || []).entries()) {
    lines.push(`TOP${index + 1}：${oneLine(post.title)} — ${sourceLabel(post)}｜${heatDescription(post)}`, url(post.url) || '原帖链接待补');
  }
  lines.push('', customerDailyColdTitle(snapshot));
  if (!snapshot.coldMarked?.length) lines.push(coldEmpty(snapshot));
  for (const [index, post] of (snapshot.coldMarked || []).entries()) {
    const historical = customerDailyColdPostLabel(post);
    lines.push(`${index + 1}、${oneLine(post.title)}${historical ? `【${historical}】` : ''} — ${sourceLabel(post)}`, url(post.url) || '原帖链接待补');
  }
  return lines.join('\n');
}

function linkedTitle(post) {
  const href = url(post.url);
  return href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(post.title || '查看原帖')}</a>` : `${esc(post.title || '标题待补')}<span class="missing"> · 原帖链接待补</span>`;
}

export function renderCustomerDailyReportMessageHtml(snapshot) {
  return `<h2>${CUSTOMER_DAILY_SECTIONS.heat}</h2>
    ${(snapshot.highHeat || []).map((post, index) => `<article><h3>TOP${index + 1}：${linkedTitle(post)}</h3><p>${esc(sourceLabel(post))}｜${esc(heatDescription(post))}</p></article>`).join('') || '<p class="empty">暂未检出符合条件的帖子。</p>'}
    <h2>${customerDailyColdTitle(snapshot)}</h2>
    ${(snapshot.coldMarked || []).map((post, index) => `<article><h3>${index + 1}、${linkedTitle(post)}${customerDailyColdPostLabel(post) ? '<span class="historical">【历史帖】</span>' : ''}</h3><p>${esc(sourceLabel(post))}</p></article>`).join('') || `<p class="empty">${esc(coldEmpty(snapshot))}</p>`}`;
}

export function renderCustomerDailyReportHtml(snapshot) {
  const HEADERS = customerDailySummaryHeaders(snapshot);
  const header = isMonthlyDailyReport(snapshot)
    ? `<tr>${HEADERS.map(label => `<th scope="col">${esc(label)}</th>`).join('')}</tr>`
    : `<tr>${HEADERS.slice(0, 5).map(label => `<th rowspan="2" scope="col">${esc(label)}</th>`).join('')}<th colspan="3" scope="colgroup">负面</th></tr><tr>${HEADERS.slice(5).map(label => `<th scope="col">${esc(label)}</th>`).join('')}</tr>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(customerDailyReportTitle(snapshot))}</title><style>
    :root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#fff;color:#20252b;font:14px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}main{max-width:1000px;padding:32px 28px 48px;margin:auto}h1{font-size:24px;line-height:1.4;margin:0 0 12px}h2{font-size:18px;margin:32px 0 12px}p{margin:8px 0}a{color:#2563eb;text-decoration:underline;text-underline-offset:3px}.meta,.notes{font-size:12px;color:#66717e}.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:640px}th,td{border:1px solid #bcc3cb;padding:10px 9px;text-align:center}th{background:#101316;color:white;font-weight:600}td{font-variant-numeric:tabular-nums}th:first-child,td:first-child{text-align:left}article{padding:14px 0;border-bottom:1px solid #e4e7eb}article h3{font-size:15px;margin:0 0 5px;font-weight:600}.source-url{font-weight:400;font-size:11px;color:#687684;overflow-wrap:anywhere}.missing{color:#9a4c12;font-size:12px}.data-notes{margin-top:28px;padding:14px 18px;background:#f5f7fa;border-left:3px solid #95a5b9}.data-notes ul{padding-left:20px;margin:6px 0}.empty{color:#687684}.foot{margin-top:24px;border-top:1px solid #e4e7eb;padding-top:12px}@media(max-width:600px){main{padding:20px 14px}h1{font-size:21px}}@media print{main{max-width:none;padding:0}body{font-size:11px}th{print-color-adjust:exact;-webkit-print-color-adjust:exact}article{break-inside:avoid}a{color:inherit}h2{break-after:avoid}.table-wrap{overflow:visible}}
  </style></head><body><main><h1>${esc(customerDailyReportTitle(snapshot))}</h1>
    <h2>${CUSTOMER_DAILY_SECTIONS.summary}</h2><div class="table-wrap"><table aria-label="客户日报监控汇总"><thead>${header}</thead><tbody>${summaryRows(snapshot).map(row => `<tr>${row.map(value => `<td>${value === null ? '' : esc(value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    ${renderCustomerDailyReportMessageHtml(snapshot)}
    </main></body></html>`;
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
  sheet.headerFooter.oddFooter = '&R第 &P 页';
  for (let i = 1; i <= columnCount; i++) sheet.getColumn(i).width = 16;
}
export function buildCustomerDailyReportWorkbook(snapshot) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'StarVoice';
  workbook.title = customerDailyReportTitle(snapshot);
  workbook.subject = '客户舆情日报';
  workbook.created = new Date(snapshot.assessedAt);
  workbook.modified = new Date(snapshot.assessedAt);
  const sheet = workbook.addWorksheet('日报');
  const modern = isMonthlyDailyReport(snapshot);
  const HEADERS = customerDailySummaryHeaders(snapshot);
  configureSheet(sheet, HEADERS.length);
  mergedText(sheet, 1, HEADERS.length, customerDailyReportTitle(snapshot), {title: true});
  mergedText(sheet, 2, HEADERS.length, CUSTOMER_DAILY_SECTIONS.summary);
  if (modern) {
    sheet.getRow(4).values = HEADERS;
    headerRow(sheet, 4);
    sheet.getRow(4).height = 42;
    [19, 17, 15, 12, 12, 20, 24, 27, 19].forEach((width, i) => { sheet.getColumn(i + 1).width = width; });
  } else {
    for (let i = 1; i <= 5; i++) { sheet.mergeCells(4, i, 5, i); sheet.getCell(4, i).value = HEADERS[i - 1]; }
    sheet.mergeCells('F4:H4'); sheet.getCell('F4').value = '负面';
    HEADERS.slice(5).forEach((value, i) => { sheet.getCell(5, i + 6).value = value; });
    headerRow(sheet, 4); headerRow(sheet, 5);
  }
  const firstDataRow = modern ? 5 : 6;
  const rows = summaryRows(snapshot);
  for (const values of rows) {
    const row = bodyRow(sheet, values);
    row.height = modern ? 28 : 42;
    if (modern && values[0] === 'MTD') {
      for (let column = 2; column <= HEADERS.length; column++) {
        const cell = row.getCell(column);
        cell.value = {formula: `SUM(${cell.address.replace(/\d+$/, '')}${firstDataRow}:${cell.address.replace(/\d+$/, '')}${row.number - 1})`, result: values[column - 1]};
        cell.font = {...cell.font, bold: true};
      }
    }
  }
  sheet.views = [{state: 'frozen', ySplit: modern ? 4 : 5}];
  sheet.pageSetup.printTitlesRow = modern ? '4:4' : '4:5';

  const heat = workbook.addWorksheet('高热负面');
  configureSheet(heat, 5);
  [9, 64, 16, 14, 24].forEach((width, i) => { heat.getColumn(i + 1).width = width; });
  mergedText(heat, 1, 5, customerDailyReportTitle(snapshot), {title: true});
  mergedText(heat, 2, 5, CUSTOMER_DAILY_SECTIONS.heat);
  heat.getRow(4).values = ['排名', '标题', '平台', '热度', '较昨日'];
  headerRow(heat, 4);
  for (const [index, post] of (snapshot.highHeat || []).entries()) {
    const row = bodyRow(heat, [`TOP${index + 1}`, text(post.title), sourceLabel(post), n(post.heat), customerDailyPostComparison(post).replace(/^较昨日 /, '')]);
    hyperlink(row.getCell(2), post.title, post.url);
  }
  if (!snapshot.highHeat?.length) mergedText(heat, 5, 5, '暂未检出符合条件的帖子。');
  heat.views = [{state: 'frozen', ySplit: 4}]; heat.pageSetup.printTitlesRow = '4:4';

  const cold = workbook.addWorksheet('本期冷处理');
  configureSheet(cold, 3);
  [9, 72, 18].forEach((width, i) => { cold.getColumn(i + 1).width = width; });
  mergedText(cold, 1, 3, customerDailyReportTitle(snapshot), {title: true});
  mergedText(cold, 2, 3, customerDailyColdTitle(snapshot));
  cold.getRow(4).values = ['序号', '标题', '平台']; headerRow(cold, 4);
  for (const [index, post] of (snapshot.coldMarked || []).entries()) {
    const title = `${text(post.title)}${customerDailyColdPostLabel(post) ? '【历史帖】' : ''}`;
    const row = bodyRow(cold, [index + 1, title, sourceLabel(post)]);
    hyperlink(row.getCell(2), title, post.url);
  }
  if (!snapshot.coldMarked?.length) mergedText(cold, 5, 3, coldEmpty(snapshot));
  cold.views = [{state: 'frozen', ySplit: 4}]; cold.pageSetup.printTitlesRow = '4:4';
  return workbook;
}
