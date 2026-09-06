// L3-B keyword-strategy: explicit legacy-view responsibility.
export function createKeywordStrategyView({legacyViewState, ports, application, keywordModel, viewOperations}) {
  const {
    HTMLElement,
    PAGE_TYPE,
    chrome,
    console,
    document,
    escapeHtml,
    getCurrentRuntime,
    getPagePlatform,
    getPlatformCapabilities,
    getViewPlatform,
    navigator,
    showMessage,
  } = ports;
  const buildBenchmarkDiscoveryDecisionAngle = (...args) => application.buildBenchmarkDiscoveryDecisionAngle(...args);
  const buildBenchmarkDiscoveryFallbackAnalysis = (...args) => application.buildBenchmarkDiscoveryFallbackAnalysis(...args);
  const buildBenchmarkDiscoveryRuleReason = (...args) => application.buildBenchmarkDiscoveryRuleReason(...args);
  const getCurrentSearchKeyword = (...args) => application.getCurrentSearchKeyword(...args);
  const getKeywordInsightSeedKeyword = (...args) => application.getKeywordInsightSeedKeyword(...args);
  const getKeywordInsightState = (...args) => application.getKeywordInsightState(...args);
  const getKeywordOpportunityKeyword = (...args) => application.getKeywordOpportunityKeyword(...args);
  const getSelectedRecommendedKeywords = (...args) => application.getSelectedRecommendedKeywords(...args);
  const isKeywordAnalysisLockStale = (...args) => application.isKeywordAnalysisLockStale(...args);
  const handleCopyBenchmarkDiscovery = (...args) => viewOperations.handleCopyBenchmarkDiscovery(...args);
  const handleCopyInsight = (...args) => viewOperations.handleCopyInsight(...args);
  const handleCopyKeywordOpportunity = (...args) => viewOperations.handleCopyKeywordOpportunity(...args);
  const handleShareAsImage = (...args) => viewOperations.handleShareAsImage(...args);
  const handleShareBenchmarkDiscoveryAsImage = (...args) => viewOperations.handleShareBenchmarkDiscoveryAsImage(...args);
  const handleShareKeywordOpportunityAsImage = (...args) => viewOperations.handleShareKeywordOpportunityAsImage(...args);

  function setKeywordStrategyTab(tab = "opportunity") {
    return application.selectKeywordStrategyTab(tab);
  }
  function toggleKeywordStrategyPanel(forceVisible) {
    legacyViewState.keywordStrategyPanelVisible =
      typeof forceVisible === "boolean"
        ? forceVisible
        : !legacyViewState.keywordStrategyPanelVisible;
    renderKeywordStrategyPanel();
  }
  function formatOpportunityMetric(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return "0";
    }
    if (numeric >= 10000) {
      return `${(numeric / 10000).toFixed(numeric >= 100000 ? 0 : 1)}w`;
    }
    return `${Math.round(numeric)}`;
  }
  function normalizeKeywordOpportunityTitleForMatch(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[【】\[\]()（）"'“”‘’`]/g, "")
      .replace(/[，。！？、；：,.!?;:|｜/\\-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  function buildKeywordOpportunityTitleCandidates(result) {
    const candidates = [];
    const append = (title, url) => {
      const normalizedTitle = normalizeKeywordOpportunityTitleForMatch(title);
      const normalizedUrl = String(url || "").trim();
      if (!normalizedTitle || !normalizedUrl) {
        return;
      }
      candidates.push({
        title: String(title || "").trim(),
        normalizedTitle,
        url: normalizedUrl,
      });
    };

    const storedListItems = Array.isArray(result?._listItems) ? result._listItems : [];
    storedListItems.forEach((item) => {
      append(item?.title, item?.url || item?.detailPageUrl || item?.noteUrl);
    });

    const representativeSamples = Array.isArray(result?._representativeSamples)
      ? result._representativeSamples
      : [];
    representativeSamples.forEach((item) => {
      append(item?.title, item?.url || item?.detailPageUrl || item?.noteUrl);
    });

    return candidates;
  }
  function resolveKeywordOpportunityTitleUrl(result, title) {
    const normalizedTitle = normalizeKeywordOpportunityTitleForMatch(title);
    if (!normalizedTitle) {
      return "";
    }

    const candidates = buildKeywordOpportunityTitleCandidates(result);
    const exactMatch = candidates.find(
      (item) => item.normalizedTitle === normalizedTitle,
    );
    if (exactMatch?.url) {
      return exactMatch.url;
    }

    const inclusiveMatch = candidates.find(
      (item) =>
        item.normalizedTitle.includes(normalizedTitle) ||
        normalizedTitle.includes(item.normalizedTitle),
    );
    return inclusiveMatch?.url || "";
  }
  function renderKeywordStrategyLoadingState({
    title = "正在分析",
    meta = "正在整理数据并生成判断，请稍候",
  } = {}) {
    return `
    <div class="keyword-insight-summary-card keyword-strategy-loading-card is-loading">
      <div class="keyword-insight-summary-title">
        <span class="keyword-insight-loading-spinner" aria-hidden="true"></span>
        ${escapeHtml(title)}
      </div>
      <div class="keyword-insight-summary-meta">${escapeHtml(meta)}</div>
    </div>
  `;
  }
  function renderBenchmarkDiscoveryResult() {
    if (keywordModel.keywordBenchmarkAnalysisStatus() === "loading") {
      return renderKeywordStrategyLoadingState({
        title: keywordModel.keywordBenchmarkLoadingTitle() || "正在找对标账号",
        meta:
          keywordModel.keywordBenchmarkLoadingMeta() ||
          "正在采集样本、补采账号主页并生成推荐判断",
      });
    }

    const result = keywordModel.keywordBenchmarkResult();
    if (!result) {
      return "";
    }
    const candidates = Array.isArray(result.candidates) ? result.candidates : [];
    const potentialLabels = {
      high: "优先对标",
      medium: "可观察",
      low: "先复核",
    };
    const candidateHtml =
      candidates.length > 0
        ? candidates
            .map((candidate, index) => {
              const profile = candidate.profile || null;
              const analysis = candidate.analysis || buildBenchmarkDiscoveryFallbackAnalysis(candidate);
              const recommendationReason =
                analysis.recommendationReason ||
                buildBenchmarkDiscoveryRuleReason(candidate);
              const decisionAngle = buildBenchmarkDiscoveryDecisionAngle(
                candidate,
                analysis,
              );
              const evidenceItems = buildBenchmarkDiscoveryCandidateEvidence(
                candidate,
              );
              const representativeWorks =
                buildBenchmarkDiscoveryRepresentativeWorks(candidate, 3);
              return `
              <div class="keyword-benchmark-card">
                <div class="keyword-benchmark-card-head">
                  <div class="keyword-benchmark-rank">#${index + 1}</div>
                  <div class="keyword-benchmark-account">
                    <div class="keyword-benchmark-name">${escapeHtml(profile?.bloggerName || candidate.authorName || "未知账号")}</div>
                    <div class="keyword-benchmark-conclusion">${escapeHtml(recommendationReason)}</div>
                    <div class="keyword-benchmark-angle">${escapeHtml(decisionAngle)}</div>
                  </div>
                </div>
                <div class="keyword-benchmark-tags">
                  <span class="keyword-benchmark-potential keyword-benchmark-potential-${escapeHtml(analysis.growthPotential || "medium")}">${escapeHtml(potentialLabels[analysis.growthPotential] || "观察")}</span>
                  ${(Array.isArray(analysis.tags) ? analysis.tags : [])
                      .map((tag) => `<span>${escapeHtml(tag)}</span>`)
                      .join("")}
                </div>
                <div class="keyword-benchmark-evidence">
                  <div class="keyword-benchmark-section-title">判断依据</div>
                  ${analysis.focusAssessment ? `<p>${escapeHtml(analysis.focusAssessment)}</p>` : ""}
                  <ul>
                    ${evidenceItems
                        .map((item) => `<li>${escapeHtml(item)}</li>`)
                        .join("")}
                  </ul>
                </div>
                ${
                    representativeWorks.length > 0
                      ? `<div class="keyword-benchmark-work-list">
                        <div class="keyword-benchmark-section-title">代表作品</div>
                        <ul>
                          ${representativeWorks
                              .map(
                                (item) => `
                                <li>
                                  ${
                                      item.url
                                        ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>`
                                        : `<span>${escapeHtml(item.title)}</span>`
                                    }
                                  <em>赞 ${escapeHtml(formatOpportunityMetric(item.likes))}${item.collects ? ` · 藏 ${escapeHtml(formatOpportunityMetric(item.collects))}` : ""}</em>
                                </li>
                              `,
                              )
                              .join("")}
                        </ul>
                      </div>`
                      : ""
                  }
                <div class="keyword-benchmark-actions">
                  ${
                      candidate.authorProfileUrl
                        ? `<button type="button" class="keyword-benchmark-action keyword-benchmark-action-primary" data-action="monitor-benchmark-account" data-url="${escapeHtml(candidate.authorProfileUrl)}" data-name="${escapeHtml(profile?.bloggerName || candidate.authorName || "")}">纳入监控</button>`
                        : ""
                    }
                  ${
                      candidate.authorProfileUrl
                        ? `<button type="button" class="keyword-benchmark-action" data-action="open-benchmark-profile" data-url="${escapeHtml(candidate.authorProfileUrl)}">打开主页</button>`
                        : ""
                    }
                </div>
              </div>
            `;
            })
            .join("")
        : `<div class="keyword-benchmark-empty">当前样本里还没有出现 ${Number(result.minOccurrence) || 2} 次以上的账号。可以换一个更明确的主词，或扩大采样后再试。</div>`;

    return `
    <section class="keyword-benchmark-summary">
      <div class="keyword-benchmark-summary-head">
        <div>
          <div class="keyword-opportunity-keyword">${escapeHtml(result.keyword || "")}</div>
          <div class="keyword-benchmark-summary-text">
            已从 ${Number(result.sampleCount) || 0} 条搜索结果中筛出 ${Number(result.candidateCount) || 0} 个候选账号；当前入围门槛为样本出现 ${Number(result.minOccurrence) || 2} 次，优先结合账号主页、粉丝量级和代表内容判断是否值得对标。
          </div>
        </div>
        <div class="keyword-insight-share-wrap">
          <button type="button" class="keyword-insight-share-btn">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/></svg>
            去分享
          </button>
          <div class="keyword-insight-share-menu">
            <div class="keyword-insight-share-menu-inner">
              <button type="button" class="keyword-insight-share-menu-item" data-action="copy-benchmark">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                复制文本
              </button>
              <button type="button" class="keyword-insight-share-menu-item" data-action="share-benchmark-as-image">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
                分享图片
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
    <section class="keyword-opportunity-block">
      <div class="keyword-opportunity-block-title">候选账号</div>
      <div class="keyword-benchmark-list">${candidateHtml}</div>
    </section>
  `;
  }
  function renderKeywordOpportunityResult() {
    const result = keywordModel.keywordOpportunityResult();
    if (!result) {
      return "";
    }

    const ruleMetrics = result.ruleMetrics || {};
    const topicDirections = Array.isArray(result.hotTopicDirections)
      ? result.hotTopicDirections
      : [];
    const recommendedAngles = Array.isArray(result.recommendedAngles)
      ? result.recommendedAngles
      : [];
    const subtopics = Array.isArray(result.coreWinningSubtopics)
      ? result.coreWinningSubtopics
      : [];

    const metrics = [
      {
        label: "热度",
        value:
          ruleMetrics.heatLevel === "high"
            ? "高"
            : ruleMetrics.heatLevel === "medium"
              ? "中"
              : "低",
        desc:
          "看这个词里最能打的一批内容，整体大概能冲到多高。越高，说明这个词更容易出大爆款。",
      },
      {
        label: "高位区间",
        value:
          ruleMetrics.highBandEnd > 0
            ? `${ruleMetrics.highBandStart}-${ruleMetrics.highBandEnd}`
            : "未识别",
        desc:
          "表示前几名内容明显更强，通常是第几名到第几名。比如 1-6，就是前 6 条表现特别突出。",
      },
      {
        label: "断层跌幅",
        value:
          ruleMetrics.cliffDropRatio > 0
            ? `${Math.round(ruleMetrics.cliffDropRatio * 100)}%`
            : "不明显",
        desc:
          "看前排内容和后面内容差得有多大。越大，说明流量越集中在少数几条爆款上。",
      },
      {
        label: "高位均赞",
        value: formatOpportunityMetric(ruleMetrics.highBandAvgLikes),
        desc:
          "前排爆款内容的平均点赞数，可以理解为这个词做得好的内容，通常能拿到多少赞。",
      },
      {
        label: "中位赞",
        value: formatOpportunityMetric(ruleMetrics.medianLikes),
        desc:
          "把所有内容按点赞从高到低排，取中间那条的点赞数。可以理解为普通内容大概是什么水平。",
      },
    ];

    const bandPresenceLabels = {
      high: "高赞区",
      mid: "中赞区",
      low: "低赞区",
      high_mid: "高赞区+中赞区",
      mid_low: "中赞区+低赞区",
      all: "高赞区+中赞区+低赞区",
    };

    const organicViabilityLabels = {
      high: "自然流可行性高",
      medium: "自然流可行性中",
      low: "自然流可行性低",
    };

    const topicHtml =
      topicDirections.length > 0
        ? topicDirections
            .map((direction) => {
              const titles = Array.isArray(direction.representativeTitles)
                ? direction.representativeTitles
                : [];
              const bandLabel = bandPresenceLabels[direction.bandPresence] || "";
              const viability = direction.organicViability || "medium";
              const viabilityLabel = organicViabilityLabels[viability] || "";
              const avgLikesValue = Number(direction.avgLikes) || 0;
              return `
              <div class="keyword-opportunity-topic-card">
                <div class="keyword-opportunity-topic-name">${escapeHtml(direction.name || "未命名类目")}</div>
                <div class="keyword-opportunity-topic-meta">
                  ${bandLabel ? `<span class="keyword-opportunity-band-tag keyword-opportunity-band-${escapeHtml(direction.bandPresence || "all")}">${escapeHtml(bandLabel)}</span>` : ""}
                  <span class="keyword-opportunity-organic-tag keyword-opportunity-organic-${escapeHtml(viability)}">${escapeHtml(viabilityLabel)}</span>
                  <span class="keyword-opportunity-topic-stats">${Number(direction.sampleCount) || 0} 篇 · ${Math.round((Number(direction.shareRatio) || 0) * 100)}%${avgLikesValue > 0 ? ` · 均赞 ${formatOpportunityMetric(avgLikesValue)}` : ""}</span>
                </div>
                ${direction.userIntent ? `<div class="keyword-opportunity-topic-intent"><span class="keyword-opportunity-topic-intent-label">用户意图</span>${escapeHtml(direction.userIntent)}</div>` : ""}
                <div class="keyword-opportunity-topic-reason">${escapeHtml(direction.whyItWorks || "")}</div>
                ${direction.organicNote ? `<div class="keyword-opportunity-topic-organic-note">${escapeHtml(direction.organicNote)}</div>` : ""}
                ${
                    titles.length > 0
                      ? `<div class="keyword-opportunity-topic-titles">
                        <div class="keyword-opportunity-topic-titles-label">代表标题</div>
                        <ul class="keyword-opportunity-topic-title-list">
                          ${titles
                              .map((t) => {
                                const matchUrl = resolveKeywordOpportunityTitleUrl(
                                  result,
                                  t,
                                );
                                return matchUrl
                                  ? `<li><a href="${escapeHtml(matchUrl)}" class="keyword-opportunity-title-link" target="_blank" rel="noopener">${escapeHtml(t)}</a></li>`
                                  : `<li>${escapeHtml(t)}</li>`;
                              })
                              .join("")}
                        </ul>
                      </div>`
                      : ""
                  }
              </div>
            `;
            })
            .join("")
        : `<div class="keyword-opportunity-topic-card"><div class="keyword-opportunity-topic-reason">当前样本中还没有稳定聚合出足够清晰的内容类目，建议结合长尾词继续下钻。</div></div>`;

    const angleHtml =
      recommendedAngles.length > 0
        ? recommendedAngles
            .map(
              (angle) => `
              <div class="keyword-opportunity-angle-card">
                <div class="keyword-opportunity-angle-head">
                  <div class="keyword-opportunity-angle-title">${escapeHtml(angle.title || "未命名选题")}</div>
                </div>
                <div class="keyword-opportunity-angle-body">
                  ${angle.audiencePainPoint ? `<div class="keyword-opportunity-angle-field">${escapeHtml(angle.audiencePainPoint)}</div>` : ""}
                  ${angle.formatSuggestion ? `<div class="keyword-opportunity-angle-field"><span class="keyword-opportunity-angle-field-label">形式建议</span>${escapeHtml(angle.formatSuggestion)}</div>` : ""}
                  ${angle.executionHint ? `<div class="keyword-opportunity-angle-field"><span class="keyword-opportunity-angle-field-label">执行提示</span>${escapeHtml(angle.executionHint)}</div>` : ""}
                </div>
              </div>
            `,
            )
            .join("")
        : `<div class="keyword-opportunity-angle-card"><div class="keyword-opportunity-angle-body">当前还没有生成可执行选题，建议先用分析长尾需求验证更具体的切口。</div></div>`;

    const subtopicHtml =
      subtopics.length > 0
        ? subtopics
            .map(
              (item) =>
                `<span class="keyword-opportunity-chip">${escapeHtml(item)}</span>`,
            )
            .join("")
        : `<span class="keyword-opportunity-chip">暂无明确细分切口</span>`;

    return `
    <section class="keyword-opportunity-summary">
      <div class="keyword-opportunity-summary-head">
        <div class="keyword-opportunity-summary-head-left">
          <div class="keyword-opportunity-keyword">${escapeHtml(result.keyword || "")}</div>
        </div>
        <div class="keyword-insight-share-wrap">
          <button type="button" class="keyword-insight-share-btn">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/></svg>
            去分享
          </button>
          <div class="keyword-insight-share-menu">
            <div class="keyword-insight-share-menu-inner">
              <button type="button" class="keyword-insight-share-menu-item" data-action="copy-opportunity">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                复制文本
              </button>
              <button type="button" class="keyword-insight-share-menu-item" data-action="share-opportunity-as-image">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
                分享图片
              </button>
            </div>
          </div>
        </div>
      </div>
      <div class="keyword-opportunity-summary-distribution">${escapeHtml(result.distributionSummary || "")}</div>
      <div class="keyword-opportunity-metrics">
        ${metrics
            .map(
              (metric) => `
              <div class="keyword-opportunity-metric">
                <div class="keyword-opportunity-metric-label-row">
                  <div class="keyword-opportunity-metric-label">${escapeHtml(metric.label)}</div>
                  <span class="auth-help-popover-wrap keyword-opportunity-help-wrap">
                    <button
                      type="button"
                      class="auth-help-trigger keyword-opportunity-help-trigger"
                      aria-label="查看${escapeHtml(metric.label)}说明">
                      ?
                    </button>
                    <span
                      class="auth-help-popover keyword-opportunity-help-popover"
                      role="tooltip">
                      ${escapeHtml(metric.desc)}
                    </span>
                  </span>
                </div>
                <div class="keyword-opportunity-metric-value">${escapeHtml(metric.value)}</div>
              </div>
            `,
            )
            .join("")}
      </div>
    </section>
    <section class="keyword-opportunity-block">
      <div class="keyword-opportunity-block-title">内容分布全景</div>
      <div class="keyword-opportunity-topic-list">${topicHtml}</div>
    </section>
    <section class="keyword-opportunity-block">
      <div class="keyword-opportunity-block-title">核心爆款细分词</div>
      <div class="keyword-opportunity-chip-list">${subtopicHtml}</div>
    </section>
    <section class="keyword-opportunity-block">
      <div class="keyword-opportunity-block-title">新号优先选题</div>
      <div class="keyword-opportunity-angle-list">${angleHtml}</div>
    </section>
  `;
  }
  function renderKeywordStrategyPanel() {
    const overlay = document.getElementById("keywordStrategyModalOverlay");
    const btnToggle = document.getElementById("btnToggleKeywordStrategy");
    const btnRun = document.getElementById("btnRunKeywordOpportunity");
    const btnBenchmarkRun = document.getElementById("btnRunBenchmarkDiscovery");
    const btnBenchmarkTab = document.getElementById(
      "btnKeywordStrategyTabBenchmark",
    );
    const btnOpportunityTab = document.getElementById(
      "btnKeywordStrategyTabOpportunity",
    );
    const btnLongtailTab = document.getElementById(
      "btnKeywordStrategyTabLongtail",
    );
    const opportunityPane = document.getElementById(
      "keywordStrategyOpportunityPane",
    );
    const benchmarkPane = document.getElementById("keywordStrategyBenchmarkPane");
    const longtailPane = document.getElementById("keywordStrategyLongtailPane");
    const longtailHint = document.getElementById("keywordStrategyLongtailHint");
    const benchmarkErrorEl = document.getElementById("keywordBenchmarkError");
    const benchmarkResultEl = document.getElementById("keywordBenchmarkResult");
    const errorEl = document.getElementById("keywordOpportunityError");
    const resultEl = document.getElementById("keywordOpportunityResult");
    if (!overlay) {
      return;
    }

    const runtime = getCurrentRuntime();
    const currentKeyword = getCurrentSearchKeyword(runtime);
    const pagePlatform = getPagePlatform(runtime);
    const selectedPlatform = getViewPlatform(runtime);
    const visible =
      legacyViewState.keywordStrategyPanelVisible &&
      runtime?.pageType === PAGE_TYPE.SEARCH_RESULTS &&
      selectedPlatform === pagePlatform &&
      getPlatformCapabilities(pagePlatform).captureSearch;
    overlay.classList.toggle("is-active", visible);
    overlay.ariaHidden = visible ? "false" : "true";

    if (btnToggle) {
      btnToggle.disabled =
        runtime?.pageType !== PAGE_TYPE.SEARCH_RESULTS ||
        selectedPlatform !== pagePlatform ||
        !getPlatformCapabilities(pagePlatform).captureSearch;
      btnToggle.classList.toggle("is-disabled", btnToggle.disabled);
      btnToggle.title = "赛道策略";
    }

    if (!visible) {
      return;
    }

    const isBenchmark = legacyViewState.keywordStrategyActiveTab === "benchmark";
    const isOpportunity = legacyViewState.keywordStrategyActiveTab === "opportunity";
    const isLongtail = legacyViewState.keywordStrategyActiveTab === "longtail";
    if (btnBenchmarkTab) {
      btnBenchmarkTab.classList.toggle("is-active", isBenchmark);
      btnBenchmarkTab.setAttribute(
        "aria-selected",
        isBenchmark ? "true" : "false",
      );
    }
    if (btnOpportunityTab) {
      btnOpportunityTab.classList.toggle("is-active", isOpportunity);
      btnOpportunityTab.setAttribute(
        "aria-selected",
        isOpportunity ? "true" : "false",
      );
    }
    if (btnLongtailTab) {
      btnLongtailTab.classList.toggle("is-active", isLongtail);
      btnLongtailTab.setAttribute(
        "aria-selected",
        isLongtail ? "true" : "false",
      );
    }
    if (benchmarkPane) {
      benchmarkPane.hidden = !isBenchmark;
    }
    if (opportunityPane) {
      opportunityPane.hidden = !isOpportunity;
    }
    if (longtailPane) {
      longtailPane.hidden = !isLongtail;
    }

    if (longtailHint) {
      const resultKeyword = getKeywordOpportunityKeyword();
      if (currentKeyword && resultKeyword && currentKeyword !== resultKeyword) {
        longtailHint.textContent = `当前搜索词是「${currentKeyword}」，当前判断结果保留自「${resultKeyword}」。`;
      } else if (isBenchmark && currentKeyword) {
        longtailHint.textContent = `当前搜索词「${currentKeyword}」可用来找对标账号，也可以继续判断赛道机会和分析长尾需求。`;
      } else if (currentKeyword) {
        longtailHint.textContent = `当前搜索词「${currentKeyword}」可以判断赛道机会、找对标账号和分析长尾需求。`;
      } else if (resultKeyword) {
        longtailHint.textContent = `当前判断结果保留自「${resultKeyword}」，切回搜索页后可重新分析。`;
      } else {
        longtailHint.textContent = "先判断赛道机会，再找对标账号和分析长尾需求。";
      }
    }
    const btnBenchmarkCancel = document.getElementById("btnCancelBenchmarkDiscovery");
    const btnBenchmarkClear = document.getElementById(
      "btnClearBenchmarkDiscoveryResult",
    );
    if (btnBenchmarkRun) {
      btnBenchmarkRun.disabled =
        keywordModel.keywordBenchmarkInFlight() || keywordModel.keywordOpportunityInFlight() || !currentKeyword;
      btnBenchmarkRun.classList.toggle("is-disabled", btnBenchmarkRun.disabled);
      btnBenchmarkRun.textContent = keywordModel.keywordBenchmarkInFlight()
        ? "查找中..."
        : "开始找对标账号";
      btnBenchmarkRun.style.display = keywordModel.keywordBenchmarkInFlight()
        ? "none"
        : "inline-flex";
    }
    if (btnBenchmarkCancel) {
      btnBenchmarkCancel.style.display = keywordModel.keywordBenchmarkInFlight()
        ? "inline-flex"
        : "none";
    }
    if (btnBenchmarkClear) {
      btnBenchmarkClear.hidden =
        (!keywordModel.keywordBenchmarkResult() &&
          !String(keywordModel.keywordBenchmarkErrorMessage() || "").trim() &&
          keywordModel.keywordBenchmarkAnalysisStatus() !== "loading") ||
        keywordModel.keywordBenchmarkInFlight();
    }
    if (benchmarkErrorEl) {
      benchmarkErrorEl.hidden = !keywordModel.keywordBenchmarkErrorMessage();
      benchmarkErrorEl.textContent = keywordModel.keywordBenchmarkErrorMessage();
    }
    const benchmarkIntroTextEl = document.getElementById(
      "keywordBenchmarkIntroText",
    );
    if (benchmarkIntroTextEl) {
      benchmarkIntroTextEl.hidden =
        !!keywordModel.keywordBenchmarkResult() || keywordModel.keywordBenchmarkAnalysisStatus() === "loading";
    }
    if (benchmarkResultEl) {
      benchmarkResultEl.innerHTML = renderBenchmarkDiscoveryResult();
    }
    const btnCancel = document.getElementById("btnCancelKeywordOpportunity");
    const btnClear = document.getElementById("btnClearKeywordOpportunityResult");
    if (btnRun) {
      btnRun.disabled = keywordModel.keywordOpportunityInFlight() || !currentKeyword;
      btnRun.classList.toggle("is-disabled", btnRun.disabled);
      btnRun.textContent = keywordModel.keywordOpportunityInFlight()
        ? "分析中..."
        : "开始判断赛道机会";
      btnRun.style.display = keywordModel.keywordOpportunityInFlight() ? "none" : "inline-flex";
    }
    if (btnCancel) {
      btnCancel.style.display = keywordModel.keywordOpportunityInFlight()
        ? "inline-flex"
        : "none";
    }
    if (btnClear) {
      btnClear.hidden =
        (!keywordModel.keywordOpportunityResult() &&
          !String(keywordModel.keywordOpportunityErrorMessage() || "").trim()) ||
        keywordModel.keywordOpportunityInFlight();
    }
    if (errorEl) {
      errorEl.hidden = !keywordModel.keywordOpportunityErrorMessage();
      errorEl.textContent = keywordModel.keywordOpportunityErrorMessage();
    }
    const introTextEl = document.getElementById("keywordOpportunityIntroText");
    if (introTextEl) {
      introTextEl.hidden = !!keywordModel.keywordOpportunityResult() || keywordModel.keywordOpportunityInFlight();
    }
    if (resultEl) {
      resultEl.innerHTML =
        keywordModel.keywordOpportunityInFlight() && !keywordModel.keywordOpportunityResult()
          ? renderKeywordStrategyLoadingState({
              title: "正在判断赛道机会",
              meta:
                "正在采集主词样本并生成内容机会判断，通常需要 1-2 分钟",
            })
          : renderKeywordOpportunityResult();
    }
  }
  function handleOpenKeywordLongtail() {
    return application.openKeywordLongtail();
  }
  function handleBenchmarkDiscoveryResultActions(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const actionTarget = target.closest("[data-action]");
    const action = actionTarget?.dataset?.action || "";
    const url = String(actionTarget?.dataset?.url || "").trim();

    if (action === "copy-benchmark") {
      handleCopyBenchmarkDiscovery(actionTarget);
      return;
    }

    if (action === "share-benchmark-as-image") {
      handleShareBenchmarkDiscoveryAsImage();
      return;
    }

    if (action === "open-benchmark-profile") {
      if (!url) {
        showMessage("暂未找到可打开的链接", "warning");
        return;
      }
      chrome.tabs.create({url}).catch((error) => {
        console.warn("[Sidebar] Open benchmark url failed:", error);
        showMessage("打开链接失败，请稍后重试", "warning");
      });
      return;
    }

    if (action === "monitor-benchmark-account") {
      application.monitorLegacyBenchmarkCandidate(
        url,
        () => String(actionTarget?.dataset?.name || "").trim(),
      );
    }
  }
  function buildBenchmarkDiscoveryCandidateEvidence(candidate) {
    const profile = candidate?.profile || null;
    const followersCount = Number(profile?.followersCount) || 0;
    const maxLikes = Number(candidate?.maxLikes) || 0;
    const likeFollowerRatio =
      followersCount > 0 && maxLikes > 0 ? maxLikes / followersCount : 0;
    const evidenceItems = [
      `样本出现 ${Number(candidate?.occurrenceCount) || 0} 次，最高赞 ${formatOpportunityMetric(maxLikes)}，均赞 ${formatOpportunityMetric(candidate?.averageLikes)}`,
    ];
    if (followersCount > 0) {
      evidenceItems.push(
        likeFollowerRatio >= 0.1
          ? `粉丝 ${formatOpportunityMetric(followersCount)}，最高赞约为粉丝数 ${Math.max(1, Math.round(likeFollowerRatio * 10) / 10)} 倍，有低粉高表现信号`
          : `粉丝 ${formatOpportunityMetric(followersCount)}，可结合代表内容判断是否适合普通账号学习`,
      );
    }
    if (Number(profile?.likedAndCollectedCount) > 0) {
      evidenceItems.push(
        `主页累计赞藏 ${formatOpportunityMetric(profile.likedAndCollectedCount)}`,
      );
    }
    return evidenceItems;
  }
  function buildBenchmarkDiscoveryRepresentativeWorks(candidate, limit = 3) {
    return (Array.isArray(candidate?.topItems) ? candidate.topItems : [])
      .map((item) => ({
        title: String(item?.title || "").trim(),
        url: String(item?.url || "").trim(),
        likes: Number(item?.likes) || 0,
        collects: Number(item?.collects) || 0,
      }))
      .filter((item) => item.title)
      .slice(0, limit);
  }
  function handleKeywordOpportunityResultActions(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const action =
      target.dataset?.action ||
      target.closest("[data-action]")?.dataset?.action ||
      "";

    if (action === "copy-opportunity") {
      handleCopyKeywordOpportunity(target.closest("[data-action]"));
      return;
    }
    if (action === "share-opportunity-as-image") {
      handleShareKeywordOpportunityAsImage();
      return;
    }
  }
  function toggleExpandedKeywordsVisibility() {
    legacyViewState.expandedKeywordsPanelVisible = !legacyViewState.expandedKeywordsPanelVisible;
    renderExpandedKeywords();
    if (legacyViewState.expandedKeywordsPanelVisible) {
      document
        .getElementById("expandedKeywordsPanel")
        ?.scrollIntoView({behavior: "smooth", block: "nearest"});
    }
  }
  function renderExpandedKeywords() {
    const panel = document.getElementById("expandedKeywordsPanel");
    const countEl = document.getElementById("expandedKeywordsCount");
    const textarea = document.getElementById("textareaExpandedKeywords");
    const btnView = document.getElementById("btnViewExpandedKeywords");
    const btnClear = document.getElementById("btnClearKeywordInsightResult");
    const introEl = document.getElementById("keywordInsightIntro");
    const btnHeaderRun = document.getElementById("btnExpandKeywords");
    const btnIntroRun = document.getElementById("btnRunKeywordInsight");
    const actionRowEl = document.getElementById("keywordInsightActionRow");

    if (!panel) return;

    const hasKeywords = keywordModel.expandedKeywordsBuffer().length > 0;
    panel.hidden = !hasKeywords || !legacyViewState.expandedKeywordsPanelVisible;
    if (introEl) {
      introEl.hidden = hasKeywords;
    }

    if (countEl) {
      countEl.textContent = `扩展词: ${keywordModel.expandedKeywordsBuffer().length} 词`;
    }

    if (btnView) {
      btnView.hidden = !hasKeywords;
      btnView.textContent = legacyViewState.expandedKeywordsPanelVisible
        ? "收起扩展词"
        : `查看全部扩展词 (${keywordModel.expandedKeywordsBuffer().length})`;
    }
    if (btnClear) {
      btnClear.hidden = !hasKeywords;
    }
    if (btnHeaderRun) {
      btnHeaderRun.hidden = !hasKeywords;
    }
    if (btnIntroRun) {
      btnIntroRun.hidden = hasKeywords;
    }
    if (actionRowEl) {
      actionRowEl.classList.toggle("is-result-mode", hasKeywords);
    }

    if (textarea) {
      const nextValue = keywordModel.expandedKeywordsBuffer().join("\n");
      if (textarea.value !== nextValue) {
        textarea.value = nextValue;
      }
    }
  }
  function updateExpandedKeywordsSummary() {
    renderExpandedKeywords();
  }
  function renderInsightLoadingState() {
    return `
    <div class="keyword-insight-summary-card is-loading">
      <div class="keyword-insight-summary-title">
        <span class="keyword-insight-loading-spinner" aria-hidden="true"></span>
        正在分析需求方向
      </div>
      <div class="keyword-insight-summary-meta">已扩展 ${keywordModel.expandedKeywordsBuffer().length} 个关键词，通常需要 1-2 分钟</div>
    </div>
  `;
  }
  function renderInsightSummaryCard(draft) {
    const analysis = draft.analysisResult;
    if (!analysis) {
      return "";
    }

    const categoryCount = Array.isArray(analysis.categories)
      ? analysis.categories.length
      : 0;
    const selectedKeywords = getSelectedRecommendedKeywords(draft);
    return `
    <div class="keyword-insight-summary-card">
      <div class="keyword-insight-summary-header">
        <div class="keyword-insight-summary-title">需求洞察</div>
        <div class="keyword-insight-share-wrap">
          <button type="button" class="keyword-insight-share-btn">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/></svg>
            去分享
          </button>
          <div class="keyword-insight-share-menu">
            <div class="keyword-insight-share-menu-inner">
              <button type="button" class="keyword-insight-share-menu-item" data-action="copy-insight">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                复制文本
              </button>
              <button type="button" class="keyword-insight-share-menu-item" data-action="share-as-image">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
                分享图片
              </button>
            </div>
          </div>
        </div>
      </div>
      <div class="keyword-insight-summary-meta">共 ${keywordModel.expandedKeywordsBuffer().length} 词 · ${categoryCount} 个方向 · 已选 ${selectedKeywords.length}/10 个词采集</div>
      <div class="keyword-insight-summary-text">${escapeHtml(analysis.summary || "")}</div>
    </div>
  `;
  }
  function renderInsightSampleBlock(sampleStatus, sampleResult) {
    if (sampleStatus === "loading") {
      return `<div class="keyword-insight-sample-hint">正在抓取该方向样本...</div>`;
    }
    if (sampleStatus === "error") {
      return `<div class="keyword-insight-sample-hint is-error">${escapeHtml(sampleResult?.errorMessage || "样本获取失败，可重试分析后再次查看")}</div>`;
    }
    const samples = Array.isArray(sampleResult?.samples)
      ? sampleResult.samples
      : [];
    if (samples.length === 0) {
      return `<div class="keyword-insight-sample-hint">暂无样本</div>`;
    }

    const sourceLabel = sampleResult?.usedKeyword
      ? `<div class="keyword-insight-sample-source">样本来自：${escapeHtml(sampleResult.usedKeyword)}</div>`
      : "";
    const itemsHtml = samples
      .map((sample) => {
        const title = escapeHtml(sample?.title || "未命名样本");
        const author = escapeHtml(sample?.author || "未知作者");
        const likes = Number(sample?.likes) || 0;
        const titleHtml = sample?.url
          ? `<a href="${escapeHtml(sample.url)}" target="_blank" style="color: inherit; text-decoration: underline;">${title}</a>`
          : `<span class="sample-title">${title}</span>`;
        return `<li>${titleHtml}<span class="sample-meta">${author} · ❤️ ${likes}</span></li>`;
      })
      .join("");
    return `${sourceLabel}<ul class="keyword-insight-sample-list">${itemsHtml}</ul>`;
  }
  function renderInsightCategories(draft) {
    const analysis = draft.analysisResult;
    const categories = Array.isArray(analysis?.categories)
      ? analysis.categories
      : [];
    const selectedKeywordSet = new Set(draft.selectedKeywords || []);

    if (categories.length === 0) {
      return "";
    }

    const totalKeywords = keywordModel.expandedKeywordsBuffer().length || 1;

    return categories
      .map((category) => {
        const categoryId = String(category?.id || "").trim();
        const isExpanded = legacyViewState.expandedKeywordInsightCategoryIds.has(categoryId);
        const sampleStatus =
          draft.sampleStatusByCategoryId?.[categoryId] || "idle";
        const sampleResult =
          draft.sampleResultsByCategoryId?.[categoryId] || null;
        const keywordList = Array.isArray(category?.keywords)
          ? category.keywords
          : [];
        const pct = Math.round((keywordList.length / totalKeywords) * 100);

        return `
        <article class="keyword-insight-category-card">
          <div class="keyword-insight-category-head">
            <span class="keyword-insight-category-title">${escapeHtml(category?.icon || "📌")} ${escapeHtml(category?.name || "未命名方向")}</span>
            <button type="button" class="btn-text" data-action="toggle-expand-category" data-category-id="${escapeHtml(categoryId)}">
              ${isExpanded ? "收起" : "展开"}
            </button>
          </div>
          <div class="keyword-insight-category-meta">
            <span>${keywordList.length} 词</span>
            <span class="keyword-density-pct">${pct}%</span>
            <span class="keyword-density-bar-wrap"><span class="keyword-density-bar-fill" style="width:${Math.min(pct, 100)}%"></span></span>
          </div>
          <div class="keyword-insight-category-insight">${escapeHtml(category?.insight || "")}</div>
          <div class="keyword-insight-category-samples">
            ${renderInsightSampleBlock(sampleStatus, sampleResult)}
          </div>
          ${
              isExpanded
                ? `<div class="keyword-insight-keywords">${keywordList
                    .map((keyword) => {
                      return `<span class="keyword-chip" data-action="toggle-keyword" data-keyword="${escapeHtml(keyword)}" title="点击复制">${escapeHtml(keyword)}</span>`;
                    })
                    .join("")}</div>`
                : ""
            }
        </article>
      `;
      })
      .join("");
  }
  function renderKeywordInsightState() {
    const draft = getKeywordInsightState();
    const insightContainer = document.getElementById("keywordInsightContainer");
    const summaryEl = document.getElementById("keywordInsightSummary");
    const categoriesEl = document.getElementById("keywordInsightCategories");
    const errorEl = document.getElementById("keywordInsightError");
    const errorMessageEl = document.getElementById("keywordInsightErrorMessage");
    const btnRetry = document.getElementById("btnRetryKeywordAnalysis");
    const btnCapture = document.getElementById("btnInsightBatchCapture");
    const introEl = document.getElementById("keywordInsightIntro");

    renderExpandedKeywords();

    if (
      !insightContainer ||
      !summaryEl ||
      !categoriesEl ||
      !errorEl
    ) {
      return;
    }

    const hasKeywords = keywordModel.expandedKeywordsBuffer().length > 0;
    const analysisStatus = draft.analysisStatus || "idle";
    insightContainer.hidden = !hasKeywords;
    if (introEl) {
      introEl.hidden = hasKeywords;
    }

    if (!hasKeywords) {
      summaryEl.innerHTML = "";
      categoriesEl.innerHTML = "";
      errorEl.hidden = true;
      return;
    }

    if (analysisStatus === "loading") {
      summaryEl.innerHTML = renderInsightLoadingState();
      categoriesEl.innerHTML = "";
      errorEl.hidden = true;
      if (btnRetry) {
        btnRetry.disabled = true;
      }
      return;
    }

    if (analysisStatus === "error") {
      summaryEl.innerHTML = "";
      categoriesEl.innerHTML = "";
      errorEl.hidden = false;
      if (errorMessageEl) {
        errorMessageEl.textContent =
          draft.analysisErrorMessage ||
          "当前智能分析暂时不可用，已保留扩展词，可稍后重试或先查看扩展词。";
      }
      if (btnRetry) {
        btnRetry.disabled =
          keywordModel.keywordAnalysisInFlight() && !isKeywordAnalysisLockStale();
      }
      return;
    }

    if (analysisStatus === "success" && draft.analysisResult) {
      summaryEl.innerHTML = renderInsightSummaryCard(draft);
      categoriesEl.innerHTML = renderInsightCategories(draft);
      errorEl.hidden = true;
      return;
    }

    summaryEl.innerHTML = "";
    categoriesEl.innerHTML = "";
    errorEl.hidden = true;
    btnCapture.hidden = true;
  }
  function handleKeywordInsightSummaryActions(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const actionEl = target.closest("[data-action]");
    const action = actionEl?.dataset?.action || "";

    if (action === "copy-insight") {
      handleCopyInsight(actionEl);
      return;
    }
    if (action === "share-as-image") {
      handleShareAsImage();
      return;
    }
  }
  function handleKeywordInsightCategoryActions(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const action =
      target.dataset?.action ||
      target.closest("[data-action]")?.dataset?.action ||
      "";

    if (action === "toggle-expand-category") {
      const categoryId = String(
        target.dataset?.categoryId ||
          target.closest("[data-category-id]")?.dataset?.categoryId ||
          "",
      ).trim();
      if (!categoryId) return;
      if (legacyViewState.expandedKeywordInsightCategoryIds.has(categoryId)) {
        legacyViewState.expandedKeywordInsightCategoryIds.delete(categoryId);
      } else {
        legacyViewState.expandedKeywordInsightCategoryIds.add(categoryId);
      }
      renderKeywordInsightState();
      return;
    }

    if (action === "toggle-keyword") {
      const chip = target.closest("[data-keyword]");
      const keyword = String(
        chip?.dataset?.keyword || target.dataset?.keyword || "",
      ).trim();
      if (!keyword) return;

      navigator.clipboard.writeText(keyword).then(() => {
        showMessage(`已复制: ${keyword}`, "success");
      }).catch((err) => {
        console.error("[Sidebar] copy failed:", err);
        showMessage("复制失败", "error");
      });
    }
  }
  function updateExpandKeywordsButtonState() {
    const btnExpand = document.getElementById("btnExpandKeywords");
    const btnIntroRun = document.getElementById("btnRunKeywordInsight");
    const currentKeyword = getKeywordInsightSeedKeyword();
    const hasResult = keywordModel.expandedKeywordsBuffer().length > 0;
    if (!btnExpand) {
      return;
    }

    if (keywordModel.keywordExpandInFlight()) {
      btnExpand.disabled = false;
      btnExpand.textContent = keywordModel.keywordExpandCancelRequested()
        ? "停止中..."
        : "停止分析";
      btnExpand.classList.remove("btn-secondary");
      btnExpand.classList.add("btn-danger");
      if (btnIntroRun) {
        btnIntroRun.disabled = false;
        btnIntroRun.textContent = keywordModel.keywordExpandCancelRequested()
          ? "停止中..."
          : "停止分析";
        btnIntroRun.classList.remove("btn-primary");
        btnIntroRun.classList.add("btn-danger");
      }
      return;
    }

    btnExpand.disabled = !currentKeyword;
    btnExpand.textContent = hasResult ? "重新分析" : "开始分析长尾需求";
    btnExpand.classList.add("btn-secondary");
    btnExpand.classList.remove("btn-danger");
    if (btnIntroRun) {
      btnIntroRun.disabled = !currentKeyword;
      btnIntroRun.textContent = "开始分析长尾需求";
      btnIntroRun.classList.add("btn-primary");
      btnIntroRun.classList.remove("btn-danger");
    }
  }

  return Object.freeze({
    setKeywordStrategyTab,
    toggleKeywordStrategyPanel,
    formatOpportunityMetric,
    normalizeKeywordOpportunityTitleForMatch,
    buildKeywordOpportunityTitleCandidates,
    resolveKeywordOpportunityTitleUrl,
    renderKeywordStrategyLoadingState,
    renderBenchmarkDiscoveryResult,
    renderKeywordOpportunityResult,
    renderKeywordStrategyPanel,
    handleOpenKeywordLongtail,
    handleBenchmarkDiscoveryResultActions,
    buildBenchmarkDiscoveryCandidateEvidence,
    buildBenchmarkDiscoveryRepresentativeWorks,
    handleKeywordOpportunityResultActions,
    toggleExpandedKeywordsVisibility,
    renderExpandedKeywords,
    updateExpandedKeywordsSummary,
    renderInsightLoadingState,
    renderInsightSummaryCard,
    renderInsightSampleBlock,
    renderInsightCategories,
    renderKeywordInsightState,
    handleKeywordInsightSummaryActions,
    handleKeywordInsightCategoryActions,
    updateExpandKeywordsButtonState,
  });
}
