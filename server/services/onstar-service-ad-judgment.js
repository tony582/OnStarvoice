import { getRecordEvidenceSources } from './record-content-judgment.js';

export const ONSTAR_SERVICE_AD_RULE_VERSION = 'onstar-third-party-service-ad-v1';
export const ONSTAR_SERVICE_AD_PROMPT_RULES = `
- 第三方商家推广安吉星设备拆除、GPS/定位设备检测拆除、第三方安保系统加装，若主帖只有服务招揽与营销卖点，没有真实车主抱怨、明确故障或对监控品牌的贬损：sentiment=neutral、intent=other。拆除设备本身不是负面，宣传第三方服务也不是对安吉星的好评。
- “买家担心隐藏 GPS 不敢买”“定位清理提升二手车成交信任”等广告痛点，不等于作者遭遇安吉星故障、隐私侵害或提出投诉。先区分商家卖点与车主的真实经历，再判断情感。
- 例：“我们帮你拆除旧GPS、安吉星，安装GDCAB安保系统并出具检测报告。关注我们获取支持。”属于第三方服务广告，neutral + other；即使广告中说“安全、放心、增值、隐私担忧”，也不改成 positive 或 negative。
- 若商家广告夹带“安吉星偷偷监听、垃圾”等攻击，或作者引用广告表达批评、记录自己遭遇泄露/故障/收费争议/维权，仍按实际负面表达判断，不因电话号码、商家身份或拆除字样而抹掉负面。否定提供拆除服务、纯车主咨询、其他品牌广告也不能套用上述广告结论。
- 上述广告规则不改变整体相关性：整体 irrelevant 时 sentiment=null、sentimentStatus=not_applicable；关键词、评论、作者名或单独标签不能替代主帖里的服务与品牌证据。`;

const BRAND = /安吉星|(?<![a-z])on[\s-]?star(?![a-z])/i;
const SERVICE = /(?:拆除|拆卸|移除|清理|检测|排查|检查)[^。！？!?；;\n]{0,35}(?:gps|定位器|定位设备|定位系统|安吉星|on[\s-]?star)|(?:gps|定位器|定位设备|定位系统|安吉星|on[\s-]?star)[^。！？!?；;\n]{0,20}(?:拆除|拆卸|移除|清理|检测|排查|检查)|(?:安装|加装|改装)[^。！？!?；;\n]{0,20}(?:第三方安保|安保系统|防盗系统)|(?:第三方安保|安保系统|防盗系统)[^。！？!?；;\n]{0,12}(?:安装|加装|改装)/i;
// A phone number, merchant account name or an isolated "咨询" is insufficient.
const MERCHANT = /(?:我们|本店|本公司|门店|工作室|服务中心|师傅团队)[^。！？!?；;\n]{0,35}(?:帮你|帮您|为您|为你|提供|承接|拆除|拆卸|检测|排查|检查|安装|加装|服务)|(?:专业|承接|主营|提供|预约)[^。！？!?；;\n]{0,25}(?:gps|定位|安吉星|on[\s-]?star|安保|防盗)[^。！？!?；;\n]{0,20}(?:服务|拆除|拆卸|检测|排查|检查|安装|加装)|(?:欢迎|欢迎您|欢迎大家)[^。！？!?；;\n]{0,10}(?:咨询|到店|预约)|(?:关注我们|联系我们|联系本店|咨询预约|预约上门|到店咨询|预约检测|预约检查|预约拆除|预约安装)/i;
const ADVERSE = /投诉|维权|举报|受骗|被骗|被坑|忽悠|骗局|骗子|骗人|骗钱|坑钱|偷听|窃听|监听|泄露|监视|偷偷|被监控|被跟踪|强制|乱扣费|乱收费|故障|失灵|失效|失控|瘫痪|死机|误报|失败|欺骗|欺诈|黑心|恶心|一生黑|太差|真差|差劲|垃圾|鸡肋|智商税|摆设|割韭菜|坑人|骚扰|愤怒|不满|失望|自燃|漏电|亏电|耗电|不靠谱|不可靠|不安全|不可信|不放心|难用|没用|危险|不能用|无法使用|无法启动|不能启动|无法定位|不能定位|不起作用|没有响应|没响应|(?:太|真|很)烂/i;
const BRAND_ATTITUDE = /(?:安吉星|on[\s-]?star)[^。！？!?；;\n]{0,12}(?:真好|很好|好用|真棒|太棒|值得推荐|值得信赖|救了我|感谢|太贵|很贵|太烂|真烂)|(?:感谢|推荐|喜欢|讨厌|憎恨)[^。！？!?；;\n]{0,8}(?:安吉星|on[\s-]?star)/i;
const EVALUATIVE_SERVICE_NOUN = /(?:安吉星|on[\s-]?star)[^，,。！？!?；;\n]{0,8}(?:这种|这个|这样|那种|那个|就是|简直|竟然|居然)/i;
const PERSONAL_EXPERIENCE = /我是(?:安吉星|别克|凯迪拉克|雪佛兰)?车主|我(?:的车|这辆车|这台车|买的车|刚买|刚提|开了|开着|遇到|遭遇|被|花了|付了|车|找|联系|咨询|怀疑|担心|感觉|觉得|认为|不想|不愿)|本人(?:车|买|遭遇|被|花)|作为车主/i;
const QUOTED_OR_CRITICIZED = /转发|转述|引用|刷到|看到.{0,12}广告|广告(?:说|称|宣称)|有人说|号称|声称|别信|不要信|别被|不要被|这是.{0,8}广告|一则广告|这条广告|这种广告|这种商家|这些商家/i;
const NEGATED_SERVICE = /(?:不|未|没有|拒绝|无需|不用|不能|请勿|不要|别)(?:再|要|会|能|可|提供|开展|做|进行|帮您|帮你|为您|为你|我们|本店|本公司|\s){0,5}(?:拆除|拆卸|移除|安装|加装|检测|清理)|(?:不提供|不承接|不做|拒绝|无需|不要|不能)[^。！？!?；;\n]{0,20}(?:拆除|拆卸|移除|安装|加装|检测|清理)/i;
const REPORTED_EXPERIENCE = /(?:车主|用户|客户|买家)[^。！？!?；;\n]{0,8}(?:反馈|反映|表示|告诉|投诉|遭遇|遇到)|(?:已经|连续)[^。！？!?；;\n]{0,12}(?:连不上|打不开|不工作|转圈)/i;
const MARKETING_PAIN_POINT = /(?:买家|买方|客户|卖家|二手车买家|二手车交易|卖二手车时|卖车时)[^。！？!?；;\n]{0,35}(?:担心|害怕|怕|顾虑|不敢买|影响成交)/i;
const MARKETING_BENEFIT = /提升|提高|增值|信任|放心|透明|成交效率|检测报告|定位清理证明|卖得更快/i;
const HEADER = /(?:汽车|车辆|安保|定位|gps|安吉星|on[\s-]?star)[^。！？!?；;\n]{0,25}(?:服务|加装|检查|检测|拆除|拆卸)/i;
const CONTACT = /^[\s【】[\]（）()\d+—–\-·:：]+[。.!！]?$/u;

