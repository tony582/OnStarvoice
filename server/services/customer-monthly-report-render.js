import ExcelJS from 'exceljs';
import {customerDailyPostPlatform, customerDailyPostStatus} from './customer-daily-report-presentation.js';
import {customerMonthlySentimentLabel, CUSTOMER_MONTHLY_HEAT_THRESHOLD} from './customer-monthly-report-data.js';

export const CUSTOMER_MONTHLY_SUMMARY_FIELDS = Object.freeze(['monitor', 'sdb', 'positive', 'neutral', 'cold', 'comment', 'negativeProcess', 'negativeOther']);
export const CUSTOMER_MONTHLY_SUMMARY_HEADERS = Object.freeze(['发帖日期', '平台监控量', 'SDB范畴', '正面', '中性', '负面-冷处理', '负面-评论区留言', '负面-走负面处理流程', '负面-其他']);
export const CUSTOMER_MONTHLY_SECTIONS = Object.freeze({
  summary: '一、月度舆情汇总（按发帖日期）',
  topics: '二、内容主题分布',
  platforms: '三、平台分布',
  heat: `四、本月热度值≥${CUSTOMER_MONTHLY_HEAT_THRESHOLD}的负面帖子`,
});
export const CUSTOMER_MONTHLY_DETAIL_HEADERS = Object.freeze(['序号', '发布时间', '平台', '标题', '作者', '情感', '处理状态', '内容主题', '采集关键词', '点赞', '评论', '收藏', '分享', '首次采集时间', '原帖链接']);

function esc(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char])); }
function url(value) {
  try { const parsed = new URL(String(value || '')); return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : ''; }
  catch { return ''; }
}
function text(value) { return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''); }
function oneLine(value) { return text(value).replace(/\s+/g, ' ').trim(); }
function n(value) { return Number(value) || 0; }
export function customerMonthlyTime(value, {dateOnly = false} = {}) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '时间未确认';
  const stamp = new Date(new Date(value).getTime() + 8 * 3_600_000).toISOString();
  return dateOnly ? stamp.slice(0, 10) : stamp.slice(0, 16).replace('T', ' ');
}
function dateLabel(date) { const [year, month, day] = String(date).split('-'); return `${year}/${Number(month)}/${Number(day)}`; }
function values(label, counts = {}) { return [label, ...CUSTOMER_MONTHLY_SUMMARY_FIELDS.map(field => n(counts[field]))]; }

export function customerMonthlyReportTitle(snapshot) {
  const suffix = snapshot.complete === false ? ` · 截至${customerMonthlyTime(snapshot.cutoffAt).slice(5, 10)}` : '';
  return `${snapshot.tenantName ? `${oneLine(snapshot.tenantName)} · ` : ''}舆情月报 ${snapshot.reportMonth}${suffix}`;
}
export function customerMonthlySummaryBasis() {
  return '按帖子发布时间（北京时间）统计内容分诊中未归档的主帖，同帖只计一次；SDB扣除已复核-非监控内容；情感、处理状态和内容主题取本版生成时的有效结论。';
}
export function customerMonthlyReportNotes(snapshot) {
  return [
    customerMonthlySummaryBasis(snapshot),
    `统计范围：${customerMonthlyTime(snapshot.periodStart)} 至 ${customerMonthlyTime(snapshot.cutoffAt)} 发布的帖子${snapshot.complete === false ? '（本月尚未结束，为月初至今）' : ''}；生成时间 ${customerMonthlyTime(snapshot.assessedAt)}。`,
    '内容主题按帖子主要讨论对象单选归类；尚未生成主题的帖子列为“主题生成中”。采集时间、处理时间不影响月份归属，与按处理日期统计的客户日报口径不同。',
    `高热负面帖按本月发布、情感为负面且可见互动合计（点赞、评论、收藏、分享）不低于${CUSTOMER_MONTHLY_HEAT_THRESHOLD}的帖子列出，取最近一次采集到的互动数；互动项缺失的按已知项合计并标为至少。`,
    '月报明细随本版本冻结保存，下载的明细与本版汇总一致；重新生成会产生新版本，不改写已有版本。',
  ];
}
export function customerMonthlySummaryRows(snapshot) {
  return [...(snapshot.summary?.rows || []).map(row => values(dateLabel(row.date), row.counts)), values('合计', snapshot.summary?.total)];
}
export function customerMonthlyGroupRows(groups = [], total) {
  return [...groups.map(group => values(group.label, group.counts)), values('合计', total)];
}
export function customerMonthlyPostHeat(post) {
  if (typeof post.heat !== 'number' || !Number.isFinite(post.heat) || post.heat < 0) return '待核实';
  return post.heatIsLowerBound ? `至少 ${post.heat}` : String(post.heat);
}
function heatLine(post) {
  return `${customerDailyPostPlatform(post)}｜热度 ${customerMonthlyPostHeat(post)}｜发布 ${customerMonthlyTime(post.publishedAt, {dateOnly: true})}｜处理状态：${oneLine(customerDailyPostStatus(post))}｜主题：${oneLine(post.topicLabel || '主题生成中')}`;
}

