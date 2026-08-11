import ExcelJS from 'exceljs';
import { queryAll, queryOne } from '../db/init.js';
import { PUBLISHED_RECORD_PERIOD_SQL, RELEVANT_RECORD_SQL } from './report-generator.js';

const SOURCE_SHEET = '内容分诊数据源';
const COLORS = {
  navy: '17365D',
  blue: '2563EB',
  paleBlue: 'EAF2FF',
  paleGreen: 'ECFDF3',
  paleRed: 'FEF2F2',
  paleSlate: 'F8FAFC',
  border: 'D9E2F3',
  text: '172033',
  muted: '667085',
  white: 'FFFFFF',
  green: '059669',
  amber: 'D97706',
};

const PLATFORM_LABELS = {
  xiaohongshu: '小红书',
  douyin: '抖音',
  weibo: '微博',
  unknown: '未知平台',
  '': '未知平台',
};
const SENTIMENT_LABELS = { positive: '正面', neutral: '中性', negative: '负面', '': '待标注' };
const CATEGORY_LABELS = {
  safety_rescue: '安全救援',
  feature_usage: '功能使用',
  renewal_billing: '续费收费',
  privacy: '隐私安全',
  app_issue: 'App问题',
  service_quality: '服务质量',
  brand_image: '品牌形象',
  official_response: '官方响应',
  other: '其他',
  '': '待分类',
};
const HANDLING_LABELS = {
  unhandled: '待处理',
  replied: '已回复',
  reviewed: '已复核',
  reviewed_non_monitor: '已复核-非监控内容',
  unavailable: '已不可见',
  negative_feishu: '负面-飞书表',
  negative_cold: '负面-冷处理',
};
const HANDLING_STATUS_SQL = `(
  'unhandled', 'replied', 'reviewed', 'reviewed_non_monitor',
  'unavailable', 'negative_feishu', 'negative_cold'
)`;

const CONTENT_COLUMNS = [
  { header: '记录ID', key: 'id', width: 38 },
  { header: '平台编码', key: 'platformCode', width: 15 },
  { header: '平台', key: 'platform', width: 12 },
  { header: '内容类型', key: 'recordType', width: 18 },
  { header: '采集关键词', key: 'keyword', width: 20 },
  { header: '标题', key: 'title', width: 36, wrap: true },
  { header: '正文', key: 'content', width: 52, wrap: true },
  { header: '作者', key: 'authorName', width: 22 },
  { header: '作者粉丝数', key: 'authorFans', width: 14, numberFormat: '#,##0' },
  { header: '情感编码', key: 'sentimentCode', width: 14 },
  { header: '情感', key: 'sentiment', width: 10 },
  { header: '主题编码', key: 'categoryCode', width: 20 },
  { header: '主题', key: 'category', width: 16 },
  { header: '处理模式编码', key: 'handlingCode', width: 24 },
  { header: '处理模式', key: 'handling', width: 24 },
  { header: '飞书表号', key: 'feishuTableNo', width: 20, text: true },
  { header: '点赞', key: 'likes', width: 12, numberFormat: '#,##0' },
  { header: '评论', key: 'comments', width: 12, numberFormat: '#,##0' },
  { header: '收藏', key: 'collects', width: 12, numberFormat: '#,##0' },
  { header: '转发', key: 'shares', width: 12, numberFormat: '#,##0' },
  { header: '互动总量', key: 'interactions', width: 14, numberFormat: '#,##0' },
  { header: '负面评论数', key: 'negativeCommentCount', width: 14, numberFormat: '#,##0' },
  { header: '官方回复状态', key: 'officialResponse', width: 16 },
  { header: '发布时间', key: 'publishedAt', width: 20, date: true },
  { header: '首次发现', key: 'firstSeenAt', width: 20, date: true },
  { header: '最近采集', key: 'lastSeenAt', width: 20, date: true },
  { header: '入库时间', key: 'createdAt', width: 20, date: true },
  { header: '归档时间', key: 'archivedAt', width: 20, date: true },
  { header: '本期入库标记（1=是）', key: 'isNewPeriod', width: 20, numberFormat: '0' },
  { header: '原文链接', key: 'url', width: 42 },
];

function asDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function inPeriod(value, startMs, endMs) {
  const date = asDate(value);
  return Boolean(date && date.getTime() >= startMs && date.getTime() < endMs);
}

function num(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function columnLetter(number) {
  let value = number;
  let output = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    output = String.fromCharCode(65 + remainder) + output;
    value = Math.floor((value - 1) / 26);
  }
  return output;
}

function cellPosition(address) {
  const match = /^([A-Z]+)(\d+)$/.exec(String(address || '').toUpperCase());
  if (!match) throw new Error(`invalid workbook cell address: ${address}`);
  const column = [...match[1]].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
  return { column, row: Number(match[2]) };
}

function rangeBounds(range) {
  const [from, to = from] = String(range).split(':');
  const start = cellPosition(from);
  const end = cellPosition(to);
  return {
    startRow: Math.min(start.row, end.row),
    endRow: Math.max(start.row, end.row),
    startColumn: Math.min(start.column, end.column),
    endColumn: Math.max(start.column, end.column),
  };
}

function forEachRangeCell(sheet, range, callback) {
  const bounds = rangeBounds(range);
  for (let row = bounds.startRow; row <= bounds.endRow; row += 1) {
    for (let column = bounds.startColumn; column <= bounds.endColumn; column += 1) {
      callback(sheet.getCell(row, column), row - bounds.startRow, column - bounds.startColumn);
    }
  }
}

function writeRangeValues(sheet, range, values) {
  const bounds = rangeBounds(range);
  const expectedRows = bounds.endRow - bounds.startRow + 1;
  const expectedColumns = bounds.endColumn - bounds.startColumn + 1;
  if (values.length !== expectedRows || values.some(row => row.length !== expectedColumns)) {
    throw new Error(`workbook range shape mismatch: ${range}`);
  }
  forEachRangeCell(sheet, range, (cell, rowOffset, columnOffset) => {
    cell.value = values[rowOffset][columnOffset];
  });
}

function styleRange(sheet, range, style) {
  forEachRangeCell(sheet, range, cell => {
    if (style.fill) cell.fill = style.fill;
    if (style.font) cell.font = style.font;
    if (style.alignment) cell.alignment = style.alignment;
    if (style.border) cell.border = style.border;
    if (style.numFmt) cell.numFmt = style.numFmt;
  });
}

function sourceRange(key, rowCount) {
  const index = CONTENT_COLUMNS.findIndex(column => column.key === key);
  if (index < 0) throw new Error(`missing workbook source column: ${key}`);
  const letter = columnLetter(index + 1);
  return `'${SOURCE_SHEET}'!$${letter}$2:$${letter}$${Math.max(2, rowCount + 1)}`;
}

function addSourceSheet(workbook, rows) {
  const sheet = workbook.addWorksheet(SOURCE_SHEET, {
    views: [{ state: 'frozen', ySplit: 1, showGridLines: false }],
  });
  sheet.columns = CONTENT_COLUMNS.map(column => ({
    header: column.header,
    key: column.key,
    width: column.width,
  }));
  rows.forEach(row => sheet.addRow(row));
  sheet.autoFilter = { from: 'A1', to: `${columnLetter(CONTENT_COLUMNS.length)}1` };
  sheet.getRow(1).height = 26;
  sheet.getRow(1).eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.navy } };
    cell.font = { bold: true, color: { argb: COLORS.white }, size: 10, name: 'Microsoft YaHei' };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = { bottom: { style: 'thin', color: { argb: COLORS.border } } };
  });
  for (const definition of CONTENT_COLUMNS) {
    const column = sheet.getColumn(definition.key);
    if (definition.numberFormat) column.numFmt = definition.numberFormat;
    if (definition.date) column.numFmt = 'yyyy-mm-dd hh:mm';
    if (definition.text) column.numFmt = '@';
    column.alignment = {
      vertical: 'top',
      horizontal: definition.numberFormat ? 'right' : 'left',
      wrapText: Boolean(definition.wrap),
    };
  }
  for (let rowNumber = 2; rowNumber <= rows.length + 1; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    row.eachCell(cell => {
      cell.font = { ...(cell.font || {}), name: 'Microsoft YaHei', size: 9 };
      if (rowNumber % 2 === 0) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.paleSlate } };
      }
    });
  }
  return sheet;
}

