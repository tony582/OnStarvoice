import {fileURLToPath} from 'node:url';
import {Resvg} from '@resvg/resvg-js';
import {customerDailySummaryRows, customerDailySummaryHeaders, isMonthlyDailyReport} from './customer-daily-report-presentation.js';

const FONT = fileURLToPath(new URL('../assets/daily-report/StarVoiceDailyTable.ttf', import.meta.url));
const LEGACY_WIDTHS = [160, 180, 160, 130, 130, 170, 175, 175];
const HEADER = 52;
const ROW = 62;
const esc = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));

export function renderCustomerDailySummarySvg(snapshot) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot?.reportDate || '') || !snapshot.summary?.day || !snapshot.summary?.mtd) {
    throw new Error('日报汇总尚未就绪');
  }
  const rows = customerDailySummaryRows(snapshot);
  const modern = isMonthlyDailyReport(snapshot);
  const WIDTHS = modern ? [190, 180, 155, 100, 100, 200, 245, 280, 190] : LEGACY_WIDTHS;
  const WIDTH = WIDTHS.reduce((sum, value) => sum + value, 0);
  const headerHeight = modern ? 84 : HEADER * 2;
  const HEIGHT = headerHeight + ROW * rows.length;
  if (rows.some(row => row.slice(1).some(value => value !== null && (!Number.isSafeInteger(value) || value < 0)))) {
    throw new Error('日报汇总数值无效');
  }
  const xs = WIDTHS.map((_, index) => WIDTHS.slice(0, index).reduce((sum, value) => sum + value, 0));
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH + 2}" height="${HEIGHT + 2}" viewBox="0 0 ${WIDTH + 2} ${HEIGHT + 2}"><rect width="100%" height="100%" fill="white"/><g transform="translate(1 1)">`];
  const cell = (x,y,width,height,value,head=false) => {
    const string = value === null ? '' : String(value);
    const size = Math.min(head ? 29 : 31, (width - 24) / Math.max(1,[...string].reduce((sum,char) => sum + (/[^\x00-\xff]/.test(char) ? 1 : 0.62),0)));
    parts.push(`<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${head ? '#15171a' : '#ffffff'}" stroke="${head ? '#59616c' : '#aab1b9'}" stroke-width="1.5"/>`);
    if (string) parts.push(`<text x="${x+width/2}" y="${y+height/2+size*0.36}" text-anchor="middle" font-family="StarVoice Daily Table" font-size="${size}" fill="${head ? '#ffffff' : '#161b22'}">${esc(string)}</text>`);
  };
  if (modern) customerDailySummaryHeaders(snapshot).forEach((title,i)=>cell(xs[i],0,WIDTHS[i],headerHeight,title,true));
  else {
  ['日期','监控数量','SDB范畴','正向','中性'].forEach((title,i)=>cell(xs[i],0,WIDTHS[i],HEADER*2,title,true));
  cell(xs[5],0,WIDTHS.slice(5).reduce((a,b)=>a+b,0),HEADER,'负面',true);
  ['冷处理','处理中','已处理'].forEach((title,i)=>cell(xs[i+5],HEADER,WIDTHS[i+5],HEADER,title,true));
  }
  rows.forEach((row,i)=>row.forEach((value,j)=>cell(xs[j],headerHeight+i*ROW,WIDTHS[j],ROW,value)));
  parts.push('</g></svg>');
  return parts.join('');
}

export function renderCustomerDailySummaryPng(snapshot) {
  // All text is fixed headings, numeric dates and counts; never render remote resources.
  const rendered = new Resvg(renderCustomerDailySummarySvg(snapshot), {
    font:{fontFiles:[FONT],loadSystemFonts:false,defaultFontFamily:'StarVoice Daily Table'},
  }).render();
  return Buffer.from(rendered.asPng());
}