export function renderCustomerMonthlyReportText(snapshot) {
  const table = (title, headers, rows) => [title, headers.join('\t'), ...rows.map(row => row.join('\t')), ''];
  const topicHeaders = ['内容主题', ...CUSTOMER_MONTHLY_SUMMARY_HEADERS.slice(1)];
  const platformHeaders = ['平台', ...CUSTOMER_MONTHLY_SUMMARY_HEADERS.slice(1)];
  const lines = [customerMonthlyReportTitle(snapshot), customerMonthlySummaryBasis(snapshot), '',
    ...table(CUSTOMER_MONTHLY_SECTIONS.summary, CUSTOMER_MONTHLY_SUMMARY_HEADERS, customerMonthlySummaryRows(snapshot)),
    ...table(CUSTOMER_MONTHLY_SECTIONS.topics, topicHeaders, customerMonthlyGroupRows(snapshot.summary?.byTopic, snapshot.summary?.total)),
    ...table(CUSTOMER_MONTHLY_SECTIONS.platforms, platformHeaders, customerMonthlyGroupRows(snapshot.summary?.byPlatform, snapshot.summary?.total)),
    CUSTOMER_MONTHLY_SECTIONS.heat];
  if (!snapshot.topNegative?.length) lines.push('本月暂未检出符合条件的帖子。');
  for (const [index, post] of (snapshot.topNegative || []).entries()) lines.push(`TOP${index + 1}：${oneLine(post.title)} — ${heatLine(post)}`, url(post.url) || '原帖链接待补');
  lines.push('', '数据说明', ...customerMonthlyReportNotes(snapshot).map(note => `· ${note}`));
  return lines.join('\n');
}