function styleSectionHeader(sheet, range, title, fill) {
  sheet.mergeCells(range);
  const cell = sheet.getCell(range.split(':')[0]);
  cell.value = title;
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
  cell.font = { bold: true, color: { argb: COLORS.white }, size: 11 };
  cell.alignment = { vertical: 'middle', horizontal: 'left' };
}

function styleTableHeader(sheet, range) {
  styleRange(sheet, range, {
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'DCE8FA' } },
    font: { bold: true, color: { argb: COLORS.text } },
    alignment: { vertical: 'middle', horizontal: 'center' },
    border: { bottom: { style: 'thin', color: { argb: COLORS.border } } },
  });
}

function setFormula(sheet, address, formula, result, numberFormat = '#,##0') {
  const cell = sheet.getCell(address);
  cell.value = { formula: String(formula).replace(/^=/, ''), result };
  cell.numFmt = numberFormat;
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.paleBlue } };
  cell.font = { bold: true, color: { argb: COLORS.blue } };
  cell.alignment = { vertical: 'middle', horizontal: 'right' };
  cell.border = {
    top: { style: 'thin', color: { argb: COLORS.border } },
    bottom: { style: 'thin', color: { argb: COLORS.border } },
    left: { style: 'thin', color: { argb: COLORS.border } },
    right: { style: 'thin', color: { argb: COLORS.border } },
  };
}

function addKpi(sheet, { labelRange, valueRange, label, formula, result, fill }) {
  sheet.mergeCells(labelRange);
  sheet.mergeCells(valueRange);
  const labelCell = sheet.getCell(labelRange.split(':')[0]);
  labelCell.value = label;
  labelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
  labelCell.font = { bold: true, color: { argb: COLORS.muted }, size: 10 };
  labelCell.alignment = { vertical: 'middle', horizontal: 'left' };
  setFormula(sheet, valueRange.split(':')[0], formula, result);
  const valueCell = sheet.getCell(valueRange.split(':')[0]);
  valueCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
  valueCell.font = { bold: true, color: { argb: COLORS.text }, size: 20 };
  valueCell.alignment = { vertical: 'middle', horizontal: 'left' };
  styleRange(sheet, `${labelRange.split(':')[0]}:${valueRange.split(':')[1]}`, {
    border: {
      top: { style: 'thin', color: { argb: COLORS.border } },
      bottom: { style: 'thin', color: { argb: COLORS.border } },
      left: { style: 'thin', color: { argb: COLORS.border } },
      right: { style: 'thin', color: { argb: COLORS.border } },
    },
  });
}

