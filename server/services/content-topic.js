// Independent of relevance, triage status and the legacy issue category.
export const CONTENT_TOPIC_VERSION = 'saic-gm-content-topic-v3';
export const CONTENT_TOPIC_LABELS = Object.freeze({
  onstar: '安吉星',
  infotainment: '车机',
  wallpaper: '壁纸',
  brand_app: '品牌APP',
  sentry: '哨兵',
  gm_customer_service: '上汽通用客服',
  gm_other: '其它通用相关',
});

export function normalizeContentTopic(value) {
  if (typeof value !== 'string') return null;
  const topic = value.trim().toLowerCase();
  return Object.hasOwn(CONTENT_TOPIC_LABELS, topic) ? topic : null;
}

export function contentTopicLabel(value) {
  return CONTENT_TOPIC_LABELS[normalizeContentTopic(value)] || '主题生成中';
}

// Preserve old saved filters while exposing only the seven customer topics.
export function appendContentTopicFilter(where, params, value) {
  if (value === undefined || value === '') return where;
  if (value === 'unclassified') return `${where} AND r.content_topic IS NULL`;
  const topic = normalizeContentTopic(value);
  if (!topic) {
    const error = new Error('内容主题无效');
    error.status = 400;
    error.code = 'invalid_content_topic';
    throw error;
  }
  params.push(topic);
  return `${where} AND r.content_topic = $${params.length}`;
}

export const CONTENT_TOPIC_PROMPT_RULES = `
第四步独立判断 contentTopic（内容主题），只依据主帖标题、正文及已提供的可信媒体逐字稿，按主要讨论对象单选：
先核对讨论对象属于谁：六个具体主题必须有主帖证据指向安吉星、别克、凯迪拉克、雪佛兰或其明确车型/产品。其它品牌、品牌无法确认、只有哨兵/APP/OTA/壁纸等通用词时，一律选择 gm_other；不得用采集关键词推断品牌。车型简称可结合上下文识别，不能仅因缺少完整品牌名就排除。
- onstar（安吉星）：安吉星功能和服务、安吉星APP、安吉星客服、使用问题、救援、套餐续费等。
- infotainment（车机）：上汽通用旗下车辆的车机系统、OTA、车机升级、车机故障和使用问题。
- wallpaper（壁纸）：上汽通用旗下车辆的壁纸、主题、壁纸安装/更换/使用体验。
- brand_app（品牌APP）：别克/凯迪拉克/雪佛兰品牌APP、iBuick、别克远控等；安吉星APP归 onstar。
- sentry（哨兵）：别克/至境等上汽通用车辆的哨兵、驻车监控使用问题、功能咨询和体验分享。
- gm_customer_service（上汽通用客服）：主要投诉、评价或咨询上汽通用或旗下别克/凯迪拉克/雪佛兰客服，核心诉求是客服响应、态度或处理过程；安吉星客服归 onstar。
- gm_other（其它通用相关）：上述六类之外的统一兜底，包括购车、促销、机械质量、经销商售后、能耗、充电、品牌讨论，以及客户确认的“监控范围外”内容。完全无关、仅关键词或标签命中、信息不足以确认具体主题的内容，也使用此兜底，不另设“未分类”。这只是主题归档，不代表确认其与上汽通用相关；relevance 等判断保持独立。上汽通用不等于上汽集团、上汽通用五菱或其它车企，其它品牌不得误归上述六个具体主题。
contentTopic 必须且只能从上述七个值中选择一个，不得输出 null、空字符串、未分类或多选。
多主题择主：先看作者核心诉求/希望解决的问题，再看主要评价或情绪指向；仍有并列时看标题重心，再看正文论述篇幅。选择最能概括主帖的一类，不能按固定类目优先级、采集关键词或词频机械决定。承载平台、故障诱因、联系渠道和背景不覆盖核心对象。
校准：别克OTA后壁纸消失且主要求恢复壁纸→wallpaper；别克OTA后整个车机黑屏→infotainment；别克哨兵录像在车机打不开且主要问哨兵录像→sentry；车机黑屏且顺带提到联系客服未解决→infotainment；主要投诉别克客服敷衍拖延→gm_customer_service；安吉星APP闪退/安吉星客服误导续费→onstar；iBuick远控失败→brand_app；别克变速箱故障→gm_other。
范围校准：特斯拉哨兵/吉利APP故障/问附近谁有哨兵录像但未说明车型/通用手机壁纸→gm_other；昂科威PLUS哨兵→sentry；CT5壁纸→wallpaper。别克售后账号日常宣传、门店广告、保养维修分享，只提“售后/服务真香”而没有客服响应、态度或处理过程的具体诉求→gm_other；不能仅凭“客服/售后”标签选择 gm_customer_service。
contentTopic 与 relevance、sentiment、intent、category、处理状态各自独立。不得为了填写主题改变其它判断，relevance=irrelevant 也可能是 gm_other；“监控范围外”不是主题为空的充分理由。contentTopicReason 用不超过80字说明核心对象和择主依据。
`;
