/** Isolated UI rehearsal. Never imports sidebar-logic, dispatches capture, or performs network IO. */
export function installLifecycleFixture({document, window, state, platform, report, errorLog}) {
  const $ = id => document.getElementById(id);
  const creativeFlows = new Set(["opportunity", "benchmark", "longtail"]);
  const batchFlows = new Set(["batch-links", "batch-bloggers"]);
  const flows = new Set([...creativeFlows, "note", "blogger", "search", "batch-links", "batch-bloggers"]);
  const stages = new Set(["waiting", "detail", "ai", "done", "error", "stop", "recovery", "recovery-long", "keyword-plan", "delay", "comments"]);
  const paneIds = {opportunity: "keywordStrategyOpportunityPane", benchmark: "keywordStrategyBenchmarkPane", longtail: "keywordStrategyLongtailPane"};
  const stopIds = {opportunity: "btnCancelKeywordOpportunity", benchmark: "btnCancelBenchmarkDiscovery"};
  const runIds = {opportunity: "btnRunKeywordOpportunity", benchmark: "btnRunBenchmarkDiscovery", longtail: "btnExpandKeywords", note: "btnCaptureNote", blogger: "btnCaptureBlogger", search: "btnCaptureSearch", "batch-links": "btnRunBatchLinks", "batch-bloggers": "btnRunBatchBloggers"};
  const messages = {
    waiting: "触发防反爬挂起，模拟人类等待（3.60s）· 已探测 44 条，已筛选 44 条，页面已标记 44 条（点赞 ≥ 0，探测上限 80）",
    detail: "正在采样作品详情 · 已完成 8 / 20 条。采样网页已切换，任务仍在进行。",
    ai: "采样已完成，正在整理内容特征与分析结果。",
    done: "本次采集已完成，结果已保留。",
    error: "本次任务未完成：演示网络异常。已有采集结果已保留，可稍后重试。",
    stop: "任务已停止，已有采集结果已保留。",
    recovery: "当前采集需要处理，请选择继续当前项或保留结果。",
    "keyword-plan": "无人值守任务正在执行 · 已完成 2 / 5 个关键词。",
    delay: "定时采集：将于今天 21:30 开始（还剩 12 分 30 秒）。",
    comments: "正在采集评论 · 已读取 18 条，详情请查看原记录状态。",
    "recovery-long": "采集需要处理：原标签页等待验证，已有结果仍在。",
  };
  let desiredCreativeVisible = false;
  let currentFlow = "opportunity";
  let currentStage = "done";
  let queue = Promise.resolve();
  const stops = {opportunity: 0, benchmark: 0, generic: 0, longtail: 0, "batch-links": 0, "batch-bloggers": 0};
  const inFlight = () => !["done", "error", "stop"].includes(currentStage);
  const visible = element => !!element && !element.hidden && window.getComputedStyle(element).display !== "none" && element.getClientRects().length > 0;
  const settle = () => new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
  const enqueue = action => { queue = queue.then(action).catch(error => report(`失败 · ${error.message}`)); return queue; };

  // Like the production renderer, runtime refresh may hide the original
  // creative surface without changing its private navigation preference.
  function renderEligibility() {
    const runtime = state.getCurrentRuntime();
    const eligible = runtime.pageType === "search_results" && runtime.platform === runtime.selectedPlatform;
    $("btnToggleKeywordStrategy").disabled = !eligible;
    const show = desiredCreativeVisible && eligible;
    $("keywordStrategyModalOverlay").classList.toggle("is-active", show);
    $("keywordStrategyModalOverlay").setAttribute("aria-hidden", String(!show));
  }
  $("btnToggleKeywordStrategy").onclick = () => { desiredCreativeVisible = !desiredCreativeVisible; renderEligibility(); };
  $("btnKeywordStrategyModalClose").onclick = () => { desiredCreativeVisible = false; renderEligibility(); };
  state.subscribe("runtime", renderEligibility);

  function selectCreativePane(flow) {
    document.querySelector(`[data-strategy-tab="${flow}"]`).click();
  }
  function renderSyntheticTask() {
    $("debugSessionPanel").hidden = true;
    $("debugSessionDock").hidden = true;
    for (const [flow, id] of Object.entries(stopIds)) {
      $(id).style.display = currentFlow === flow && inFlight() ? "inline-flex" : "none";
      $(runIds[flow]).disabled = currentFlow === flow && inFlight();
      const prefix = flow === "opportunity" ? "keywordOpportunity" : "keywordBenchmark";
      $(prefix + "Error").hidden = currentFlow !== flow || currentStage !== "error";
      $(prefix + "Error").textContent = messages.error;
      $(prefix + "Result").replaceChildren();
      if (currentFlow === flow && currentStage === "done") {
        const card = document.createElement("div");
        card.className = "keyword-strategy-placeholder";
        const title = document.createElement("div");
        title.className = "keyword-strategy-placeholder-title";
        title.textContent = flow === "opportunity" ? "新能源汽车 · 赛道机会分析" : "新能源汽车 · 对标账号";
        const copy = document.createElement("p");
        copy.textContent = flow === "opportunity" ? "隔离演示结果：用户关心真实用车成本、续航表现与充电体验。完整结果仍使用原结果区域。" : "隔离演示结果：小林的用车日记、辰辰出发啦。完整结果仍使用原结果区域。";
        card.append(title, copy);
        $(prefix + "Result").append(card);
      }
    }
    $("btnExpandKeywords").textContent = currentFlow === "longtail" && inFlight() ? "停止分析长尾需求" : "开始分析长尾需求";
    $("btnExpandKeywords").classList.toggle("btn-danger", currentFlow === "longtail" && inFlight());
    // A child capture may finish and hide shared progress before the creative
    // analysis has finished. Its ORIGINAL dedicated stop remains authoritative.
    $("progressContainer").style.display = batchFlows.has(currentFlow) || ["done", "comments"].includes(currentStage) || currentStage === "ai" && creativeFlows.has(currentFlow) ? "none" : "block";
    const recovery = currentStage.startsWith("recovery");
    $("progressContainer").dataset.progressSource = recovery ? "capture-recovery" : currentStage === "keyword-plan" ? "keyword-plan" : "capture";
    $("progressText").textContent = messages[currentStage];
    $("progressReason").hidden = currentStage !== "recovery-long";
    if (currentStage === "recovery-long") $("progressReason").textContent = "请先定位到原平台标签页，完成页面校验后选择继续当前项。已有采集结果不会因本次等待而删除，也可以选择保留结果结束本项。\n".repeat(12);
    $("progressNextStep").hidden = true;
    $("progressBadge").hidden = true;
    $("btnCancel").hidden = false;
    $("btnCancel").style.display = inFlight() ? "inline-flex" : "none";
    $("btnRetryRecovery").hidden = !recovery;
    $("btnDismissRecovery").hidden = !recovery;
    for (const id of ["btnCaptureNote", "btnCaptureBlogger", "btnCaptureSearch"]) $(id).disabled = inFlight();
    for (const flow of batchFlows) {
      const run = $(runIds[flow]);
      const active = currentFlow === flow && inFlight();
      run.textContent = active ? "停止批量采集" : "启动批量采集";
      run.classList.toggle("btn-danger", active);
      run.classList.toggle("btn-primary", !active);
    }
    $("batchProgressContainer").hidden = !batchFlows.has(currentFlow);
    if (batchFlows.has(currentFlow)) {
      $("batchProgressFill").style.width = currentStage === "done" ? "100%" : "40%";
      $("batchProgressText").textContent = `已处理 ${currentStage === "done" ? "5 / 5" : "2 / 5"} · ${messages[currentStage]}`;
      $("batchProgressDetail").hidden = false;
      $("batchProgressDetail").textContent = currentStage === "detail" ? "当前项：新能源汽车，一个月真实花费。正在打开详情页并补充评论、博主数据。" : "隔离演练：批量进度使用原弹窗内区域；停止仍由原启动按钮承担。";
    }
  }

  async function ensureNext() {
    if (!document.documentElement.classList.contains("sv-next")) $("menuBtnInterfaceMode").click();
    for (let frame = 0; frame < 120 && !document.documentElement.classList.contains("sv-next"); frame++) await settle();
    if (!document.documentElement.classList.contains("sv-next")) throw new Error("新版界面未能进入");
  }

  async function applyStage(flow, stage, {enter = true} = {}) {
    if (!flows.has(flow) || !stages.has(stage)) throw new Error("未知隔离演练阶段");
    await ensureNext();
    const isCreative = creativeFlows.has(flow);
    if (enter) {
      // Enter through the original entry on an eligible synthetic page first.
      await state.setCurrentRuntime({...state.getCurrentRuntime(), platform, selectedPlatform: platform, pageType: "search_results", captureDebugSession: null});
      renderEligibility();
      if (isCreative) {
        if (!document.body.classList.contains("sv-ideas-view")) $("btnToggleKeywordStrategy").click();
        selectCreativePane(flow);
      } else {
        document.querySelector('[data-sv-view="capture"]').click();
      }
    }
    if (batchFlows.has(flow)) {
      if (enter || !$("batchModalOverlay").classList.contains("is-active")) $(flow === "batch-links" ? "btnOpenBatchNote" : "btnOpenBatchBlogger").click();
    } else {
      $("batchModalOverlay").classList.remove("is-active");
      $("batchModalOverlay").setAttribute("aria-hidden", "true");
    }
    currentFlow = flow;
    currentStage = stage;
    renderSyntheticTask();
    const pageType = isCreative ? stage === "detail" ? "note_detail" : "search_results" : ["note", "batch-links"].includes(flow) ? "note_detail" : ["blogger", "batch-bloggers"].includes(flow) ? "blogger_profile" : "search_results";
    await state.setCurrentCapture({...state.getCurrentCapture(), status: inFlight() && stage !== "ai" ? "capturing" : "idle"});
    await state.setCurrentRuntime({...state.getCurrentRuntime(), platform, selectedPlatform: platform, pageType, captureDebugSession: null});
    window.renderPlatformCaptureTabs(platform);
    // The actual presentation subscriber has now run; restore the specific
    // synthetic engine-owned phase, just as sidebar-logic would render next.
    renderSyntheticTask();
    renderEligibility();
    document.dispatchEvent(new Event("change"));
    await settle();
  }
  for (const [flow, id] of Object.entries(runIds)) {
    $(id).onclick = () => {
      if ((flow === "longtail" || batchFlows.has(flow)) && currentFlow === flow && inFlight()) {
        stops[flow]++;
        void enqueue(() => applyStage(flow, "stop", {enter: false}));
      } else {
        void enqueue(() => applyStage(flow, "waiting", {enter: false}));
      }
    };
  }
  for (const [flow, id] of Object.entries(stopIds)) $(id).onclick = () => { stops[flow]++; void enqueue(() => applyStage(flow, "stop", {enter: false})); };
  $("btnCancel").onclick = () => { stops.generic++; void enqueue(() => applyStage(currentFlow, "stop", {enter: false})); };

  async function runContracts() {
    const results = [];
    const assert = (condition, message) => { if (!condition) throw new Error(message); results.push("通过 · " + message); };
    const assertLayout = label => {
      const progress = $("progressContainer").getBoundingClientRect();
      const reserved = document.querySelector(".sv-feedback").getBoundingClientRect();
      const content = $("mainTabContent").getBoundingClientRect();
      const navigation = document.querySelector(".sv-bottom-nav").getBoundingClientRect();
      assert(content.bottom <= reserved.top + 1 && reserved.bottom <= navigation.top + 1, `${label}：内容、进度、底栏各自占位，无相互覆盖（${window.innerWidth} × ${window.innerHeight}）`);
      assert(progress.left >= -1 && progress.right <= window.innerWidth + 1 && navigation.bottom <= window.innerHeight + 1, `${label}：进度不横向溢出，底栏不越出可视范围`);
      assert(["btnCaptureNote", "btnCaptureBlogger", "btnCaptureSearch"].every(id => window.getComputedStyle($(id).closest(".action-row")).display === "none"), `${label}：显示进度时三个页面的流内开始区均让位`);
    };
    try {
      if (document.documentElement.classList.contains("sv-next")) $("menuBtnInterfaceMode").click();
      await settle();
      const nodes = ["progressContainer", ...Object.values(stopIds)].map(id => ({node: $(id), parent: $(id).parentNode}));
      for (const flow of ["opportunity", "benchmark"]) {
        await applyStage(flow, "waiting");
        assert(document.body.classList.contains("sv-ideas-view") && visible($(paneIds[flow])), `${flow}：启动和平台重绘后仍停留创意`);
        assert(visible($(stopIds[flow])) && !visible($("btnCancel")), `${flow}：保留唯一原专用停止按钮，不误用通用取消`);
        assert(!visible($("searchTab")) && !visible($("searchManualActionRow")), `${flow}：运行时不露出搜索表单和搜索主按钮`);
        assert(!["sticky", "fixed", "absolute"].includes(window.getComputedStyle($("progressContainer")).position), `${flow}：进度为正常文档流，不浮盖表单或底部操作`);
        assertLayout(flow);
        await applyStage(flow, "detail", {enter: false});
        assert(document.body.classList.contains("sv-ideas-view") && !$("keywordStrategyModalOverlay").classList.contains("is-active") && visible($("progressContainer")) && visible($(stopIds[flow])), `${flow}：采样切详情页时保留创意、进度和原停止，原条件区域仍隐藏`);
        assertLayout(`${flow} 详情采样`);
        await applyStage(flow, "ai", {enter: false});
        assert(state.getCurrentCapture().status === "idle" && document.body.classList.contains("sv-ideas-view") && visible($(stopIds[flow])) && !visible($("progressContainer")), `${flow}：子采集结束隐藏共享进度后，分析仍保留原专用停止，不强开进度`);
        await applyStage(flow, "done", {enter: false});
        const prefix = flow === "opportunity" ? "keywordOpportunity" : "keywordBenchmark";
        assert(visible($(prefix + "Result")) && $(prefix + "Result").children.length > 0 && !visible($(stopIds[flow])), `${flow}：完成显示原结果区并撤下停止`);
        await applyStage(flow, "error", {enter: false});
        assert(visible($(prefix + "Error")), `${flow}：异常显示原错误区，不切回采集`);
        await applyStage(flow, "detail", {enter: false});
        document.querySelector('[data-sv-view="settings"]').click();
        await state.setCurrentRuntime({...state.getCurrentRuntime(), pageType: "search_results"});
        renderEligibility();
        assert(!desiredCreativeVisible && !document.body.classList.contains("sv-ideas-view") && !$("keywordStrategyModalOverlay").classList.contains("is-active"), `${flow}：条件区域隐藏时明确离开仍清除原展示意图，不幽灵重开`);
        await applyStage(flow, "waiting");
        const count = stops[flow]; const genericCount = stops.generic;
        $(stopIds[flow]).click();
        await queue;
        assert(stops[flow] === count + 1 && stops.generic === genericCount, `${flow}：专用停止原回调只执行一次`);
      }
      for (const flow of ["note", "blogger", "search"]) {
        await applyStage(flow, "waiting");
        assert(!document.body.classList.contains("sv-ideas-view") && visible($("progressContainer")) && visible($("btnCancel")), `${flow}：启动保留采集页与原通用停止`);
        assert(!["sticky", "fixed", "absolute"].includes(window.getComputedStyle($("progressContainer")).position), `${flow}：进度不使用覆盖式定位`);
        assertLayout(flow);
        await applyStage(flow, "done", {enter: false});
        assert(!visible($("btnCancel")) && !$(runIds[flow]).disabled, `${flow}：完成后撤下中止，恢复原操作`);
      }
      for (const flow of batchFlows) {
        await applyStage(flow, "waiting");
        const run = $(runIds[flow]);
        assert($("batchModalOverlay").classList.contains("is-active") && visible($("batchProgressContainer")) && !visible($("progressContainer")) && run.textContent === "停止批量采集", `${flow}：原弹窗内显示批量进度，原启动按钮变为停止，不借用通用进度`);
        const card = $("batchModalOverlay").querySelector(".modal-card").getBoundingClientRect();
        const header = $("batchModalOverlay").querySelector(".batch-modal-header").getBoundingClientRect();
        const body = $("batchModalOverlay").querySelector(".batch-modal-body").getBoundingClientRect();
        const batchProgress = $("batchProgressContainer").getBoundingClientRect();
        assert(header.bottom <= body.top + 1 && body.bottom <= card.bottom + 1 && card.top >= -1 && card.bottom <= window.innerHeight + 1 && run.getBoundingClientRect().bottom <= batchProgress.top + 1, `${flow}：弹窗标题、操作与进度顺序分区，不互相遮挡或越出视口`);
        await applyStage(flow, "detail", {enter: false});
        assert(visible($("batchProgressDetail")) && $("batchModalOverlay").classList.contains("is-active"), `${flow}：采样切页仍保留原弹窗与细项进度`);
        const count = stops[flow]; const genericCount = stops.generic;
        run.click(); await queue;
        assert(stops[flow] === count + 1 && stops.generic === genericCount && run.textContent === "启动批量采集", `${flow}：点击同一原按钮停止一次，恢复可启动，不触发通用取消`);
        for (const stage of ["done", "error"]) {
          await applyStage(flow, stage, {enter: false});
          assert($("batchModalOverlay").classList.contains("is-active") && visible($("batchProgressContainer")) && run.textContent === "启动批量采集" && $("batchProgressText").textContent.includes(messages[stage]), `${flow}：${stage} 后保留弹窗结果及原启动按钮`);
        }
      }
      await applyStage("search", "delay");
      assert(visible($("progressContainer")) && $("progressText").textContent.includes("21:30") && visible($("btnCancel")), "手动延迟启动：倒计时与原中止显示在独立进度区域");
      assertLayout("延迟启动");
      await applyStage("note", "comments");
      assert(state.getCurrentCapture().status === "capturing" && !visible($("progressContainer")) && !visible(document.querySelector(".sv-feedback")), "评论阶段：引擎已隐藏通用进度时不强行恢复，不虚构停止入口");
      await applyStage("search", "recovery-long");
      const scrollRegion = document.querySelector(".sv-feedback");
      assert(visible($("progressReason")) && scrollRegion.scrollHeight > scrollRegion.clientHeight && window.getComputedStyle(scrollRegion).overflowY === "auto", "较长恢复说明：进度区内部可滚动，不挤出底栏或覆盖表单");
      assertLayout("较长恢复说明");
      await applyStage("opportunity", "recovery");
      assert(visible($("btnCancel")) && visible($("btnRetryRecovery")) && visible($("btnDismissRecovery")), "需处理：原恢复、保留结果和中止入口不被创意样式误隐藏");
      assertLayout("需处理");
      await applyStage("opportunity", "keyword-plan");
      assert(visible($("btnCancel")), "无人值守：原计划中止入口不被创意样式误隐藏");
      assertLayout("无人值守");
      await applyStage("search", "waiting");
      $("debugSessionDock").hidden = false;
      await settle();
      const dock = $("debugSessionDock").getBoundingClientRect();
      const feedback = document.querySelector(".sv-feedback").getBoundingClientRect();
      assert(dock.bottom <= feedback.top + 1 && window.getComputedStyle($("debugSessionDock")).position === "static", "已有运行浮条与共享进度同时出现：分别占位，不互相覆盖");
      $("debugSessionDock").hidden = true;
      await applyStage("longtail", "waiting");
      assert(visible($("btnExpandKeywords")) && $("btnExpandKeywords").textContent.includes("停止"), "长尾分析：原按钮的停止态仍可见");
      const longtailCount = stops.longtail;
      $("btnExpandKeywords").click(); await queue;
      assert(stops.longtail === longtailCount + 1, "长尾分析：停止复用原按钮回调一次");
      $("menuBtnInterfaceMode").click();
      await settle();
      assert(nodes.every(({node, parent}) => node.isConnected && node.parentNode === parent), "经典回退：共享进度与两个专用停止按钮原父节点恢复");
      assert(errorLog.length === 0, "全部生命周期无浏览器错误");
      // Leave subsequent compatibility checks a clean synthetic idle state.
      // This cleanup only touches this isolated fixture, never a real task.
      $("btnKeywordStrategyModalClose").click();
      currentStage = "done";
      currentFlow = "search";
      renderSyntheticTask();
      renderEligibility();
      report(results.join("\n") + `\n\n${results.length} 项生命周期检查完成；仅隔离演练，不代表真实采集验收。`);
    } catch (error) { report(results.join("\n") + "\n失败 · " + error.message); }
  }
  window.addEventListener("message", event => {
    if (event.origin !== location.origin || event.source !== window.parent) return;
    if (event.data?.type === "sv-ui-stage") {
      void enqueue(async () => {
        await applyStage(event.data.flow || "opportunity", event.data.stage || "waiting");
        report(`隔离演练 · ${currentFlow} / ${currentStage}。仅合成数据，不执行真实采集。`);
      });
    }
    if (event.data?.type === "sv-ui-lifecycle-test") void runContracts();
  });
}