const CELL = 'border:1px solid #bcc3cb;padding:7px 6px;text-align:center;font-size:12px;line-height:1.4;';
const HEAD = `${CELL}background:#101316;color:#fff;font-weight:600;`;
function tableHtml(title, headers, rows, {email, firstLeft = false}) {
  const head = `<tr>${headers.map((label, index) => `<th scope="col"${email ? ` style="${HEAD}"` : ''}>${esc(label)}</th>`).join('')}</tr>`;
  const body = rows.map(row => `<tr${row[0] === '合计' ? ' class="total"' : ''}>${row.map((value, index) => `<td${email ? ` style="${CELL}${index === 0 && firstLeft ? 'text-align:left;' : ''}${row[0] === '合计' ? 'background:#f1f1f1;font-weight:600;' : ''}"` : ''}${email && typeof value === 'number' ? ' nowrap="nowrap"' : ''}>${esc(value)}</td>`).join('')}</tr>`).join('');
  return `<h2>${esc(title)}</h2><div class="table-wrap"><table${email ? ' width="640" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:640px;max-width:100%;"' : ''} class="${firstLeft ? 'grouped' : 'monthly'}" aria-label="${esc(title)}"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}
function linkedTitle(post) {
  const href = url(post.url);
  return href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(post.title || '查看原帖')}</a>` : `${esc(post.title || '标题待补')}<span class="missing"> · 原帖链接待补</span>`;
}
export function renderCustomerMonthlyReportHtml(snapshot, {email = false} = {}) {
  const topicHeaders = ['内容主题', ...CUSTOMER_MONTHLY_SUMMARY_HEADERS.slice(1)];
  const platformHeaders = ['平台', ...CUSTOMER_MONTHLY_SUMMARY_HEADERS.slice(1)];
  const font = "font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',Arial,sans-serif;";
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(customerMonthlyReportTitle(snapshot))}</title><style>
    :root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#fff;color:#20252b;font:14px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}main{max-width:1000px;padding:32px 28px 48px;margin:auto}h1{font-size:24px;line-height:1.4;margin:0 0 12px}h2{font-size:18px;margin:32px 0 12px}p{margin:8px 0}a{color:#2563eb;text-decoration:underline;text-underline-offset:3px}.notes{font-size:12px;color:#66717e}.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:640px}th,td{border:1px solid #bcc3cb;padding:8px 7px;text-align:center}th{background:#101316;color:white;font-weight:600}td{font-variant-numeric:tabular-nums}.grouped th:first-child,.grouped td:first-child{text-align:left}tr.total td{background:#f1f1f1;font-weight:600}article{padding:14px 0;border-bottom:1px solid #e4e7eb}article h3{font-size:15px;margin:0 0 5px;font-weight:600}.missing{color:#9a4c12;font-size:12px}.data-notes{margin-top:28px;padding:14px 18px;background:#f5f7fa;border-left:3px solid #95a5b9}.data-notes ul{padding-left:20px;margin:6px 0}.empty{color:#687684}@media(max-width:600px){main{padding:20px 14px}h1{font-size:21px}}@media print{main{max-width:none;padding:0}body{font-size:11px}th{print-color-adjust:exact;-webkit-print-color-adjust:exact}article{break-inside:avoid}a{color:inherit}h2{break-after:avoid}.table-wrap{overflow:visible}}
  </style></head><body><main><h1>${esc(customerMonthlyReportTitle(snapshot))}</h1><p class="notes">${esc(customerMonthlySummaryBasis(snapshot))}</p>
    ${tableHtml(CUSTOMER_MONTHLY_SECTIONS.summary, CUSTOMER_MONTHLY_SUMMARY_HEADERS, customerMonthlySummaryRows(snapshot), {email})}
    ${tableHtml(CUSTOMER_MONTHLY_SECTIONS.topics, topicHeaders, customerMonthlyGroupRows(snapshot.summary?.byTopic, snapshot.summary?.total), {email, firstLeft: true})}
    ${tableHtml(CUSTOMER_MONTHLY_SECTIONS.platforms, platformHeaders, customerMonthlyGroupRows(snapshot.summary?.byPlatform, snapshot.summary?.total), {email, firstLeft: true})}
    <h2>${esc(CUSTOMER_MONTHLY_SECTIONS.heat)}</h2>
    ${(snapshot.topNegative || []).map((post, index) => `<article><h3>TOP${index + 1}：${linkedTitle(post)}</h3><p>${esc(heatLine(post))}</p></article>`).join('') || '<p class="empty">本月暂未检出符合条件的帖子。</p>'}
    <section class="data-notes"><p><strong>数据说明</strong></p><ul>${customerMonthlyReportNotes(snapshot).map(note => `<li>${esc(note)}</li>`).join('')}</ul></section>
    </main></body></html>`;
  if (!email) return html;
  return html.replace(/<(body|main|h[1-6]|p|a|span|li|table|th|td)(?=[\s>])([^>]*)>/g, (_, tag, attrs) =>
    `<${tag}${attrs.includes('style="') ? attrs.replace('style="', `style="${font}`) : `${attrs} style="${font}"`}>`);
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
function bodyRow(sheet, rowValues, {center = true, total = false} = {}) {
  const row = sheet.addRow(rowValues);
  row.height = center ? 26 : 36;
  row.eachCell({includeEmpty: true}, cell => {
    cell.font = {name: 'Microsoft YaHei', size: 11, bold: total, color: {argb: 'FF20252B'}};
    cell.alignment = center ? {vertical: 'middle', horizontal: 'center'} : {vertical: 'top', wrapText: true};
    cell.border = center ? {top: {style: 'thin', color: {argb: 'FFBCC3CB'}}, bottom: {style: 'thin', color: {argb: 'FFBCC3CB'}}, left: {style: 'thin', color: {argb: 'FFBCC3CB'}}, right: {style: 'thin', color: {argb: 'FFBCC3CB'}}} : {bottom: {style: 'hair', color: {argb: 'FFE4E7EB'}}};
    if (total) cell.fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFF1F1F1'}};
    if (typeof cell.value === 'number') cell.numFmt = '0';
  });
  return row;
}
function hyperlink(cell, label, href) {
  const safe = url(href);
  cell.value = safe ? {text: text(label), hyperlink: safe} : text(label);
  if (safe) cell.font = {name: 'Microsoft YaHei', size: 11, color: {argb: 'FF2563EB'}, underline: true};
}
function configureSheet(sheet, widths) {
  sheet.properties.defaultRowHeight = 23;
  sheet.pageSetup = {paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: {left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2}};
  sheet.headerFooter.oddFooter = '&R第 &P 页';
  widths.forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
}
function appendCountTable(workbook, snapshot, {name, title, headers, rows, widths, firstLeft = false}) {
  const sheet = workbook.addWorksheet(name);
  configureSheet(sheet, widths);
  mergedText(sheet, 1, headers.length, customerMonthlyReportTitle(snapshot), {title: true});
  mergedText(sheet, 2, headers.length, title);
  mergedText(sheet, 3, headers.length, customerMonthlySummaryBasis(snapshot), {height: 30});
  sheet.getRow(4).values = headers;
  headerRow(sheet, 4);
  sheet.getRow(4).height = 42;
  for (const rowValues of rows) {
    const row = bodyRow(sheet, rowValues, {total: rowValues[0] === '合计'});
    if (firstLeft) row.getCell(1).alignment = {vertical: 'middle', horizontal: 'left'};
  }
  sheet.views = [{state: 'frozen', ySplit: 4}];
  sheet.pageSetup.printTitlesRow = '4:4';
  return sheet;
}

export function buildCustomerMonthlyReportWorkbook(snapshot) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'StarVoice';
  workbook.title = customerMonthlyReportTitle(snapshot);
  workbook.subject = '客户舆情月报';
  workbook.created = new Date(snapshot.assessedAt);
  workbook.modified = new Date(snapshot.assessedAt);
  const widths = [19, 17, 15, 12, 12, 20, 24, 27, 19];
  appendCountTable(workbook, snapshot, {name: '月报汇总', title: CUSTOMER_MONTHLY_SECTIONS.summary, headers: CUSTOMER_MONTHLY_SUMMARY_HEADERS, rows: customerMonthlySummaryRows(snapshot), widths});
  appendCountTable(workbook, snapshot, {name: '内容主题', title: CUSTOMER_MONTHLY_SECTIONS.topics, headers: ['内容主题', ...CUSTOMER_MONTHLY_SUMMARY_HEADERS.slice(1)], rows: customerMonthlyGroupRows(snapshot.summary?.byTopic, snapshot.summary?.total), widths: [22, ...widths.slice(1)], firstLeft: true});
  appendCountTable(workbook, snapshot, {name: '平台分布', title: CUSTOMER_MONTHLY_SECTIONS.platforms, headers: ['平台', ...CUSTOMER_MONTHLY_SUMMARY_HEADERS.slice(1)], rows: customerMonthlyGroupRows(snapshot.summary?.byPlatform, snapshot.summary?.total), widths: [22, ...widths.slice(1)], firstLeft: true});
  const heatHeaders = ['序号', '标题', '平台', '热度', '发布时间', '处理状态', '内容主题', '原帖链接'];
  const heat = workbook.addWorksheet('高热负面帖');
  configureSheet(heat, [8, 48, 12, 12, 18, 22, 16, 48]);
  mergedText(heat, 1, heatHeaders.length, customerMonthlyReportTitle(snapshot), {title: true});
  mergedText(heat, 2, heatHeaders.length, CUSTOMER_MONTHLY_SECTIONS.heat);
  heat.getRow(3).values = heatHeaders;
  headerRow(heat, 3);
  for (const [index, post] of (snapshot.topNegative || []).entries()) {
    const row = bodyRow(heat, [index + 1, oneLine(post.title), customerDailyPostPlatform(post), customerMonthlyPostHeat(post), customerMonthlyTime(post.publishedAt), customerDailyPostStatus(post), post.topicLabel || '主题生成中', ''], {center: false});
    hyperlink(row.getCell(8), url(post.url) || '原帖链接待补', post.url);
  }
  if (!snapshot.topNegative?.length) bodyRow(heat, ['本月暂未检出符合条件的帖子。'], {center: false});
  heat.views = [{state: 'frozen', ySplit: 3}];
  const notes = workbook.addWorksheet('数据说明');
  configureSheet(notes, [120]);
  mergedText(notes, 1, 1, customerMonthlyReportTitle(snapshot), {title: true});
  customerMonthlyReportNotes(snapshot).forEach((note, index) => mergedText(notes, index + 2, 1, note, {height: 40}));
  return workbook;
}

export function buildCustomerMonthlyDetailWorkbook(snapshot) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'StarVoice';
  workbook.title = `${customerMonthlyReportTitle(snapshot)} 明细`;
  workbook.subject = '客户舆情月报明细';
  workbook.created = new Date(snapshot.assessedAt);
  workbook.modified = new Date(snapshot.assessedAt);
  const sheet = workbook.addWorksheet('明细');
  configureSheet(sheet, [7, 18, 10, 46, 16, 8, 20, 14, 16, 8, 8, 8, 8, 18, 46]);
  mergedText(sheet, 1, CUSTOMER_MONTHLY_DETAIL_HEADERS.length, `${customerMonthlyReportTitle(snapshot)} 明细（${(snapshot.records || []).length} 条）`, {title: true});
  mergedText(sheet, 2, CUSTOMER_MONTHLY_DETAIL_HEADERS.length, customerMonthlySummaryBasis(snapshot), {height: 30});
  sheet.getRow(3).values = [...CUSTOMER_MONTHLY_DETAIL_HEADERS];
  headerRow(sheet, 3);
  for (const [index, record] of (snapshot.records || []).entries()) {
    const row = bodyRow(sheet, [index + 1, customerMonthlyTime(record.publishedAt), customerDailyPostPlatform(record), oneLine(record.title), oneLine(record.authorName),
      customerMonthlySentimentLabel(record.sentiment), customerDailyPostStatus(record), record.topicLabel || '主题生成中', oneLine(record.keyword),
      record.likes ?? '', record.comments ?? '', record.collects ?? '', record.shares ?? '', customerMonthlyTime(record.firstSeenAt), ''], {center: false});
    row.height = 24;
    hyperlink(row.getCell(15), url(record.url) || '原帖链接待补', record.url);
  }
  sheet.views = [{state: 'frozen', ySplit: 3}];
  sheet.autoFilter = {from: {row: 3, column: 1}, to: {row: 3, column: CUSTOMER_MONTHLY_DETAIL_HEADERS.length}};
  return workbook;
}
