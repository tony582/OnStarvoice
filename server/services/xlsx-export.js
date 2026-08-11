import ExcelJS from 'exceljs';

export async function sendWorkbook(res, { workbook, filename = 'export.xlsx' }) {
  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  return res.send(Buffer.from(buffer));
}

// columns: [{header, key, width}], rows: [{<key>: value}]
export async function sendXlsx(res, { sheetName = 'Sheet1', columns = [], rows = [], filename = 'export.xlsx' }) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.columns = columns;
  ws.getRow(1).font = { bold: true };
  for (const row of rows) ws.addRow(row);
  return sendWorkbook(res, { workbook: wb, filename });
}
export function fmtTs(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
