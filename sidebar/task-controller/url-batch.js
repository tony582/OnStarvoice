// L3-A url-batch: original control flow, explicit state and compatibility ports.
export function createUrlBatchController({controllerState, controllerPorts, controllerOperations}) {
  const {
    PAGE_ENHANCE_AUTH_REQUIRED_MESSAGE,
    batchCaptureByUrls,
    chrome,
    collectBatchRecordIds,
    console,
    taskView,
    ensureAuthVerifiedOrWarn,
    getCaptureSettings,
    readBloggerKeywordFilterFromInput,
    readBloggerMaxDetectedItemsFromInput,
    readBloggerMinLikesFromInput,
    refreshDataPool,
    resolveCurrentDetailCaptureSettings,
    resolveNoteBatchCaptureSettings,
    setBatchProgressVisible,
    showMessage,
    updateBatchProgress,
  } = controllerPorts;
  const acquireCaptureExecutionLock = (...args) => controllerOperations.acquireCaptureExecutionLock(...args);
  const maybeRunAutoDetailCaptureAfterListCapture = (...args) => controllerOperations.maybeRunAutoDetailCaptureAfterListCapture(...args);
  const releaseCaptureExecutionLock = (...args) => controllerOperations.releaseCaptureExecutionLock(...args);
  const requestCaptureCancelSignal = (...args) => controllerOperations.requestCaptureCancelSignal(...args);

  async function handleRunBatchLinks() {
    const controls = taskView.openUrlBatchControls("links");
    if (!controls) return;
    if (controllerState.batchUrlCaptureInFlight) {
      if (controllerState.batchUrlCaptureMode !== "links") {
        showMessage("已有批量任务执行中，请先停止当前任务", "warning");
        return;
      }
      if (controllerState.batchUrlCancelRequested) {
        showMessage("正在取消批量采集...", "warning");
        return;
      }
      controllerState.batchUrlCancelRequested = true;
      controls.showStopping();
      try {
        await requestCaptureCancelSignal(controllerState.activeBatchRunnerTabId);
      } catch (error) {
        console.warn("[Sidebar] Batch links cancel failed:", error);
      }
      showMessage("正在取消批量采集...", "warning");
      return;
    }

    if (controllerState.batchKeywordCaptureInFlight) {
      showMessage("已有批量任务执行中，请先停止当前任务", "warning");
      return;
    }

    const urls = controls.readUrlsText()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    if (urls.length === 0) {
      showMessage("请输入至少一个作品链接（每行一个）", "warning");
      return;
    }

    let executionLock = null;
    try {
      executionLock = await acquireCaptureExecutionLock({
        owner: "manual_batch_links_capture",
        label: "手动批量作品采集",
      });
      if (!executionLock) {
        return;
      }
      const noteBatchSettings = await resolveNoteBatchCaptureSettings();
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      controllerState.activeBatchRunnerTabId = tab?.id ? Number(tab.id) : null;
      controllerState.batchUrlCaptureInFlight = true;
      controllerState.batchUrlCancelRequested = false;
      controllerState.batchUrlCaptureMode = "links";
      controls.showRunning();
      setBatchProgressVisible("modal", true);

      const res = await batchCaptureByUrls({
        urls,
        mode: "single",
        captureParams: {
          includeComments: noteBatchSettings.includeComments,
          includeBloggerMetrics: noteBatchSettings.includeBloggerMetrics,
          enableCommentLeadsFilter: noteBatchSettings.enableCommentLeadsFilter,
          commentsMaxDetectedItems: noteBatchSettings.commentsMaxDetectedItems,
          detailNavTimeoutMs: noteBatchSettings.settings.detailNavTimeoutMs,
          profileAfterNavWaitMs: noteBatchSettings.settings.profileAfterNavWaitMs,
        },
        onProgress: (p) => updateBatchProgress(p, "modal"),
        shouldStop: () => controllerState.batchUrlCancelRequested,
      });

      await refreshDataPool();
      if (res.canceled) {
        showMessage(
          `批量采集已停止：已处理 ${res.stats.processed}/${res.stats.total} 条，成功 ${res.stats.success}，失败 ${res.stats.failed}`,
          "warning",
        );
      } else {
        showMessage(
          `批量采集完成：共 ${res.stats.total} 条，成功 ${res.stats.success}，失败 ${res.stats.failed}`,
          res.stats.failed > 0 ? "warning" : "success",
        );
      }
    } catch (error) {
      console.error("[Batch] Links failed:", error);
      showMessage("批量采集失败: " + error.message, "error");
    } finally {
      controllerState.batchUrlCaptureInFlight = false;
      controllerState.batchUrlCancelRequested = false;
      controllerState.batchUrlCaptureMode = "";
      controllerState.activeBatchRunnerTabId = null;
      if (executionLock) {
        await releaseCaptureExecutionLock(executionLock.id);
      }
      controls.showIdle();
    }
  }

  async function handleRunBatchBloggers() {
    const controls = taskView.openUrlBatchControls("bloggers");
    if (!controls) return;
    if (controllerState.batchUrlCaptureInFlight) {
      if (controllerState.batchUrlCaptureMode !== "bloggers") {
        showMessage("已有批量任务执行中，请先停止当前任务", "warning");
        return;
      }
      if (controllerState.batchUrlCancelRequested) {
        showMessage("正在取消批量采集...", "warning");
        return;
      }
      controllerState.batchUrlCancelRequested = true;
      controls.showStopping();
      try {
        await requestCaptureCancelSignal(controllerState.activeBatchRunnerTabId);
      } catch (error) {
        console.warn("[Sidebar] Batch bloggers cancel failed:", error);
      }
      showMessage("正在取消批量采集...", "warning");
      return;
    }

    if (controllerState.batchKeywordCaptureInFlight) {
      showMessage("已有批量任务执行中，请先停止当前任务", "warning");
      return;
    }

    const urls = controls.readUrlsText()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    if (urls.length === 0) {
      showMessage("请输入至少一个博主 ID 或主页链接（每行一个）", "warning");
      return;
    }

    let executionLock = null;
    try {
      executionLock = await acquireCaptureExecutionLock({
        owner: "manual_batch_bloggers_capture",
        label: "手动批量博主采集",
      });
      if (!executionLock) {
        return;
      }
      const settings = resolveCurrentDetailCaptureSettings(
        await getCaptureSettings(),
      );
      if (
        settings.autoDetailCaptureAfterListCapture &&
        !ensureAuthVerifiedOrWarn({
          message: PAGE_ENHANCE_AUTH_REQUIRED_MESSAGE,
        })
      ) {
        return;
      }
      const bloggerMinLikes = readBloggerMinLikesFromInput(
        settings.bloggerMinLikes,
      );
      const bloggerMaxDetectedItems = readBloggerMaxDetectedItemsFromInput(
        settings.bloggerMaxDetectedItems,
      );
      const bloggerKeywordFilter = readBloggerKeywordFilterFromInput();
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      controllerState.activeBatchRunnerTabId = tab?.id ? Number(tab.id) : null;
      controllerState.batchUrlCaptureInFlight = true;
      controllerState.batchUrlCancelRequested = false;
      controllerState.batchUrlCaptureMode = "bloggers";
      controls.showRunning();
      setBatchProgressVisible("modal", true);

      const res = await batchCaptureByUrls({
        urls,
        mode: "blogger_notes",
        captureParams: {
          includeBloggerProfileRecord: true,
          minLikes: bloggerMinLikes,
          maxDetectedItems: bloggerMaxDetectedItems,
          keywordFilter: bloggerKeywordFilter,
          waitMinMs: settings.sharedWaitMinMs,
          waitMaxMs: settings.sharedWaitMaxMs,
          stallTimeoutMs: settings.sharedStallTimeoutMs,
          maxDurationMs: settings.sharedMaxDurationMs,
        },
        onProgress: (p) => updateBatchProgress(p, "modal"),
        shouldStop: () => controllerState.batchUrlCancelRequested,
      });

      await refreshDataPool();
      if (res.canceled) {
        showMessage(
          `批量采集已停止：已处理 ${res.stats.processed}/${res.stats.total} 个博主，成功 ${res.stats.success}，失败 ${res.stats.failed}`,
          "warning",
        );
      } else {
        showMessage(
          `批量采集完成：共 ${res.stats.total} 个博主，成功 ${res.stats.success}，失败 ${res.stats.failed}`,
          res.stats.failed > 0 ? "warning" : "success",
        );
        await maybeRunAutoDetailCaptureAfterListCapture(settings, {
          sourceLabel: "批量博主笔记",
          recordIds: collectBatchRecordIds(res),
        });
      }
    } catch (error) {
      console.error("[Batch] Bloggers failed:", error);
      showMessage("批量采集失败: " + error.message, "error");
    } finally {
      controllerState.batchUrlCaptureInFlight = false;
      controllerState.batchUrlCancelRequested = false;
      controllerState.batchUrlCaptureMode = "";
      controllerState.activeBatchRunnerTabId = null;
      if (executionLock) {
        await releaseCaptureExecutionLock(executionLock.id);
      }
      controls.showIdle();
    }
  }

  return Object.freeze({
    handleRunBatchLinks,
    handleRunBatchBloggers,
  });
}
