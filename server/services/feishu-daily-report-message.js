import {
  CUSTOMER_DAILY_SECTIONS,
  customerDailyPostPlatform,
  customerDailyPostComparison,
  customerDailyColdEmpty,
} from './customer-daily-report-presentation.js';

// Feishu caps the complete serialized post request at 30 KB. Reserve room for
// the receiving chat ID, UUID and API-side formatting, including on preflight.
export const FEISHU_DAILY_POST_MAX_BYTES = 28 * 1024;
export const FEISHU_DAILY_POST_IMAGE_PLACEHOLDER = `img_preflight_${'0'.repeat(242)}`;

function oneLine(value, fallback = '', limit = 180) {
  const clean = String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim() || fallback;
  const characters = Array.from(clean);
  return characters.length > limit ? `${characters.slice(0, limit - 1).join('')}…` : clean;
}

function safeUrl(value) {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f-\u009f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && url.href.length <= 8000 ? url.href : null;
  } catch { return null; }
}

function nonNegativeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function heatLabel(post) {
  return nonNegativeInteger(post.heat) ? String(post.heat) : '待核实';
}

function comparisonLabel(post) {
  const value = oneLine(customerDailyPostComparison(post), '较昨日 暂无对比', 100).replace(/^较昨日\s*/, '');
  const percent = value.match(/^([↑↓])(\d+(?:\.\d+)?)%$/);
  if (percent) {
    const number = Number(percent[2]);
    if (Number.isFinite(number) && number <= Number.MAX_SAFE_INTEGER && (percent[1] !== '↓' || number <= 100)) return `较昨日 ${value}`;
  }
  const fromZero = value.match(/^由0增至(\d+)$/);
  if (fromZero && nonNegativeInteger(Number(fromZero[1]))) return `较昨日 ${value}`;
  return ['持平', '暂无对比', '暂无可比数据', '暂无昨日数据', '暂无本日数据'].includes(value)
    ? `较昨日 ${value}` : '较昨日 暂无对比';
}

const text = value => ({ tag: 'text', text: value });
const heading = value => [{ ...text(value), style: ['bold'] }];

function postLine(post, index, heat) {
  const item = post && typeof post === 'object' ? post : {};
  const title = oneLine(item.title, '未命名帖子');
  const url = safeUrl(item.url);
  const nodes = [text(heat ? `TOP${index + 1}：` : `${index + 1}、`),
    url ? { tag: 'a', text: title, href: url } : text(`${title}（原帖链接待补）`),
    text(` - ${oneLine(customerDailyPostPlatform(item), '未知平台', 40)}`)];
  if (heat) nodes.push(text(` | 热度 ${heatLabel(item)} | ${comparisonLabel(item)}`));
  return nodes;
}

/** Conservative byte count of the final app API request, after serializing content. */
export function feishuDailyPostRequestBytes(post) {
  return Buffer.byteLength(JSON.stringify({
    receive_id: 'x'.repeat(256),
    msg_type: 'post',
    content: JSON.stringify(post),
    uuid: 'x'.repeat(50),
  }), 'utf8');
}

/** Pure builder. An omitted imageKey is for size preflight only; senders must
 * provide a real uploaded image key and must never send the placeholder. */
export function buildFeishuDailyPost({ snapshot, imageKey, documentUrl }) {
  if (!snapshot || typeof snapshot !== 'object') throw new TypeError('日报数据无效');
  const document = safeUrl(documentUrl);
  if (!document) throw new TypeError('日报文档链接无效');
  const image = imageKey === undefined || imageKey === null || imageKey === '' ? FEISHU_DAILY_POST_IMAGE_PLACEHOLDER : imageKey;
  if (typeof image !== 'string' || image.length > 256 || !/^img_[A-Za-z0-9_-]+$/.test(image)) throw new TypeError('日报图片标识无效');
  const heat = Array.isArray(snapshot.highHeat) ? snapshot.highHeat : [];
  const cold = Array.isArray(snapshot.coldMarked) ? snapshot.coldMarked : [];
  const title = `${oneLine(snapshot.tenantName, '客户', 80)} · 舆情日报 ${oneLine(snapshot.reportDate, '', 20)}`.trim();

  function build(heatCount, coldCount) {
    const content = [[{ tag: 'img', image_key: image }], heading(CUSTOMER_DAILY_SECTIONS.heat)];
    if (!heat.length) content.push([text('暂未检出符合条件的帖子。')]);
    for (let index = 0; index < heatCount; index++) content.push(postLine(heat[index], index, true));
    if (heatCount < heat.length) content.push([text(`另有 ${heat.length - heatCount} 条高热负面帖子，见底部完整日报。`)]);
    content.push(heading(CUSTOMER_DAILY_SECTIONS.cold));
    if (!cold.length) content.push([text(customerDailyColdEmpty(snapshot))]);
    for (let index = 0; index < coldCount; index++) content.push(postLine(cold[index], index, false));
    if (coldCount < cold.length) content.push([text(`另有 ${cold.length - coldCount} 条冷处理负面帖子，见底部完整日报。`)]);
    content.push([{ tag: 'a', text: '打开完整日报（可编辑）', href: document }]);
    return { zh_cn: { title, content } };
  }

  // Reserve at least one item in each nonempty section before filling the
  // remaining budget in turn. A long first section cannot hide the second.
  let heatCount = Math.min(1, heat.length);
  let coldCount = Math.min(1, cold.length);
  let result = build(heatCount, coldCount);
  if (feishuDailyPostRequestBytes(result) > FEISHU_DAILY_POST_MAX_BYTES) throw new RangeError('日报首条内容过长，无法完整展示两部分');
  let heatDone = heatCount === heat.length;
  let coldDone = coldCount === cold.length;
  while (!heatDone || !coldDone) {
    if (!heatDone) {
      const candidate = build(heatCount + 1, coldCount);
      if (feishuDailyPostRequestBytes(candidate) <= FEISHU_DAILY_POST_MAX_BYTES) { heatCount++; result = candidate; }
      else heatDone = true;
      heatDone ||= heatCount === heat.length;
    }
    if (!coldDone) {
      const candidate = build(heatCount, coldCount + 1);
      if (feishuDailyPostRequestBytes(candidate) <= FEISHU_DAILY_POST_MAX_BYTES) { coldCount++; result = candidate; }
      else coldDone = true;
      coldDone ||= coldCount === cold.length;
    }
  }
  return result;
}
