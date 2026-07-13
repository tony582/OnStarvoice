const CN_REGIONS = [
  '北京', '天津', '上海', '重庆', '河北', '山西', '辽宁', '吉林', '黑龙江',
  '江苏', '浙江', '安徽', '福建', '江西', '山东', '河南', '湖北', '湖南',
  '广东', '海南', '四川', '贵州', '云南', '陕西', '甘肃', '青海', '台湾',
  '内蒙古', '广西', '西藏', '宁夏', '新疆', '香港', '澳门',
];

export function extractPublishLocation(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';

  const tokens = text.split(' ').filter(Boolean);
  const last = tokens[tokens.length - 1] || '';
  if (CN_REGIONS.includes(last)) return last;

  for (const region of CN_REGIONS) {
    if (text.includes(region)) return region;
  }

  if (/^[\u4e00-\u9fa5]{2,6}$/.test(last) && !/(编辑|发布|今天|昨天|前天|周|月|日|前|刚刚)/.test(last)) {
    return last;
  }

  return '';
}

export function stripPublishLocation(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const location = extractPublishLocation(text);
  if (!location) return text;
  const escaped = location.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`\\s*${escaped}\\s*$`), '').trim();
}