function addDistributionBlock(sheet, {
  titleRange,
  title,
  headerRange,
  startRow,
  labels,
  source,
  counts,
  denominatorCell,
  color,
}) {
  styleSectionHeader(sheet, titleRange, title, color);
  const startColumn = titleRange.split(':')[0].replace(/\d+/g, '');
  const startColumnNumber = [...startColumn].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
  const labelColumn = columnLetter(startColumnNumber);
  const countColumn = columnLetter(startColumnNumber + 1);
  const shareColumn = columnLetter(startColumnNumber + 2);
  writeRangeValues(sheet, headerRange, [['分类', '内容量', '占比']]);
  styleTableHeader(sheet, headerRange);
  labels.forEach((label, index) => {
    const row = startRow + index;
    sheet.getCell(`${labelColumn}${row}`).value = label;
    setFormula(sheet, `${countColumn}${row}`, `=COUNTIF(${source},${labelColumn}${row})`, counts[label] || 0);
    setFormula(
      sheet,
      `${shareColumn}${row}`,
      `=IFERROR(${countColumn}${row}/${denominatorCell},0)`,
      counts.__total ? (counts[label] || 0) / counts.__total : 0,
      '0.0%',
    );
  });
  styleRange(sheet, `${labelColumn}${startRow}:${shareColumn}${startRow + labels.length - 1}`, {
    border: { bottom: { style: 'thin', color: { argb: COLORS.border } } },
  });
}

async function loadContentSource({ tenantId, periodStart, periodEnd, keywords }) {
  const keywordList = (Array.isArray(keywords) ? keywords : [])
    .map(value => String(value || '').trim())
    .filter(Boolean);
  const params = keywordList.length
    ? [tenantId, periodStart.toISOString(), periodEnd.toISOString(), keywordList]
    : [tenantId, periodStart.toISOString(), periodEnd.toISOString()];
  const keywordSql = keywordList.length ? ' AND r.keyword = ANY($4::text[])' : '';
  const [tenant, rawRows] = await Promise.all([
    queryOne('SELECT name FROM tenants WHERE id = $1', [tenantId]),
    queryAll(`
      SELECT r.id, r.platform, r.record_type, r.keyword, r.title, r.content, r.author_name, r.author_fans,
        r.sentiment, r.category, r.likes, r.comments_count, r.collects, r.shares,
        r.negative_comment_count, r.official_response_status, r.published_ts,
        r.first_seen_at, r.last_seen_at, r.created_at, r.url,
        COALESCE(rt.status, 'unhandled') AS handling_status,
        COALESCE(rt.feishu_table_no, '') AS feishu_table_no,
        rt.archived_at
      FROM records r
      LEFT JOIN record_triage rt ON rt.record_id = r.id AND rt.tenant_id = r.tenant_id
      WHERE r.tenant_id = $1
        AND ${RELEVANT_RECORD_SQL}
        AND COALESCE(rt.status, 'unhandled') IN ${HANDLING_STATUS_SQL}
        ${keywordSql}
        AND ${PUBLISHED_RECORD_PERIOD_SQL}
      ORDER BY r.published_ts DESC, r.id DESC
    `, params),
  ]);
  const startMs = periodStart.getTime();
  const endMs = periodEnd.getTime();
  const rows = rawRows.map(row => {
    const platformCode = String(row.platform || 'unknown');
    const sentimentCode = String(row.sentiment || '');
    const categoryCode = String(row.category || '');
    const handlingCode = String(row.handling_status || 'unhandled');
    return {
      id: String(row.id),
      platformCode,
      platform: PLATFORM_LABELS[platformCode] || platformCode || '未知平台',
      recordType: String(row.record_type || ''),
      keyword: String(row.keyword || ''),
      title: String(row.title || ''),
      content: String(row.content || ''),
      authorName: String(row.author_name || ''),
      authorFans: num(row.author_fans),
      sentimentCode,
      sentiment: SENTIMENT_LABELS[sentimentCode] || sentimentCode || '待标注',
      categoryCode,
      category: CATEGORY_LABELS[categoryCode] || categoryCode || '待分类',
      handlingCode,
      handling: HANDLING_LABELS[handlingCode] || handlingCode || '待处理',
      feishuTableNo: String(row.feishu_table_no || ''),
      likes: num(row.likes),
      comments: num(row.comments_count),
      collects: num(row.collects),
      shares: num(row.shares),
      interactions: num(row.likes) + num(row.comments_count) + num(row.collects) + num(row.shares),
      negativeCommentCount: num(row.negative_comment_count),
      officialResponse: String(row.official_response_status || ''),
      publishedAt: asDate(row.published_ts),
      firstSeenAt: asDate(row.first_seen_at),
      lastSeenAt: asDate(row.last_seen_at),
      createdAt: asDate(row.created_at),
      archivedAt: asDate(row.archived_at),
      isNewPeriod: inPeriod(row.created_at, startMs, endMs) ? 1 : 0,
      url: String(row.url || ''),
    };
  });
  return { tenantName: String(tenant?.name || ''), rows };
}

