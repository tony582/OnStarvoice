/**
 * 把采集到的"发布时间原始串"解析成可排序的时间戳。
 * 支持:绝对日期(2026-06-01 / 2026/6/1 / 6月1日)、MM-DD(按采集年份,跨年回退)、
 *       相对(N分钟/小时/天/周/月/年前、刚刚/今天/昨天/前天)、小红书"编辑于 01-01 山东"。
 * 解析不了返回 fallback(通常传采集时间 created_at/captured_at)。
 */
// 统一显示用:把原始发布时间串规范化成 "YYYY-MM-DD"(没年份的 M-D 按采集年份补;相对时间按采集时刻往前算)。解析不了返回 ''。
export function formatPublishDate(raw, fallback = null) {
  // 原始串为空 = 没采到发布时间,返回 ''(前端出「—」),不回落成采集时间冒充发布
  if (!String(raw || '').trim()) return '';
  const d = parsePublishTimestamp(raw, fallback);
  if (!d || Number.isNaN(d.getTime())) return '';
  // en-CA + Asia/Shanghai 输出即 YYYY-MM-DD,避免 UTC 服务器把临近午夜的时间错位一天
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// 发布时间不可能晚于采集时刻(没采集时刻则用当前),+2天容差:出现未来时间多是抓到正文里的
// 活动/投票/上线日期等污染,判为不可信(让上层显示「—」而非假的未来日期)。
function isFuturePublish(d, fbValid) {
  const ref = fbValid ? fbValid.getTime() : Date.now();
  return d.getTime() > ref + 2 * 86400000;
}

export function parsePublishTimestamp(raw, fallback = null) {
  const fb = fallback ? new Date(fallback) : null;
  const fbValid = fb && !Number.isNaN(fb.getTime()) ? fb : null;
  let t = String(raw || '').trim();
  if (!t) return fbValid;

  // 去前后缀:编辑于/发布于/更新于 + 末尾 IP 属地(中文 2-6 字)
  t = t.replace(/^(编辑于|发布于|更新于|发表于|来自)\s*/u, '').trim();

  // 相对时间(相对采集时刻)
  const rel = t.match(/(\d+)\s*(分钟|分|小时|时|天|周|个月|月|年)前/u);
  if (rel && fbValid) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const d = new Date(fbValid);
    if (unit === '分钟' || unit === '分') d.setMinutes(d.getMinutes() - n);
    else if (unit === '小时' || unit === '时') d.setHours(d.getHours() - n);
    else if (unit === '天') d.setDate(d.getDate() - n);
    else if (unit === '周') d.setDate(d.getDate() - n * 7);
    else if (unit === '个月' || unit === '月') d.setMonth(d.getMonth() - n);
    else if (unit === '年') d.setFullYear(d.getFullYear() - n);
    return d;
  }
  if (/^(刚刚|今天)/u.test(t)) return fbValid;
  if (/^昨天/u.test(t) && fbValid) { const d = new Date(fbValid); d.setDate(d.getDate() - 1); return d; }
  if (/^前天/u.test(t) && fbValid) { const d = new Date(fbValid); d.setDate(d.getDate() - 2); return d; }

  // 绝对:YYYY-MM-DD(及 / . 年月 分隔,可带时分)
  const ymd = t.match(/(20\d{2})[\-/.年](\d{1,2})[\-/.月](\d{1,2})(?:[日]?\s+(\d{1,2}):(\d{2}))?/u);
  if (ymd) {
    const d = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]), Number(ymd[4] || 0), Number(ymd[5] || 0));
    if (!Number.isNaN(d.getTime())) return isFuturePublish(d, fbValid) ? null : d;
  }
  // 仅 MM-DD:按采集年份,若解析出的日期晚于采集时刻则回退一年(跨年)
  const md = t.match(/(?:^|\s)(\d{1,2})[\-/.月](\d{1,2})[日]?/u);
  if (md) {
    const year = fbValid ? fbValid.getFullYear() : new Date().getFullYear();
    const d = new Date(year, Number(md[1]) - 1, Number(md[2]));
    if (!Number.isNaN(d.getTime())) {
      if (fbValid && d.getTime() > fbValid.getTime() + 86400000) d.setFullYear(d.getFullYear() - 1);
      return d;
    }
  }
  // 兜底:Date.parse
  const p = Date.parse(t);
  if (!Number.isNaN(p)) { const pd = new Date(p); return isFuturePublish(pd, fbValid) ? null : pd; }
  return fbValid;
}
