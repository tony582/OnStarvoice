// L3-B keyword-sharing: explicit legacy-view responsibility.
export function createKeywordSharingView({legacyViewState, ports, application, keywordModel, viewOperations}) {
  const {
    createClipboardItem,
    createImage,
    chrome,
    console,
    document,
    navigator,
    setTimeout,
    showMessage,
    window,
  } = ports;
  const buildBenchmarkDiscoveryFallbackAnalysis = (...args) => application.buildBenchmarkDiscoveryFallbackAnalysis(...args);
  const getBatchDraftForPlatform = (...args) => application.getBatchDraftForPlatform(...args);
  const getKeywordInsightState = (...args) => application.getKeywordInsightState(...args);
  const buildBenchmarkDiscoveryCandidateEvidence = (...args) => viewOperations.buildBenchmarkDiscoveryCandidateEvidence(...args);
  const buildBenchmarkDiscoveryRepresentativeWorks = (...args) => viewOperations.buildBenchmarkDiscoveryRepresentativeWorks(...args);
  const formatOpportunityMetric = (...args) => viewOperations.formatOpportunityMetric(...args);

  function buildBenchmarkDiscoveryShareText() {
    const result = keywordModel.keywordBenchmarkResult();
    if (!result) {
      return "";
    }
    const candidates = Array.isArray(result.candidates) ? result.candidates : [];
    const lines = [
      `【找对标账号】${String(result.keyword || "").trim()}`,
      `从 ${Number(result.sampleCount) || 0} 条搜索结果中筛出 ${Number(result.candidateCount) || 0} 个候选账号，入围门槛为样本出现 ${Number(result.minOccurrence) || 2} 次。`,
    ];

    candidates.slice(0, 5).forEach((candidate, index) => {
      const profile = candidate.profile || null;
      const analysis =
        candidate.analysis || buildBenchmarkDiscoveryFallbackAnalysis(candidate);
      const name =
        String(profile?.bloggerName || candidate.authorName || "").trim() ||
        `候选账号 ${index + 1}`;
      const works = buildBenchmarkDiscoveryRepresentativeWorks(candidate, 3);
      lines.push("");
      lines.push(`${index + 1}. ${name}`);
      if (analysis.recommendationReason) {
        lines.push(String(analysis.recommendationReason).trim());
      }
      if (analysis.focusAssessment) {
        lines.push(`判断依据：${String(analysis.focusAssessment).trim()}`);
      }
      buildBenchmarkDiscoveryCandidateEvidence(candidate).forEach((item) => {
        lines.push(`- ${item}`);
      });
      if (works.length > 0) {
        lines.push("代表作品：");
        works.forEach((work) => {
          lines.push(
            `- ${work.title}（赞 ${formatOpportunityMetric(work.likes)}）${work.url ? ` ${work.url}` : ""}`,
          );
        });
      }
      if (candidate.authorProfileUrl) {
        lines.push(`主页：${candidate.authorProfileUrl}`);
      }
    });

    return lines.join("\n").trim();
  }
  function handleCopyBenchmarkDiscovery(btn) {
    const text = buildBenchmarkDiscoveryShareText();
    if (!text || !btn) {
      showMessage("暂无对标账号结果可复制", "warning");
      return;
    }

    navigator.clipboard
      .writeText(text)
      .then(() => {
        const original = btn.innerHTML;
        btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> 已复制`;
        setTimeout(() => {
          btn.innerHTML = original;
        }, 1500);
      })
      .catch(() => {
        showMessage("复制失败，请稍后重试", "error");
      });
  }
  function buildBenchmarkDiscoveryShareData() {
    const result = keywordModel.keywordBenchmarkResult();
    if (!result) {
      return null;
    }
    const candidates = Array.isArray(result.candidates) ? result.candidates : [];
    return {
      keyword: String(result.keyword || "").trim(),
      sampleCount: Number(result.sampleCount) || 0,
      candidateCount: Number(result.candidateCount) || 0,
      minOccurrence: Number(result.minOccurrence) || 2,
      candidates: candidates.slice(0, 4).map((candidate, index) => {
        const profile = candidate.profile || null;
        const analysis =
          candidate.analysis || buildBenchmarkDiscoveryFallbackAnalysis(candidate);
        return {
          rank: index + 1,
          name:
            String(profile?.bloggerName || candidate.authorName || "").trim() ||
            `候选账号 ${index + 1}`,
          recommendationReason: String(
            analysis.recommendationReason || "",
          ).trim(),
          focusAssessment: String(analysis.focusAssessment || "").trim(),
          growthPotential: String(analysis.growthPotential || "medium").trim(),
          tags: Array.isArray(analysis.tags)
            ? analysis.tags.filter(Boolean).slice(0, 4).map((item) => String(item))
            : [],
          evidence: buildBenchmarkDiscoveryCandidateEvidence(candidate),
          works: buildBenchmarkDiscoveryRepresentativeWorks(candidate, 2),
        };
      }),
      ts: Date.now(),
    };
  }
  function handleShareBenchmarkDiscoveryAsImage() {
    const data = buildBenchmarkDiscoveryShareData();
    if (!data) {
      showMessage("暂无对标账号结果可分享", "warning");
      return;
    }
    renderBenchmarkDiscoveryCardToImage(data);
  }
  function handleCopyKeywordOpportunity(btn) {
    const text = buildKeywordOpportunityShareText();
    if (!text || !btn) {
      return;
    }

    navigator.clipboard
      .writeText(text)
      .then(() => {
        const original = btn.innerHTML;
        btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> 已复制`;
        setTimeout(() => {
          btn.innerHTML = original;
        }, 1500);
      })
      .catch(() => {});
  }
  function buildKeywordOpportunityShareText() {
    const result = keywordModel.keywordOpportunityResult();
    if (!result) {
      return "";
    }

    const topicDirections = Array.isArray(result.hotTopicDirections)
      ? result.hotTopicDirections
      : [];
    const recommendedAngles = Array.isArray(result.recommendedAngles)
      ? result.recommendedAngles
      : [];
    const subtopics = Array.isArray(result.coreWinningSubtopics)
      ? result.coreWinningSubtopics
      : [];
    const ruleMetrics = result.ruleMetrics || {};
    const metrics = [
      `热度：${ruleMetrics.heatLevel === "high" ? "高" : ruleMetrics.heatLevel === "medium" ? "中" : "低"}`,
      `高位区间：${
        ruleMetrics.highBandEnd > 0
          ? `${ruleMetrics.highBandStart}-${ruleMetrics.highBandEnd}`
          : "未识别"
      }`,
      `断层跌幅：${
        ruleMetrics.cliffDropRatio > 0
          ? `${Math.round(ruleMetrics.cliffDropRatio * 100)}%`
          : "不明显"
      }`,
      `高位均赞：${formatOpportunityMetric(ruleMetrics.highBandAvgLikes)}`,
      `中位赞：${formatOpportunityMetric(ruleMetrics.medianLikes)}`,
    ];

    const lines = [
      `【判断赛道机会】${String(result.keyword || "").trim()}`,
    ];
    if (result.distributionSummary) {
      lines.push(`分布：${String(result.distributionSummary).trim()}`);
    }
    lines.push(`指标：${metrics.join("｜")}`);

    if (subtopics.length > 0) {
      lines.push("");
      lines.push("【核心爆款细分词】");
      lines.push(subtopics.join("、"));
    }

    if (topicDirections.length > 0) {
      lines.push("");
      lines.push("【爆款主题方向】");
      const bandLabels = {
        high: "高赞区",
        mid: "中赞区",
        low: "低赞区",
        high_mid: "高赞区+中赞区",
        mid_low: "中赞区+低赞区",
        all: "高赞区+中赞区+低赞区",
      };
      topicDirections.forEach((direction, index) => {
        const name = String(direction?.name || "").trim() || `方向 ${index + 1}`;
        const sampleCount = Number(direction?.sampleCount) || 0;
        const shareRatio = `${Math.round((Number(direction?.shareRatio) || 0) * 100)}%`;
        const bandLabel = bandLabels[direction?.bandPresence] || "";
        const titles = Array.isArray(direction?.representativeTitles)
          ? direction.representativeTitles.filter(Boolean)
          : [];
        lines.push(
          `${index + 1}. ${name}${bandLabel ? `【${bandLabel}】` : ""}｜${sampleCount} 篇｜占比 ${shareRatio}`,
        );
        if (direction?.whyItWorks) {
          lines.push(String(direction.whyItWorks).trim());
        }
        if (titles.length > 0) {
          titles.forEach((t) => lines.push(`  · ${String(t).trim()}`));
        }
      });
    }

    if (recommendedAngles.length > 0) {
      lines.push("");
      lines.push("【新号优先选题】");
      recommendedAngles.forEach((angle, index) => {
        lines.push(
          `${index + 1}. ${String(angle?.title || "").trim() || `选题 ${index + 1}`}`,
        );
        if (angle?.audiencePainPoint) {
          lines.push(`  ${String(angle.audiencePainPoint).trim()}`);
        }
        if (angle?.formatSuggestion) {
          lines.push(`  形式建议：${String(angle.formatSuggestion).trim()}`);
        }
        if (angle?.executionHint) {
          lines.push(`  执行提示：${String(angle.executionHint).trim()}`);
        }
      });
    }

    return lines.join("\n").trim();
  }
  function buildKeywordOpportunityShareData() {
    const result = keywordModel.keywordOpportunityResult();
    if (!result) {
      return null;
    }

    const ruleMetrics = result.ruleMetrics || {};
    return {
      keyword: String(result.keyword || "").trim(),
      distributionSummary: String(result.distributionSummary || "").trim(),
      metrics: [
        {
          label: "热度",
          value:
            ruleMetrics.heatLevel === "high"
              ? "高"
              : ruleMetrics.heatLevel === "medium"
                ? "中"
                : "低",
        },
        {
          label: "高位区间",
          value:
            ruleMetrics.highBandEnd > 0
              ? `${ruleMetrics.highBandStart}-${ruleMetrics.highBandEnd}`
              : "未识别",
        },
        {
          label: "断层跌幅",
          value:
            ruleMetrics.cliffDropRatio > 0
              ? `${Math.round(ruleMetrics.cliffDropRatio * 100)}%`
              : "不明显",
        },
        {
          label: "高位均赞",
          value: formatOpportunityMetric(ruleMetrics.highBandAvgLikes),
        },
        {
          label: "中位赞",
          value: formatOpportunityMetric(ruleMetrics.medianLikes),
        },
      ],
      subtopics: Array.isArray(result.coreWinningSubtopics)
        ? result.coreWinningSubtopics.filter(Boolean).map((item) => String(item))
        : [],
      directions: Array.isArray(result.hotTopicDirections)
        ? result.hotTopicDirections.map((direction) => ({
            name: String(direction?.name || "").trim(),
            shareRatio: Math.round((Number(direction?.shareRatio) || 0) * 100),
            sampleCount: Number(direction?.sampleCount) || 0,
            whyItWorks: String(direction?.whyItWorks || "").trim(),
            bandPresence: String(direction?.bandPresence || "all").trim(),
          }))
        : [],
      angles: Array.isArray(result.recommendedAngles)
        ? result.recommendedAngles.map((angle) => ({
            title: String(angle?.title || "").trim(),
            audiencePainPoint: String(angle?.audiencePainPoint || "").trim(),
            formatSuggestion: String(angle?.formatSuggestion || "").trim(),
            executionHint: String(angle?.executionHint || "").trim(),
          }))
        : [],
      ts: Date.now(),
    };
  }
  function handleShareKeywordOpportunityAsImage() {
    const data = buildKeywordOpportunityShareData();
    if (!data) {
      showMessage("暂无判断赛道机会结果可分享", "warning");
      return;
    }
    renderKeywordOpportunityCardToImage(data);
  }
  function handleCopyInsight(btn) {
    const draft = getKeywordInsightState();
    const analysis = draft.analysisResult;
    if (!analysis || !btn) return;

    const lines = [];
    const summary = String(analysis.summary || "").trim();
    if (summary) {
      lines.push("【需求洞察】");
      lines.push(summary);
    }
    const categories = Array.isArray(analysis.categories)
      ? analysis.categories
      : [];
    for (const category of categories) {
      const name = String(category?.name || "").trim();
      const icon = String(category?.icon || "").trim();
      const insight = String(category?.insight || "").trim();
      const keywords = Array.isArray(category?.keywords) ? category.keywords : [];
      lines.push("");
      lines.push(`${icon} ${name}`.trim());
      if (insight) lines.push(insight);
      if (keywords.length > 0) lines.push(keywords.join("、"));
    }

    const text = lines.join("\n").trim();
    if (!text) return;

    navigator.clipboard
      .writeText(text)
      .then(() => {
        const original = btn.innerHTML;
        btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> 已复制`;
        setTimeout(() => {
          btn.innerHTML = original;
        }, 1500);
      })
      .catch(() => {});
  }
  function buildInsightShareData() {
    const draft = getKeywordInsightState();
    const batchDraft = getBatchDraftForPlatform();
    const analysis = draft.analysisResult;
    if (!analysis) return null;
    const categories = Array.isArray(analysis.categories)
      ? analysis.categories
      : [];
    return {
      seedKeyword: batchDraft.seedKeyword || "",
      totalKeywords: keywordModel.expandedKeywordsBuffer().length,
      summary: analysis.summary || "",
      categories: categories.map((cat) => {
        const result = {
          id: cat.id || "",
          icon: cat.icon || "",
          name: cat.name || "",
          insight: cat.insight || "",
          keywords: Array.isArray(cat.keywords) ? cat.keywords : [],
        };
        const sampleResult = draft.sampleResultsByCategoryId?.[cat.id];
        if (sampleResult?.samples?.length) {
          result.sampleKeyword = sampleResult.usedKeyword || "";
          result.samples = sampleResult.samples.map((s) => ({
            title: s.title || "",
            author: s.author || "",
            likes: s.likes || 0,
          }));
        }
        return result;
      }),
      ts: Date.now(),
    };
  }
  function handleShareAsImage() {
    const data = buildInsightShareData();
    if (!data) {
      showMessage("暂无洞察结果可分享", "warning");
      return;
    }

    renderInsightCardToImage(data);
  }
  function renderInsightCardToImage(data) {
    const dpr = window.devicePixelRatio || 2;
    const W = 640;
    const PAD = 32;
    const CONTENT_W = W - PAD * 2;

    const catColors = [
      {
        accent: "#4F8BF5",
        light: "#eef3ff",
        chip: "#dbeafe",
        chipText: "#2563eb",
        bar: ["#4F8BF5", "#93bbfd"],
      },
      {
        accent: "#8B5CF6",
        light: "#f0eeff",
        chip: "#ede9fe",
        chipText: "#6d28d9",
        bar: ["#8B5CF6", "#c4b5fd"],
      },
      {
        accent: "#EC4899",
        light: "#fdf2f8",
        chip: "#fce7f3",
        chipText: "#be185d",
        bar: ["#EC4899", "#f9a8d4"],
      },
      {
        accent: "#F97316",
        light: "#fff7ed",
        chip: "#ffedd5",
        chipText: "#c2410c",
        bar: ["#F97316", "#fdba74"],
      },
    ];

    const logoImg = createImage();
    logoImg.src = chrome.runtime.getURL("images/icon128.png");

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.textBaseline = "top";

    function measureLines(text, fontSize, maxWidth) {
      ctx.font = `${fontSize}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
      const words = text.split("");
      const lines = [];
      let currentLine = "";
      for (const char of words) {
        const test = currentLine + char;
        if (ctx.measureText(test).width > maxWidth && currentLine) {
          lines.push(currentLine);
          currentLine = char;
        } else {
          currentLine = test;
        }
      }
      if (currentLine) lines.push(currentLine);
      return lines;
    }

    function preCalcHeight() {
      let h = 0;
      h += 100;
      const summaryLines = measureLines(data.summary || "", 14, CONTENT_W);
      h += 30 + summaryLines.length * 22 + 20;
      h += 24;
      for (const cat of data.categories) {
        h += 44;
        const insightLines = measureLines(cat.insight || "", 13, CONTENT_W - 24);
        h += insightLines.length * 20 + 8;
        const keywords = cat.keywords || [];
        if (keywords.length > 0) {
          let rowW = 0;
          let rows = 1;
          ctx.font = `12px -apple-system, "PingFang SC", sans-serif`;
          for (const kw of keywords) {
            const chipW = ctx.measureText(kw).width + 22;
            if (rowW + chipW + 6 > CONTENT_W - 24 && rowW > 0) {
              rows++;
              rowW = chipW + 6;
            } else {
              rowW += chipW + 6;
            }
          }
          h += rows * 28 + 10;
        }
        h += 16;
      }
      h += 36;
      return h;
    }

    function drawCard() {
      const H = preCalcHeight();
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.scale(dpr, dpr);
      ctx.textBaseline = "top";

      const gradient = ctx.createLinearGradient(0, 0, W, H);
      gradient.addColorStop(0, "#f8f6ff");
      gradient.addColorStop(0.4, "#fdf2f8");
      gradient.addColorStop(0.7, "#eef3ff");
      gradient.addColorStop(1, "#fff7ed");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, W, H);

      ctx.fillStyle = "#ffffff";
      roundRect(ctx, 16, 16, W - 32, H - 32, 16);
      ctx.fill();
      ctx.save();
      ctx.shadowColor = "rgba(99,102,241,0.08)";
      ctx.shadowBlur = 24;
      ctx.restore();

      let y = 16;

      const headerH = 88;
      const hGrad = ctx.createLinearGradient(16, y, W - 16, y);
      hGrad.addColorStop(0, "#4F8BF5");
      hGrad.addColorStop(0.4, "#8B5CF6");
      hGrad.addColorStop(0.75, "#EC4899");
      hGrad.addColorStop(1, "#F43F5E");
      ctx.fillStyle = hGrad;
      roundRectTop(ctx, 16, y, W - 32, headerH, 16);
      ctx.fill();

      ctx.fillStyle = "rgba(255,255,255,0.2)";
      const seedText = `🔍 ${data.seedKeyword}`;
      ctx.font = `500 14px -apple-system, "PingFang SC", sans-serif`;
      const seedW = ctx.measureText(seedText).width + 24;
      roundRect(ctx, PAD, y + 16, seedW, 28, 14);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.fillText(seedText, PAD + 12, y + 22);

      ctx.fillStyle = "#ffffff";
      ctx.font = `bold 20px -apple-system, "PingFang SC", sans-serif`;
      ctx.fillText("关键词需求洞察", PAD, y + 56);

      const totalKw = data.categories.reduce(
        (s, c) => s + (c.keywords?.length || 0),
        0,
      );
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.font = `500 12px -apple-system, "PingFang SC", sans-serif`;
      const statsText = `${totalKw} 个关联词 · ${data.categories.length} 个需求方向`;
      const statsW = ctx.measureText(statsText).width;
      ctx.fillText(statsText, W - PAD - 16 - statsW, y + 60);

      y += headerH + 20;

      ctx.fillStyle = "#8B5CF6";
      ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
      ctx.fillText("洞察摘要", PAD, y);
      y += 20;

      ctx.fillStyle = "#374151";
      ctx.font = `14px -apple-system, "PingFang SC", sans-serif`;
      const summaryLines = measureLines(data.summary || "", 14, CONTENT_W);
      for (const line of summaryLines) {
        ctx.fillText(line, PAD, y);
        y += 22;
      }
      y += 16;

      ctx.fillStyle = "#EC4899";
      ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
      ctx.fillText("需求方向", PAD, y);
      y += 24;

      for (let ci = 0; ci < data.categories.length; ci++) {
        const cat = data.categories[ci];
        const cc = catColors[ci % catColors.length];
        const keywords = cat.keywords || [];
        const pct =
          totalKw > 0 ? Math.round((keywords.length / totalKw) * 100) : 0;

        ctx.fillStyle = "#1a1a2e";
        ctx.font = `600 14px -apple-system, "PingFang SC", sans-serif`;
        ctx.fillText(`${cat.icon || "📌"} ${cat.name}`, PAD + 4, y);

        ctx.fillStyle = cc.accent;
        ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
        const pctText = `${keywords.length} 词 · ${pct}%`;
        const pctW = ctx.measureText(pctText).width;
        ctx.fillText(pctText, W - PAD - 16 - pctW, y + 2);
        y += 22;

        ctx.fillStyle = "#f3f4f6";
        roundRect(ctx, PAD + 4, y, CONTENT_W - 8, 4, 2);
        ctx.fill();
        const barGrad = ctx.createLinearGradient(
          PAD + 4,
          y,
          PAD + 4 + (CONTENT_W - 8),
          y,
        );
        barGrad.addColorStop(0, cc.bar[0]);
        barGrad.addColorStop(1, cc.bar[1]);
        ctx.fillStyle = barGrad;
        roundRect(
          ctx,
          PAD + 4,
          y,
          Math.max(((CONTENT_W - 8) * pct) / 100, 2),
          4,
          2,
        );
        ctx.fill();
        y += 12;

        if (cat.insight) {
          ctx.fillStyle = "#6b7280";
          ctx.font = `13px -apple-system, "PingFang SC", sans-serif`;
          const insightLines = measureLines(cat.insight, 13, CONTENT_W - 24);
          for (const line of insightLines) {
            ctx.fillText(line, PAD + 12, y);
            y += 20;
          }
          y += 4;
        }

        if (keywords.length > 0) {
          let rowX = PAD + 12;
          ctx.font = `12px -apple-system, "PingFang SC", sans-serif`;
          for (const kw of keywords) {
            const chipW = ctx.measureText(kw).width + 22;
            if (rowX + chipW > W - PAD - 12 && rowX > PAD + 12) {
              rowX = PAD + 12;
              y += 28;
            }
            ctx.fillStyle = cc.chip;
            roundRect(ctx, rowX, y, chipW, 24, 12);
            ctx.fill();
            ctx.fillStyle = cc.chipText;
            ctx.fillText(kw, rowX + 11, y + 6);
            rowX += chipW + 6;
          }
          y += 34;
        }

        y += 8;
      }

      y += 8;
      ctx.fillStyle = "#e5e7eb";
      ctx.fillRect(PAD, y, CONTENT_W, 0.5);
      y += 36;

      const logoSize = 16;
      const gap = 6;
      const brandText = "StarVoice 星语";
      ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
      const brandTW = ctx.measureText(brandText).width;
      const urlText = "https://voice.minilife.online";
      ctx.font = `500 10px -apple-system, "PingFang SC", sans-serif`;
      const urlTW = ctx.measureText(urlText).width;
      const pillPadX = 8;
      const pillPadY = 3;
      const pillW = urlTW + pillPadX * 2;
      const pillH = 16;
      const urlGap = 10;
      const line1W = logoSize + gap + brandTW + urlGap + pillW;
      const line1X = (W - line1W) / 2;

      ctx.globalAlpha = 0.8;
      if (logoImg.complete && logoImg.naturalWidth > 0) {
        ctx.save();
        roundRect(ctx, line1X, y - 1, logoSize, logoSize, 3);
        ctx.clip();
        ctx.drawImage(logoImg, line1X, y - 1, logoSize, logoSize);
        ctx.restore();
      }

      ctx.fillStyle = "#9ca3af";
      ctx.font = `500 11px -apple-system, "PingFang SC", sans-serif`;
      ctx.fillText(brandText, line1X + logoSize + gap, y);

      const pillX = line1X + logoSize + gap + brandTW + urlGap;
      const pillY = y - 1;
      ctx.fillStyle = "#f5f3ff";
      roundRect(ctx, pillX, pillY, pillW, pillH, 8);
      ctx.fill();
      ctx.fillStyle = "#a78bfa";
      ctx.font = `400 10px -apple-system, "PingFang SC", sans-serif`;
      ctx.fillText(urlText, pillX + pillPadX, pillY + pillPadY);

      y += 20;
      const features =
        "账号监控｜低粉爆款筛选｜搜索词洞察｜数据采集｜评论分析｜客资线索";
      ctx.fillStyle = "#c0c0c0";
      ctx.font = `400 9px -apple-system, "PingFang SC", sans-serif`;
      ctx.globalAlpha = 1.0;
      const featW = ctx.measureText(features).width;
      ctx.fillText(features, (W - featW) / 2, y);

      canvas.toBlob((blob) => {
        if (!blob) {
          showMessage("图片生成失败", "error");
          return;
        }
        showInsightImagePreview(blob, data.seedKeyword || "share");
      }, "image/png");
    }

    if (logoImg.complete) {
      drawCard();
    } else {
      logoImg.onload = drawCard;
      logoImg.onerror = drawCard;
    }
  }
  function renderKeywordOpportunityCardToImage(data) {
    const dpr = window.devicePixelRatio || 2;
    const W = 640;
    const PAD = 32;
    const CONTENT_W = W - PAD * 2;
    const logoImg = createImage();
    logoImg.src = chrome.runtime.getURL("images/icon128.png");

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.textBaseline = "top";

    function measureLines(text, fontSize, maxWidth) {
      ctx.font = `${fontSize}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
      const chars = String(text || "").split("");
      const lines = [];
      let currentLine = "";
      for (const char of chars) {
        const test = currentLine + char;
        if (ctx.measureText(test).width > maxWidth && currentLine) {
          lines.push(currentLine);
          currentLine = char;
        } else {
          currentLine = test;
        }
      }
      if (currentLine) {
        lines.push(currentLine);
      }
      return lines;
    }

    function calcChipRows(items, maxWidth, baseX, gap = 6) {
      if (!Array.isArray(items) || items.length === 0) {
        return 0;
      }
      let rows = 1;
      let rowX = baseX;
      ctx.font = `12px -apple-system, "PingFang SC", sans-serif`;
      for (const item of items) {
        const text = String(item || "").trim();
        if (!text) continue;
        const chipW = ctx.measureText(text).width + 22;
        if (rowX + chipW > W - PAD - 12 && rowX > baseX) {
          rows += 1;
          rowX = baseX + chipW + gap;
        } else {
          rowX += chipW + gap;
        }
      }
      return rows;
    }

    function preCalcHeight() {
      let h = 0;
      h += 122;
      const distributionLines = measureLines(
        data.distributionSummary || "",
        14,
        CONTENT_W,
      );
      h += distributionLines.length * 22 + 30;
      h += Math.ceil((data.metrics.length || 0) / 2) * 82 + 22;
      h += 28;
      const subtopicRows = calcChipRows(data.subtopics || [], CONTENT_W, PAD);
      h += Math.max(subtopicRows, 1) * 30 + 24;
      h += 24;
      if (Array.isArray(data.directions) && data.directions.length > 0) {
        for (const direction of data.directions || []) {
          h += 52;
          const whyLines = measureLines(
            direction.whyItWorks || "",
            13,
            CONTENT_W - 24,
          );
          h += whyLines.length * 20 + 14;
        }
      } else {
        h += 34;
      }
      h += 24;
      if (Array.isArray(data.angles) && data.angles.length > 0) {
        for (const angle of data.angles || []) {
          const body = [
            directionSafeText(angle.audiencePainPoint),
            angle.formatSuggestion
              ? `形式建议：${directionSafeText(angle.formatSuggestion)}`
              : "",
            angle.executionHint
              ? `执行提示：${directionSafeText(angle.executionHint)}`
              : "",
          ]
            .filter(Boolean)
            .join(" · ");
          const titleLines = measureLines(angle.title || "", 14, CONTENT_W - 24);
          const bodyLines = measureLines(body, 13, CONTENT_W - 24);
          h += 34 + titleLines.length * 20 + bodyLines.length * 19 + 18;
        }
      } else {
        h += 34;
      }
      h += 68;
      return h;
    }

    function directionSafeText(value) {
      return String(value || "").trim();
    }

    function drawCard() {
      const H = preCalcHeight();
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.scale(dpr, dpr);
      ctx.textBaseline = "top";

      const bg = ctx.createLinearGradient(0, 0, W, H);
      bg.addColorStop(0, "#fff8ef");
      bg.addColorStop(0.4, "#fffdf7");
      bg.addColorStop(0.75, "#f4f7ff");
      bg.addColorStop(1, "#eef9ff");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      ctx.fillStyle = "#ffffff";
      roundRect(ctx, 16, 16, W - 32, H - 32, 18);
      ctx.fill();

      let y = 16;
      const headerH = 104;
      const headerGrad = ctx.createLinearGradient(16, y, W - 16, y);
      headerGrad.addColorStop(0, "#F97316");
      headerGrad.addColorStop(0.55, "#F59E0B");
      headerGrad.addColorStop(1, "#FB7185");
      ctx.fillStyle = headerGrad;
      roundRectTop(ctx, 16, y, W - 32, headerH, 18);
      ctx.fill();

      ctx.fillStyle = "rgba(255,255,255,0.22)";
      ctx.font = `500 14px -apple-system, "PingFang SC", sans-serif`;
      const keywordText = `主词 ${data.keyword || "未命名"}`;
      const keywordW = ctx.measureText(keywordText).width + 24;
      roundRect(ctx, PAD, y + 18, keywordW, 28, 14);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.fillText(keywordText, PAD + 12, y + 24);

      ctx.font = `bold 22px -apple-system, "PingFang SC", sans-serif`;
      ctx.fillText("判断赛道机会", PAD, y + 58);

      y += headerH + 24;

      if (data.distributionSummary) {
        ctx.fillStyle = "#6b7280";
        ctx.font = `14px -apple-system, "PingFang SC", sans-serif`;
        const summaryLines = measureLines(
          data.distributionSummary,
          14,
          CONTENT_W,
        );
        for (const line of summaryLines) {
          ctx.fillText(line, PAD, y);
          y += 22;
        }
        y += 16;
      }

      const metricCols = 2;
      const metricGap = 12;
      const metricW = (CONTENT_W - metricGap) / metricCols;
      const metricH = 70;
      (data.metrics || []).forEach((metric, index) => {
        const col = index % metricCols;
        const row = Math.floor(index / metricCols);
        const x = PAD + col * (metricW + metricGap);
        const my = y + row * (metricH + 12);
        ctx.fillStyle = "#fff7ed";
        roundRect(ctx, x, my, metricW, metricH, 16);
        ctx.fill();
        ctx.fillStyle = "#9a3412";
        ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
        ctx.fillText(metric.label || "", x + 16, my + 14);
        ctx.fillStyle = "#111827";
        ctx.font = `bold 18px -apple-system, "PingFang SC", sans-serif`;
        ctx.fillText(metric.value || "-", x + 16, my + 34);
      });
      y +=
        Math.ceil((data.metrics.length || 0) / metricCols) * (metricH + 12) + 8;

      ctx.fillStyle = "#f59e0b";
      ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
      ctx.fillText("核心爆款细分词", PAD, y);
      y += 22;

      if (Array.isArray(data.subtopics) && data.subtopics.length > 0) {
        let rowX = PAD;
        ctx.font = `12px -apple-system, "PingFang SC", sans-serif`;
        for (const item of data.subtopics) {
          const text = String(item || "").trim();
          if (!text) continue;
          const chipW = ctx.measureText(text).width + 22;
          if (rowX + chipW > W - PAD && rowX > PAD) {
            rowX = PAD;
            y += 30;
          }
          ctx.fillStyle = "#ffedd5";
          roundRect(ctx, rowX, y, chipW, 24, 12);
          ctx.fill();
          ctx.fillStyle = "#c2410c";
          ctx.fillText(text, rowX + 11, y + 6);
          rowX += chipW + 6;
        }
        y += 34;
      } else {
        ctx.fillStyle = "#9ca3af";
        ctx.font = `13px -apple-system, "PingFang SC", sans-serif`;
        ctx.fillText("暂无明确细分切口", PAD, y);
        y += 26;
      }

      ctx.fillStyle = "#ef4444";
      ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
      ctx.fillText("爆款主题方向", PAD, y);
      y += 24;

      if (Array.isArray(data.directions) && data.directions.length > 0) {
        for (const direction of data.directions || []) {
          ctx.fillStyle = "#fffaf5";
          roundRect(ctx, PAD, y, CONTENT_W, 72, 16);
          ctx.fill();
          ctx.fillStyle = "#111827";
          ctx.font = `600 14px -apple-system, "PingFang SC", sans-serif`;
          ctx.fillText(direction.name || "未命名方向", PAD + 14, y + 14);
          const metaText = `${direction.sampleCount || 0} 篇 · ${direction.shareRatio || 0}%`;
          ctx.fillStyle = "#f97316";
          ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
          const metaW = ctx.measureText(metaText).width;
          ctx.fillText(metaText, PAD + CONTENT_W - 14 - metaW, y + 16);
          const whyLines = measureLines(
            direction.whyItWorks || "",
            13,
            CONTENT_W - 28,
          );
          ctx.fillStyle = "#6b7280";
          ctx.font = `13px -apple-system, "PingFang SC", sans-serif`;
          let innerY = y + 38;
          for (const line of whyLines) {
            ctx.fillText(line, PAD + 14, innerY);
            innerY += 20;
          }
          y = Math.max(y + 72, innerY + 12);
        }
      } else {
        ctx.fillStyle = "#9ca3af";
        ctx.font = `13px -apple-system, "PingFang SC", sans-serif`;
        ctx.fillText("当前样本中还没有稳定聚合出足够清晰的主题方向", PAD, y);
        y += 26;
      }

      y += 8;
      ctx.fillStyle = "#6366f1";
      ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
      ctx.fillText("新号优先选题", PAD, y);
      y += 24;

      if (Array.isArray(data.angles) && data.angles.length > 0) {
        for (const angle of data.angles || []) {
          const body = [
            directionSafeText(angle.audiencePainPoint),
            angle.formatSuggestion
              ? `形式建议：${directionSafeText(angle.formatSuggestion)}`
              : "",
            angle.executionHint
              ? `执行提示：${directionSafeText(angle.executionHint)}`
              : "",
          ]
            .filter(Boolean)
            .join(" · ");
          const titleLines = measureLines(angle.title || "", 14, CONTENT_W - 28);
          const bodyLines = measureLines(body, 13, CONTENT_W - 28);
          const cardH =
            18 + titleLines.length * 20 + 8 + bodyLines.length * 19 + 16;
          ctx.fillStyle = "#f5f3ff";
          roundRect(ctx, PAD, y, CONTENT_W, cardH, 16);
          ctx.fill();
          ctx.fillStyle = "#312e81";
          ctx.font = `600 14px -apple-system, "PingFang SC", sans-serif`;
          let innerY = y + 14;
          for (const line of titleLines) {
            ctx.fillText(line, PAD + 14, innerY);
            innerY += 20;
          }
          ctx.fillStyle = "#5b5f97";
          ctx.font = `13px -apple-system, "PingFang SC", sans-serif`;
          innerY += 4;
          for (const line of bodyLines) {
            ctx.fillText(line, PAD + 14, innerY);
            innerY += 19;
          }
          y += cardH + 10;
        }
      } else {
        ctx.fillStyle = "#9ca3af";
        ctx.font = `13px -apple-system, "PingFang SC", sans-serif`;
        ctx.fillText("当前还没有生成可直接执行的主词选题", PAD, y);
        y += 26;
      }

      y += 8;
      ctx.fillStyle = "#e5e7eb";
      ctx.fillRect(PAD, y, CONTENT_W, 0.5);
      y += 18;

      const brandText = "StarVoice 星语";
      const urlText = "https://voice.minilife.online";
      const logoSize = 16;
      const gap = 6;
      ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
      const brandW = ctx.measureText(brandText).width;
      ctx.font = `500 10px -apple-system, "PingFang SC", sans-serif`;
      const urlW = ctx.measureText(urlText).width;
      const pillW = urlW + 16;
      const lineW = logoSize + gap + brandW + 10 + pillW;
      const startX = (W - lineW) / 2;

      if (logoImg.complete && logoImg.naturalWidth > 0) {
        ctx.save();
        roundRect(ctx, startX, y - 1, logoSize, logoSize, 3);
        ctx.clip();
        ctx.drawImage(logoImg, startX, y - 1, logoSize, logoSize);
        ctx.restore();
      }
      ctx.fillStyle = "#9ca3af";
      ctx.font = `500 11px -apple-system, "PingFang SC", sans-serif`;
      ctx.fillText(brandText, startX + logoSize + gap, y);
      const pillX = startX + logoSize + gap + brandW + 10;
      ctx.fillStyle = "#eef2ff";
      roundRect(ctx, pillX, y - 1, pillW, 16, 8);
      ctx.fill();
      ctx.fillStyle = "#818cf8";
      ctx.font = `400 10px -apple-system, "PingFang SC", sans-serif`;
      ctx.fillText(urlText, pillX + 8, y + 2);

      canvas.toBlob((blob) => {
        if (!blob) {
          showMessage("图片生成失败", "error");
          return;
        }
        showInsightImagePreview(blob, data.keyword || "opportunity");
      }, "image/png");
    }

    if (logoImg.complete) {
      drawCard();
    } else {
      logoImg.onload = drawCard;
      logoImg.onerror = drawCard;
    }
  }
  function renderBenchmarkDiscoveryCardToImage(data) {
    const dpr = window.devicePixelRatio || 2;
    const W = 640;
    const PAD = 32;
    const CONTENT_W = W - PAD * 2;
    const logoImg = createImage();
    logoImg.src = chrome.runtime.getURL("images/icon128.png");

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.textBaseline = "top";

    function measureLines(text, fontSize, maxWidth) {
      ctx.font = `${fontSize}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
      const chars = String(text || "").split("");
      const lines = [];
      let currentLine = "";
      for (const char of chars) {
        const test = currentLine + char;
        if (ctx.measureText(test).width > maxWidth && currentLine) {
          lines.push(currentLine);
          currentLine = char;
        } else {
          currentLine = test;
        }
      }
      if (currentLine) {
        lines.push(currentLine);
      }
      return lines;
    }

    function measureChipRows(tags, maxWidth) {
      if (!Array.isArray(tags) || tags.length === 0) {
        return 0;
      }
      let rows = 1;
      let rowW = 0;
      ctx.font = `12px -apple-system, "PingFang SC", sans-serif`;
      tags.forEach((tag) => {
        const text = String(tag || "").trim();
        if (!text) return;
        const chipW = ctx.measureText(text).width + 22;
        if (rowW + chipW + 6 > maxWidth && rowW > 0) {
          rows += 1;
          rowW = chipW + 6;
        } else {
          rowW += chipW + 6;
        }
      });
      return rows;
    }

    function candidateHeight(candidate) {
      const innerW = CONTENT_W - 28;
      const reasonLines = measureLines(
        candidate.recommendationReason || "",
        14,
        innerW,
      );
      const focusLines = measureLines(candidate.focusAssessment || "", 12, innerW);
      const tagRows = measureChipRows(candidate.tags || [], innerW);
      const evidenceLines = (candidate.evidence || [])
        .slice(0, 3)
        .flatMap((item) => measureLines(item, 12, innerW - 12));
      const workLines = (candidate.works || [])
        .slice(0, 2)
        .flatMap((item) =>
          measureLines(
            `${item.title}  赞 ${formatOpportunityMetric(item.likes)}`,
            12,
            innerW - 12,
          ),
        );
      return (
        52 +
        reasonLines.length * 21 +
        focusLines.length * 19 +
        Math.max(tagRows, 1) * 25 +
        28 +
        evidenceLines.length * 18 +
        (workLines.length > 0 ? 28 + workLines.length * 18 : 0) +
        24
      );
    }

    function preCalcHeight() {
      const candidates = Array.isArray(data.candidates) ? data.candidates : [];
      let h = 0;
      h += 122;
      const summaryLines = measureLines(
        `从 ${data.sampleCount || 0} 条搜索结果中筛出 ${data.candidateCount || 0} 个候选账号，入围门槛为样本出现 ${data.minOccurrence || 2} 次。`,
        14,
        CONTENT_W,
      );
      h += summaryLines.length * 22 + 28;
      candidates.forEach((candidate) => {
        h += candidateHeight(candidate) + 12;
      });
      h += 68;
      return h;
    }

    function drawPill(text, x, y, color, bg) {
      const safeText = String(text || "").trim();
      if (!safeText) return 0;
      ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
      const w = ctx.measureText(safeText).width + 22;
      ctx.fillStyle = bg;
      roundRect(ctx, x, y, w, 23, 12);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.fillText(safeText, x + 11, y + 6);
      return w;
    }

    function drawCard() {
      const H = preCalcHeight();
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.scale(dpr, dpr);
      ctx.textBaseline = "top";

      const bg = ctx.createLinearGradient(0, 0, W, H);
      bg.addColorStop(0, "#f0fdfa");
      bg.addColorStop(0.46, "#ffffff");
      bg.addColorStop(1, "#eef2ff");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      ctx.fillStyle = "#ffffff";
      roundRect(ctx, 16, 16, W - 32, H - 32, 18);
      ctx.fill();

      let y = 16;
      const headerH = 104;
      const headerGrad = ctx.createLinearGradient(16, y, W - 16, y);
      headerGrad.addColorStop(0, "#0F766E");
      headerGrad.addColorStop(0.58, "#14B8A6");
      headerGrad.addColorStop(1, "#6366F1");
      ctx.fillStyle = headerGrad;
      roundRectTop(ctx, 16, y, W - 32, headerH, 18);
      ctx.fill();

      ctx.fillStyle = "rgba(255,255,255,0.22)";
      ctx.font = `500 14px -apple-system, "PingFang SC", sans-serif`;
      const keywordText = `关键词 ${data.keyword || "未命名"}`;
      const keywordW = ctx.measureText(keywordText).width + 24;
      roundRect(ctx, PAD, y + 18, keywordW, 28, 14);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.fillText(keywordText, PAD + 12, y + 24);

      ctx.font = `bold 22px -apple-system, "PingFang SC", sans-serif`;
      ctx.fillText("对标账号推荐", PAD, y + 58);
      y += headerH + 24;

      const summary = `从 ${data.sampleCount || 0} 条搜索结果中筛出 ${data.candidateCount || 0} 个候选账号，入围门槛为样本出现 ${data.minOccurrence || 2} 次。`;
      ctx.fillStyle = "#4b5563";
      ctx.font = `14px -apple-system, "PingFang SC", sans-serif`;
      measureLines(summary, 14, CONTENT_W).forEach((line) => {
        ctx.fillText(line, PAD, y);
        y += 22;
      });
      y += 18;

      const candidates = Array.isArray(data.candidates) ? data.candidates : [];
      candidates.forEach((candidate) => {
        const cardH = candidateHeight(candidate);
        ctx.fillStyle = "#f8fafc";
        roundRect(ctx, PAD, y, CONTENT_W, cardH, 16);
        ctx.fill();

        let innerY = y + 16;
        const rankBg =
          candidate.growthPotential === "high"
            ? "#dcfce7"
            : candidate.growthPotential === "low"
              ? "#e5e7eb"
              : "#fef3c7";
        const rankColor =
          candidate.growthPotential === "high"
            ? "#047857"
            : candidate.growthPotential === "low"
              ? "#475569"
              : "#92400e";
        ctx.fillStyle = rankBg;
        roundRect(ctx, PAD + 14, innerY, 34, 34, 10);
        ctx.fill();
        ctx.fillStyle = rankColor;
        ctx.font = `bold 15px -apple-system, "PingFang SC", sans-serif`;
        ctx.fillText(`#${candidate.rank || ""}`, PAD + 21, innerY + 8);

        ctx.fillStyle = "#111827";
        ctx.font = `700 17px -apple-system, "PingFang SC", sans-serif`;
        ctx.fillText(candidate.name || "未知账号", PAD + 58, innerY + 3);
        innerY += 46;

        ctx.fillStyle = "#111827";
        ctx.font = `14px -apple-system, "PingFang SC", sans-serif`;
        measureLines(
          candidate.recommendationReason || "",
          14,
          CONTENT_W - 28,
        ).forEach((line) => {
          ctx.fillText(line, PAD + 14, innerY);
          innerY += 21;
        });

        if (candidate.focusAssessment) {
          ctx.fillStyle = "#6b7280";
          ctx.font = `12px -apple-system, "PingFang SC", sans-serif`;
          measureLines(candidate.focusAssessment, 12, CONTENT_W - 28).forEach(
            (line) => {
              ctx.fillText(line, PAD + 14, innerY + 2);
              innerY += 19;
            },
          );
        }

        innerY += 8;
        let chipX = PAD + 14;
        (candidate.tags || []).forEach((tag) => {
          const text = String(tag || "").trim();
          if (!text) return;
          ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
          const w = ctx.measureText(text).width + 22;
          if (chipX + w > W - PAD - 14) {
            chipX = PAD + 14;
            innerY += 25;
          }
          drawPill(text, chipX, innerY, "#0f766e", "#ccfbf1");
          chipX += w + 6;
        });
        innerY += 32;

        ctx.fillStyle = "#0f766e";
        ctx.font = `700 12px -apple-system, "PingFang SC", sans-serif`;
        ctx.fillText("判断依据", PAD + 14, innerY);
        innerY += 20;
        ctx.fillStyle = "#4b5563";
        ctx.font = `12px -apple-system, "PingFang SC", sans-serif`;
        (candidate.evidence || []).slice(0, 3).forEach((item) => {
          measureLines(item, 12, CONTENT_W - 40).forEach((line, index) => {
            ctx.fillText(index === 0 ? `- ${line}` : `  ${line}`, PAD + 18, innerY);
            innerY += 18;
          });
        });

        const works = Array.isArray(candidate.works) ? candidate.works : [];
        if (works.length > 0) {
          innerY += 8;
          ctx.fillStyle = "#6366f1";
          ctx.font = `700 12px -apple-system, "PingFang SC", sans-serif`;
          ctx.fillText("代表作品", PAD + 14, innerY);
          innerY += 20;
          ctx.fillStyle = "#4b5563";
          ctx.font = `12px -apple-system, "PingFang SC", sans-serif`;
          works.slice(0, 2).forEach((work) => {
            const text = `${work.title}  赞 ${formatOpportunityMetric(work.likes)}`;
            measureLines(text, 12, CONTENT_W - 40).forEach((line, index) => {
              ctx.fillText(index === 0 ? `- ${line}` : `  ${line}`, PAD + 18, innerY);
              innerY += 18;
            });
          });
        }

        y += cardH + 12;
      });

      y += 6;
      ctx.fillStyle = "#e5e7eb";
      ctx.fillRect(PAD, y, CONTENT_W, 0.5);
      y += 18;

      const brandText = "StarVoice（社媒虾）";
      const urlText = "https://voice.minilife.online";
      const logoSize = 16;
      const gap = 6;
      ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
      const brandW = ctx.measureText(brandText).width;
      ctx.font = `500 10px -apple-system, "PingFang SC", sans-serif`;
      const urlW = ctx.measureText(urlText).width;
      const pillW = urlW + 16;
      const lineW = logoSize + gap + brandW + 10 + pillW;
      const startX = (W - lineW) / 2;

      if (logoImg.complete && logoImg.naturalWidth > 0) {
        ctx.save();
        roundRect(ctx, startX, y - 1, logoSize, logoSize, 3);
        ctx.clip();
        ctx.drawImage(logoImg, startX, y - 1, logoSize, logoSize);
        ctx.restore();
      }
      ctx.fillStyle = "#9ca3af";
      ctx.font = `500 11px -apple-system, "PingFang SC", sans-serif`;
      ctx.fillText(brandText, startX + logoSize + gap, y);
      const pillX = startX + logoSize + gap + brandW + 10;
      ctx.fillStyle = "#ecfeff";
      roundRect(ctx, pillX, y - 1, pillW, 16, 8);
      ctx.fill();
      ctx.fillStyle = "#14b8a6";
      ctx.font = `400 10px -apple-system, "PingFang SC", sans-serif`;
      ctx.fillText(urlText, pillX + 8, y + 2);

      canvas.toBlob((blob) => {
        if (!blob) {
          showMessage("图片生成失败", "error");
          return;
        }
        showInsightImagePreview(blob, data.keyword || "benchmark");
      }, "image/png");
    }

    if (logoImg.complete) {
      drawCard();
    } else {
      logoImg.onload = drawCard;
      logoImg.onerror = drawCard;
    }
  }
  function showInsightImagePreview(blob, seedKeyword) {
    const existing = document.getElementById("insightImagePreviewOverlay");
    if (existing) existing.remove();

    const blobUrl = URL.createObjectURL(blob);

    const overlay = document.createElement("div");
    overlay.id = "insightImagePreviewOverlay";
    overlay.className = "insight-preview-overlay";
    overlay.innerHTML = `
    <div class="insight-preview-dialog">
      <div class="insight-preview-header">
        <span class="insight-preview-title">图片预览</span>
        <button type="button" class="insight-preview-close" id="insightPreviewClose" title="关闭">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/></svg>
        </button>
      </div>
      <div class="insight-preview-body" id="insightPreviewBody">
        <img src="${blobUrl}" class="insight-preview-img" id="insightPreviewImg" alt="洞察分享图片" />
      </div>
      <div class="insight-preview-footer">
        <span class="insight-preview-zoom-hint">滚轮缩放 · 双击还原</span>
        <div class="insight-preview-actions">
          <button type="button" class="btn btn-secondary" id="insightPreviewCopy">复制</button>
          <button type="button" class="btn btn-secondary" id="insightPreviewDownload">下载</button>
        </div>
      </div>
    </div>
  `;

    document.body.appendChild(overlay);

    const body = overlay.querySelector("#insightPreviewBody");
    const img = overlay.querySelector("#insightPreviewImg");
    let scale = 1;
    let tx = 0,
      ty = 0;
    let dragging = false,
      startX = 0,
      startY = 0,
      startTx = 0,
      startTy = 0;

    const applyTransform = () => {
      img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    };

    const resetZoom = () => {
      scale = 1;
      tx = 0;
      ty = 0;
      applyTransform();
    };

    body.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.15 : 0.15;
        scale = Math.min(5, Math.max(0.5, scale + delta));
        if (scale <= 1) {
          tx = 0;
          ty = 0;
        }
        applyTransform();
      },
      {passive: false},
    );

    body.addEventListener("dblclick", (e) => {
      e.preventDefault();
      if (scale !== 1) {
        resetZoom();
      } else {
        scale = 2.5;
        applyTransform();
      }
    });

    body.addEventListener("mousedown", (e) => {
      if (scale <= 1) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startTx = tx;
      startTy = ty;
      body.classList.add("is-dragging");
      e.preventDefault();
    });

    const onMouseMove = (e) => {
      if (!dragging) return;
      tx = startTx + (e.clientX - startX);
      ty = startTy + (e.clientY - startY);
      applyTransform();
    };

    const onMouseUp = () => {
      if (!dragging) return;
      dragging = false;
      body.classList.remove("is-dragging");
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);

    const close = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      overlay.remove();
      URL.revokeObjectURL(blobUrl);
    };

    overlay
      .querySelector("#insightPreviewClose")
      .addEventListener("click", close);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });

    overlay
      .querySelector("#insightPreviewDownload")
      .addEventListener("click", () => {
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = `onstarvoice-insight-${seedKeyword}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        showMessage("图片已保存", "success");
      });

    overlay
      .querySelector("#insightPreviewCopy")
      .addEventListener("click", async () => {
        if (
          typeof navigator === "undefined" ||
          !navigator.clipboard ||
          typeof navigator.clipboard.write !== "function" ||
          typeof window.ClipboardItem !== "function"
        ) {
          showMessage("当前环境暂不支持复制图片，请使用下载", "warning");
          return;
        }

        try {
          await navigator.clipboard.write([
            createClipboardItem({
              [blob.type || "image/png"]: blob,
            }),
          ]);
          showMessage("图片已复制到剪贴板", "success");
        } catch (error) {
          console.warn("[Sidebar] Failed to copy image", error);
          showMessage("复制图片失败，请尝试下载", "error");
        }
      });
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
  function roundRectTop(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  return Object.freeze({
    buildBenchmarkDiscoveryShareText,
    handleCopyBenchmarkDiscovery,
    buildBenchmarkDiscoveryShareData,
    handleShareBenchmarkDiscoveryAsImage,
    handleCopyKeywordOpportunity,
    buildKeywordOpportunityShareText,
    buildKeywordOpportunityShareData,
    handleShareKeywordOpportunityAsImage,
    handleCopyInsight,
    buildInsightShareData,
    handleShareAsImage,
    renderInsightCardToImage,
    renderKeywordOpportunityCardToImage,
    renderBenchmarkDiscoveryCardToImage,
    showInsightImagePreview,
    roundRect,
    roundRectTop,
  });
}