function statements(text) {
  return text.split(/(?<=[。！？!?；;\n])/u).map(value => value.trim()).filter(Boolean);
}

function allClausesAreMarketing(text, role) {
  return text.split(/[，,]/u).map(value => value.trim()).filter(Boolean).every(clause => {
    if (SERVICE.test(clause) || MERCHANT.test(clause) || CONTACT.test(clause)) return true;
    if (!BRAND.test(clause) && MARKETING_BENEFIT.test(clause)) return true;
    if (role === 'contact_or_header' && HEADER.test(clause)) return true;
    return role === 'marketing_pain_point' && !BRAND.test(clause)
      && (MARKETING_PAIN_POINT.test(clause) || /^(?:卖二手车时|卖车时|二手车交易时|在二手车交易中)$/u.test(clause));
  });
}

function validStatementRole(statement, role) {
  const text = statement.normalize('NFKC');
  // Explicit generic buyer worries are an ad pain point only when no brand is
  // accused and no actual owner experience is reported in that sentence.
  if (PERSONAL_EXPERIENCE.test(text) || REPORTED_EXPERIENCE.test(text)
    || QUOTED_OR_CRITICIZED.test(text) || /[“”‘’「」『』"']/.test(text)) return false;
  // A service phrase cannot cover an independent comma-separated attack such
  // as "本店提供拆除服务，这东西就是交钱买个摆设，欢迎咨询".
  if (!allClausesAreMarketing(text, role)) return false;
  if (role === 'marketing_pain_point') return MARKETING_PAIN_POINT.test(text) && !BRAND.test(text);
  if (ADVERSE.test(text) || BRAND_ATTITUDE.test(text) || EVALUATIVE_SERVICE_NOUN.test(text) || NEGATED_SERVICE.test(text)) return false;
  if (role === 'service_offer') return SERVICE.test(text);
  if (role === 'marketing_benefit') return !BRAND.test(text) && MARKETING_BENEFIT.test(text);
  if (role === 'call_to_action') return MERCHANT.test(text);
  if (role === 'contact_or_header') return CONTACT.test(text) || HEADER.test(text);
  return false;
}

function validatedAdStatements(result, sources) {
  const classification = object(result.servicePromotion);
  if (classification.type !== 'third_party_service_ad' || classification.speaker !== 'merchant'
    || classification.brandEvaluation !== 'none' || !Array.isArray(classification.statements)
    || !classification.statements.length || classification.statements.length > 20) return null;
  const actual = sources.flatMap(({ source, text }) => statements(text).map(quote => ({ source, quote })));
  // Every current source sentence must be accounted for. A real complaint
  // outside the quoted service offer cannot disappear from this decision.
  if (!actual.length || actual.length > 20 || actual.reduce((size, item) => size + item.quote.length, 0) > 6000
    || actual.some(item => !classification.statements.some(claim => claim?.source === item.source && claim?.quote === item.quote))) return null;
  const validated = [];
  for (const claim of classification.statements) {
    if (typeof claim?.quote !== 'string' || !claim.quote || claim.quote.length > 400
      || !actual.some(item => item.source === claim?.source && item.quote === claim?.quote)
      || !validStatementRole(claim.quote, claim.role)) return null;
    validated.push({ source: claim.source, quote: claim.quote, role: claim.role });
  }
  if (!validated.some(item => item.role === 'service_offer')) return null;
  // When the model supplies concrete negative evidence, only verified ad
  // sentences may explain it; an extra independent claim cancels the override.
  for (const raw of Array.isArray(result.evidence) ? result.evidence : []) {
    const quote = typeof raw === 'string' ? raw.trim() : '';
    if (quote && sources.some(item => item.text.includes(quote)) && !validated.some(item => item.quote.includes(quote))) return null;
  }
  return validated;
}

function object(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try { const parsed = JSON.parse(String(value || '{}')); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
}

function sourceMatch(sources, pattern) {
  for (const { source, text } of sources) {
    // Preserve the complete sentence and its original spelling for auditing.
    const sentence = text.split(/(?<=[。！？!?；;\n])/u).find(value => pattern.test(value.normalize('NFKC')));
    if (sentence) return { source, quote: sentence.trim() };
  }
  return null;
}

export function findOnstarServiceAdEvidence(record = {}, result = {}) {
  const sources = getRecordEvidenceSources(record);
  const verifiedStatements = validatedAdStatements(result, sources);
  if (!verifiedStatements) return null;
  const brand = sourceMatch(sources, BRAND);
  const service = sourceMatch(sources, SERVICE);
  const offer = sourceMatch(sources, MERCHANT);
  return brand && service && offer ? { brand, service, offer, statements: verifiedStatements } : null;
}

// Intentionally narrow: actual source evidence is required even when a model
// confidently calls a post an ad. Unmatched posts keep the model's judgment.
export function normalizeOnstarServiceAdJudgment(result = {}, record = {}, modelResult = result) {
  // This audit block is server-owned, never a claim supplied by the model.
  if (Object.hasOwn(result, 'serviceAdJudgment')) {
    result = { ...result };
    delete result.serviceAdJudgment;
  }
  if (!['relevant', 'uncertain'].includes(result.relevance)) return result;
  const evidence = findOnstarServiceAdEvidence(record, modelResult);
  if (!evidence) return result;
  const manual = object(record.manual_overrides);
  const manualSentimentProtected = Object.hasOwn(manual, 'sentiment');
  return {
    ...result,
    sentiment: manualSentimentProtected ? String(record.sentiment || '') : 'neutral',
    sentimentStatus: manualSentimentProtected && !record.sentiment ? result.sentimentStatus : 'classified',
    intent: 'other',
    intentReason: '主帖为第三方定位设备拆检或安保加装服务招揽，没有对安吉星的实际褒贬。',
    summary: '商家推广定位设备拆检或第三方安保加装服务',
    serviceAdJudgment: {
      version: ONSTAR_SERVICE_AD_RULE_VERSION,
      rule: 'main_post_third_party_service_offer',
      reason: '模型明确识别第三方商家服务广告且无品牌褒贬；逐字证据覆盖当前主帖所有有效句子，每句均核验为服务说明或营销表达，另核验安吉星与商家招揽证据。',
      evidence,
      sentimentApplied: !manualSentimentProtected,
      intentApplied: true,
      manualSentimentProtected,
      originalModel: {
        relevance: modelResult.relevance ?? null,
        sentiment: modelResult.sentiment ?? null,
        sentimentStatus: modelResult.sentimentStatus ?? null,
        intent: modelResult.intent ?? null,
        intentReason: modelResult.intentReason ?? null,
        summary: modelResult.summary ?? null,
      },
    },
  };
}
