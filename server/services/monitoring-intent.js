export const MONITORING_INTENT_VERSION = 2;

const VEHICLE_TOPIC_EXCLUSIONS = [
  '与当前功能无关的车辆机械故障',
  '与当前功能无关的车型销量或品牌经营',
  '与当前功能无关的碰撞测试、外观、内饰、胎噪、底盘或车漆',
  '只出现车型或品牌名称但没有当前功能主题',
];

const KEYWORD_INTENTS = [
  {
    keys: ['别克壁纸'],
    slug: 'buick-wallpaper',
    objective: 'content_discovery',
    targetEntity: ['别克', 'Buick'],
    targetContent: ['车机壁纸', '手机壁纸', '电脑壁纸', '屏保', '主题资源'],
    exclusions: [...VEHICLE_TOPIC_EXCLUSIONS, '与壁纸或主题资源无关的别克车型内容'],
    notes: '发现和采集别克相关壁纸、屏保或主题资源；内容可以是正面、中性或负面。',
  },
  {
    keys: ['凯迪拉克壁纸'],
    slug: 'cadillac-wallpaper',
    objective: 'content_discovery',
    targetEntity: ['凯迪拉克', 'Cadillac'],
    targetContent: ['车机壁纸', '手机壁纸', '电脑壁纸', '屏保', '主题资源'],
    exclusions: [...VEHICLE_TOPIC_EXCLUSIONS, '与壁纸或主题资源无关的凯迪拉克车型内容'],
    notes: '发现和采集凯迪拉克相关壁纸、屏保或主题资源；内容可以是正面、中性或负面。',
  },
  {
    keys: ['安吉星'],
    slug: 'onstar',
    objective: 'service_monitoring',
    targetEntity: ['安吉星', 'OnStar', '上汽通用安吉星', '通用安吉星'],
    targetContent: ['安吉星产品与服务', '车联网', '远程控制', '道路或紧急救援', '续费套餐', '安吉星App与车机服务'],
    exclusions: [...VEHICLE_TOPIC_EXCLUSIONS, '只用安吉星作为无关话题标签且正文评价其它品牌或产品'],
    notes: '监控安吉星产品和服务本身；关联车型品牌不自动属于安吉星监控范围。',
  },
  {
    keys: ['上汽通用客服'],
    slug: 'saic-gm-customer-service',
    objective: 'service_monitoring',
    targetEntity: ['上汽通用客服', '上汽通用官方客服', '上汽通用客户服务'],
    targetContent: ['官方客服体验', '投诉受理', '客户问题处理', '客服沟通与响应'],
    exclusions: [...VEHICLE_TOPIC_EXCLUSIONS, '未指向上汽通用官方客服的普通经销商或维修门店体验'],
    notes: '只监控上汽通用官方客服与客户问题处理，不把所有4S店或维修体验自动纳入。',
  },
  {
    keys: ['别克哨兵'],
    slug: 'buick-sentry',
    objective: 'feature_monitoring',
    targetEntity: ['别克', 'Buick'],
    targetContent: ['哨兵模式', '驻车监控', '车辆安防监控', '哨兵功能使用、咨询或故障'],
    exclusions: [...VEHICLE_TOPIC_EXCLUSIONS, '与哨兵或驻车监控无关的别克车辆问题'],
    notes: '必须同时涉及别克和哨兵/驻车监控主题。',
  },
  {
    keys: ['至境哨兵'],
    slug: 'buick-electra-sentry',
    objective: 'feature_monitoring',
    targetEntity: ['至境', '别克至境'],
    targetContent: ['哨兵模式', '驻车监控', '车辆安防监控', '哨兵功能使用、咨询或故障'],
    exclusions: [...VEHICLE_TOPIC_EXCLUSIONS, '与哨兵或驻车监控无关的至境车型体验'],
    notes: '必须同时涉及至境车型和哨兵/驻车监控主题。',
  },
  {
    keys: ['ibuick', '别克app'],
    slug: 'ibuick-app',
    objective: 'feature_monitoring',
    targetEntity: ['iBuick', '别克App', '别克客户端'],
    targetContent: ['App登录与绑定', 'App车辆服务', 'App稳定性', 'App功能与使用体验'],
    exclusions: [...VEHICLE_TOPIC_EXCLUSIONS, '未涉及iBuick或别克App的车辆、门店或售后内容'],
    notes: '监控iBuick/别克App本身，不把普通别克品牌内容自动纳入。',
  },
  {
    keys: ['别克远控'],
    slug: 'buick-remote-control',
    objective: 'feature_monitoring',
    targetEntity: ['别克', 'Buick', 'iBuick'],
    targetContent: ['远程启动', '远程解锁或上锁', '远程空调', '车辆远程控制功能与故障'],
    exclusions: [...VEHICLE_TOPIC_EXCLUSIONS, '未明确涉及别克或iBuick的安吉星、其它品牌或泛行业远程锁车话题'],
    notes: '必须有别克/iBuick与远程控制之间的直接联系；安吉星或相似功能不能代替别克实体证据。',
  },
  {
    keys: ['别克车机'],
    slug: 'buick-infotainment',
    objective: 'feature_monitoring',
    targetEntity: ['别克', 'Buick'],
    targetContent: ['车机系统', '车机应用', '车机网络与流量', '车机交互、账号、导航或娱乐功能'],
    exclusions: [...VEHICLE_TOPIC_EXCLUSIONS, '与车机系统无关的别克车辆问题'],
    notes: '必须同时涉及别克和车机系统主题。',
  },
  {
    keys: ['凯迪拉克车机'],
    slug: 'cadillac-infotainment',
    objective: 'feature_monitoring',
    targetEntity: ['凯迪拉克', 'Cadillac'],
    targetContent: ['车机系统', '车机应用', '车机网络与流量', '车机交互、账号、导航或娱乐功能'],
    exclusions: [...VEHICLE_TOPIC_EXCLUSIONS, '与车机系统无关的凯迪拉克车辆问题'],
    notes: '必须同时涉及凯迪拉克和车机系统主题。',
  },
  {
    keys: ['别克ota'],
    slug: 'buick-ota',
    objective: 'feature_monitoring',
    targetEntity: ['别克', 'Buick'],
    targetContent: ['OTA升级', '软件或固件版本', '升级内容', '升级失败、升级体验或升级建议'],
    exclusions: [...VEHICLE_TOPIC_EXCLUSIONS, '与OTA或软件升级无关的别克车辆问题'],
    notes: '必须同时涉及别克和OTA/软件升级主题。',
  },
  {
    keys: ['凯迪拉克ota'],
    slug: 'cadillac-ota',
    objective: 'feature_monitoring',
    targetEntity: ['凯迪拉克', 'Cadillac'],
    targetContent: ['OTA升级', '软件或固件版本', '升级内容', '升级失败、升级体验或升级建议'],
    exclusions: [...VEHICLE_TOPIC_EXCLUSIONS, '与OTA或软件升级无关的凯迪拉克车辆问题'],
    notes: '必须同时涉及凯迪拉克和OTA/软件升级主题。',
  },
];

