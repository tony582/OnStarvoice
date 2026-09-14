export const serviceAdScreenshot = '济南钢城区汽车安保系统加装检查。【191-5315-9289】拆除gps定位器。卖二手车时，客户担心有隐藏GPS不敢买？影响成交效率。卖家提供定位清理证明能提升信任。我们帮你拆除旧GPS、安吉星，安装GDCAB安保系统并出具检测报告。服务透明让买家放心，GDCAB可作为增值服务。想让二手车卖得更快？关注我们获取支持。#GPS检测拆除设备 #车载GPS屏蔽公司 #车载定位拆除检查 #拆汽车定位设备 #汽车GPS检测检查';
export const screenshotAdRoles = ['contact_or_header', 'service_offer', 'marketing_pain_point', 'marketing_benefit', 'marketing_benefit', 'service_offer', 'marketing_benefit', 'marketing_benefit', 'call_to_action'];

// Synthetic model output, not a live-model accuracy assertion. Explicit role
// arrays below represent the independent semantic judgment under test.
export function servicePromotionFixture(record, roles = []) {
  const claims = ['title', 'content', 'transcript'].flatMap(source => String(record[source] || '')
    .replace(/[#＃][^#＃\s，。！？,!?;；]+/gu, ' ')
    .split(/(?<=[。！？!?；;\n])/u).map(quote => quote.trim()).filter(Boolean).map(quote => ({ source, quote })));
  return { type: 'third_party_service_ad', speaker: 'merchant', brandEvaluation: 'none',
    statements: claims.map((claim, index) => ({ ...claim, role: roles[index] || 'service_offer' })) };
}
