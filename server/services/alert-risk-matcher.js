const CONTEXTUAL_DANGER_PATTERNS = {
  安全: [
    /不安全/u,
    /安全.{0,8}(问题|隐患|事故|风险|漏洞|缺陷|故障|失效|失灵|威胁|堪忧|担忧|争议|危机)/u,
    /(危及|影响|威胁|损害).{0,8}安全/u,
    /(存在|出现|发现|引发|导致|造成|担心|质疑).{0,8}安全.{0,8}(问题|隐患|风险)/u,
    /安全性.{0,5}(差|低|不足|堪忧|存疑|有问题)/u,
  ],
  隐私: [
    /隐私.{0,8}(泄露|暴露|窃取|侵犯|侵权|滥用|风险|问题|漏洞|担忧|堪忧|争议|失效)/u,
    /(泄露|暴露|窃取|侵犯|侵害|滥用).{0,8}隐私/u,
    /(存在|出现|发现|引发|导致|造成|担心|质疑).{0,8}隐私.{0,8}(问题|风险|漏洞)/u,
  ],
};

function normalizedText(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase();
}

function matchesContextualDangerKeyword(text, keyword) {
  const patterns = CONTEXTUAL_DANGER_PATTERNS[keyword];
  if (!patterns) return text.includes(keyword);
  return patterns.some(pattern => pattern.test(text));
}

/**
 * “安全”“隐私”等宽泛词只有在明确风险语境中才构成高危信号。
 * 其它由租户主动配置的具体危险短语仍按字面命中。
 */
export function matchDangerKeywords(text, keywords = []) {
  const normalized = normalizedText(text);
  const uniqueKeywords = [...new Set(
    (Array.isArray(keywords) ? keywords : [])
      .map(keyword => normalizedText(keyword).trim())
      .filter(Boolean),
  )];

  return uniqueKeywords.filter(keyword => matchesContextualDangerKeyword(normalized, keyword));
}