function boundedText(value, maxLength = 500) {
  return String(value ?? '').trim().slice(0, maxLength);
}

export function normalizeMonitoringKeyword(value) {
  return boundedText(value, 200)
    .normalize('NFKC')
    .replace(/\s+/gu, '')
    .toLocaleLowerCase();
}

function cloneIntent(rule, keyword) {
  return {
    intentId: `monitoring-topic:${rule.slug}`,
    intentVersion: MONITORING_INTENT_VERSION,
    keyword: boundedText(keyword, 200),
    objective: rule.objective,
    targetEntity: [...rule.targetEntity],
    targetContent: [...rule.targetContent],
    exclusions: [...rule.exclusions],
    notes: rule.notes,
    source: 'server_keyword_standard',
  };
}

export function resolveMonitoringIntent(keyword, { brand = {}, fallbackIntent = null } = {}) {
  const normalizedKeyword = normalizeMonitoringKeyword(keyword);
  const matchedRule = KEYWORD_INTENTS.find(rule =>
    rule.keys.some(key => normalizeMonitoringKeyword(key) === normalizedKeyword)
  );
  if (matchedRule) return cloneIntent(matchedRule, keyword);

  const fallback = fallbackIntent && typeof fallbackIntent === 'object' && !Array.isArray(fallbackIntent)
    ? fallbackIntent
    : {};
  const fallbackEntities = Array.isArray(fallback.targetEntity) ? fallback.targetEntity.filter(Boolean) : [];
  const fallbackContent = Array.isArray(fallback.targetContent) ? fallback.targetContent.filter(Boolean) : [];
  const fallbackExclusions = Array.isArray(fallback.exclusions) ? fallback.exclusions.filter(Boolean) : [];
  const brandEntities = [brand.brandName, ...(brand.brandAliases || [])].map(value => boundedText(value, 80)).filter(Boolean);
  return {
    intentId: boundedText(fallback.intentId, 200) || `monitoring-keyword:${normalizedKeyword || 'unknown'}`,
    intentVersion: Number.isInteger(Number(fallback.intentVersion)) && Number(fallback.intentVersion) > 0
      ? Number(fallback.intentVersion)
      : MONITORING_INTENT_VERSION,
    keyword: boundedText(keyword, 200),
    objective: boundedText(fallback.objective, 80) || 'keyword_relevance',
    targetEntity: fallbackEntities.length > 0 ? fallbackEntities : [...new Set(brandEntities)],
    targetContent: fallbackContent.length > 0 ? fallbackContent : [boundedText(keyword, 200)].filter(Boolean),
    exclusions: fallbackExclusions.length > 0 ? fallbackExclusions : [...(brand.noiseTerms || [])],
    notes: boundedText(fallback.notes, 500) || '按当前搜索关键词的具体主题判断，不进行宽泛品牌扩展。',
    source: fallbackEntities.length > 0 || fallbackContent.length > 0
      ? 'request_intent'
      : 'server_keyword_fallback',
  };
}

export function formatMonitoringIntentForPrompt(intent = {}) {
  const list = value => Array.isArray(value) && value.length > 0 ? value.join('、') : '未指定';
  return `本次采集任务标准（优先级高于宽泛品牌背景）：
- 搜索关键词：${intent.keyword || '未提供'}
- 采集目标：${intent.objective || 'keyword_relevance'}
- 目标对象：${list(intent.targetEntity)}
- 目标主题：${list(intent.targetContent)}
- 明确排除：${list(intent.exclusions)}
- 补充说明：${intent.notes || '无'}

必须同时核对“目标对象”和“目标主题”。只命中品牌、车型、作者名、话题标签或搜索词，不足以证明相关。`;
}

export function listKnownMonitoringIntents() {
  return KEYWORD_INTENTS.flatMap(rule => rule.keys.map(key => cloneIntent(rule, key)));
}