function addMonthlySummary(workbook, { periodLabel, periodStart, periodEnd, generatedAt, keywords, source }) {
  const sheet = workbook.getWorksheet('月报主体') || workbook.addWorksheet('月报主体');
  sheet.views = [{ state: 'frozen', ySplit: 4, showGridLines: false }];
  sheet.properties.defaultRowHeight = 20;
  sheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  const widths = { A: 22, B: 13, C: 13, D: 14, E: 22, F: 13, G: 13, H: 14, I: 26, J: 13, K: 13 };
  Object.entries(widths).forEach(([column, width]) => { sheet.getColumn(column).width = width; });

  sheet.mergeCells('A1:K1');
  sheet.getCell('A1').value = `${source.tenantName || 'StarVoice'} · ${periodLabel}`;
  sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.navy } };
  sheet.getCell('A1').font = { bold: true, color: { argb: COLORS.white }, size: 18 };
  sheet.getCell('A1').alignment = { vertical: 'middle', horizontal: 'left' };
  sheet.getRow(1).height = 34;

  sheet.getCell('A2').value = '统计周期';
  sheet.mergeCells('B2:C2');
  sheet.getCell('B2').value = periodLabel;
  sheet.getCell('D2').value = '开始时间';
  sheet.getCell('E2').value = periodStart;
  sheet.getCell('F2').value = '结束时间';
  sheet.getCell('G2').value = periodEnd;
  sheet.getCell('H2').value = '导出时间';
  sheet.mergeCells('I2:K2');
  sheet.getCell('I2').value = generatedAt;
  ['E2', 'G2', 'I2'].forEach(address => { sheet.getCell(address).numFmt = 'yyyy-mm-dd hh:mm'; });
  styleRange(sheet, 'A2:K2', {
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.paleSlate } },
    font: { color: { argb: COLORS.text }, size: 10 },
  });
  ['A2', 'D2', 'F2', 'H2'].forEach(address => { sheet.getCell(address).font = { bold: true, color: { argb: COLORS.muted } }; });

  sheet.getCell('A3').value = '数据口径';
  sheet.mergeCells('B3:K3');
  sheet.getCell('B3').value = `发布时间落在本统计周期内的内容；无法识别发布时间的内容不纳入月报。关注关键词：${keywords.length ? keywords.join('、') : '全部'}。月报主体所有统计值均由“${SOURCE_SHEET}”公式计算。`;
  sheet.getCell('A3').font = { bold: true, color: { argb: COLORS.muted } };
  sheet.getCell('B3').font = { color: { argb: COLORS.muted }, italic: true };
  sheet.getCell('B3').alignment = { wrapText: true, vertical: 'middle' };
  sheet.getRow(3).height = 30;

  const rows = source.rows;
  const contentId = sourceRange('id', rows.length);
  const contentPlatform = sourceRange('platform', rows.length);
  const contentSentiment = sourceRange('sentiment', rows.length);
  const contentHandling = sourceRange('handling', rows.length);
  const contentInteractions = sourceRange('interactions', rows.length);
  const total = rows.length;
  const interactionTotal = rows.reduce((sum, row) => sum + row.interactions, 0);
  const negativeCount = rows.filter(row => row.sentiment === '负面').length;
  const handledCount = rows.filter(row => row.handling && row.handling !== '待处理').length;

  addKpi(sheet, {
    labelRange: 'A5:B5', valueRange: 'A6:B7', label: '本期内容',
    formula: `=COUNTA(${contentId})`, result: total, fill: COLORS.paleBlue,
  });
  addKpi(sheet, {
    labelRange: 'C5:E5', valueRange: 'C6:E7', label: '互动总量',
    formula: `=SUM(${contentInteractions})`, result: interactionTotal, fill: COLORS.paleBlue,
  });
  addKpi(sheet, {
    labelRange: 'F5:H5', valueRange: 'F6:H7', label: '负面内容',
    formula: `=COUNTIF(${contentSentiment},"负面")`, result: negativeCount, fill: COLORS.paleRed,
  });
  addKpi(sheet, {
    labelRange: 'I5:K5', valueRange: 'I6:K7', label: '已处理',
    formula: `=COUNTIFS(${contentHandling},"<>待处理",${contentHandling},"<>")`, result: handledCount, fill: COLORS.paleGreen,
  });

  const countBy = (key, labels) => {
    const counts = { __total: total };
    labels.forEach(label => { counts[label] = rows.filter(row => row[key] === label).length; });
    return counts;
  };
  const platformLabels = ['小红书', '抖音', '微博', '未知平台'];
  const sentimentLabels = ['正面', '中性', '负面', '待标注'];
  const handlingLabels = Object.values(HANDLING_LABELS);
  addDistributionBlock(sheet, {
    titleRange: 'A9:C9', title: '平台分布', headerRange: 'A10:C10', startRow: 11,
    labels: platformLabels, source: contentPlatform, counts: countBy('platform', platformLabels),
    denominatorCell: '$A$6', color: COLORS.blue,
  });
  addDistributionBlock(sheet, {
    titleRange: 'E9:G9', title: '情感分布', headerRange: 'E10:G10', startRow: 11,
    labels: sentimentLabels, source: contentSentiment, counts: countBy('sentiment', sentimentLabels),
    denominatorCell: '$A$6', color: COLORS.green,
  });
  addDistributionBlock(sheet, {
    titleRange: 'I9:K9', title: '处理模式分布', headerRange: 'I10:K10', startRow: 11,
    labels: handlingLabels, source: contentHandling, counts: countBy('handling', handlingLabels),
    denominatorCell: '$A$6', color: COLORS.amber,
  });

  sheet.mergeCells('A19:K20');
  sheet.getCell('A19').value = '说明：导出仅保留月报基础分析及对应的内容分诊数据源；浅蓝色统计值均为跨 Sheet 公式，可直接追溯和复核。';
  sheet.getCell('A19').alignment = { wrapText: true, vertical: 'middle' };
  sheet.getCell('A19').font = { color: { argb: COLORS.muted }, italic: true, size: 9 };
  sheet.getCell('A19').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.paleSlate } };

  forEachRangeCell(sheet, 'A1:K20', cell => {
    cell.font = { ...(cell.font || {}), name: 'Microsoft YaHei' };
  });
  return sheet;
}

export async function buildAnalyticsWorkbook({
  tenantId,
  periodStart,
  periodEnd,
  periodLabel,
  keywords = [],
  generatedAt = new Date(),
}) {
  const source = await loadContentSource({ tenantId, periodStart, periodEnd, keywords });
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'StarVoice 星语';
  workbook.created = generatedAt;
  workbook.modified = generatedAt;
  workbook.calcProperties.fullCalcOnLoad = true;
  workbook.calcProperties.forceFullCalc = true;
  workbook.calcProperties.calcMode = 'auto';

  workbook.addWorksheet('月报主体', {
    views: [{ state: 'frozen', ySplit: 4, showGridLines: false }],
  });
  addSourceSheet(workbook, source.rows);
  addMonthlySummary(workbook, {
    periodLabel,
    periodStart,
    periodEnd,
    generatedAt,
    keywords,
    source,
  });
  workbook.views = [{ activeTab: 0, firstSheet: 0 }];
  return workbook;
}
