// Legacy Sidebar controls stay behind semantic input and presentation ports.
// A session may retain the original nodes across an await; it never exposes them.
export function createLegacyCaptureInputsView({document, window, updateBatchKeywordInputState}) {
  function openUrlBatchControls(mode) {
    const textarea = document.getElementById(
      mode === "links" ? "textareaBatchLinks" : "textareaBatchBloggers",
    );
    if (!textarea) return null;
    const button = document.getElementById(
      mode === "links" ? "btnRunBatchLinks" : "btnRunBatchBloggers",
    );
    if (!button) return null;

    return Object.freeze({
      readUrlsText: () => textarea.value,
      showStopping() {
        button.textContent = "停止中...";
      },
      showRunning() {
        button.textContent = "停止批量采集";
        button.classList.remove("btn-primary");
        button.classList.add("btn-danger");
      },
      showIdle() {
        button.textContent = "启动批量采集";
        button.classList.add("btn-primary");
        button.classList.remove("btn-danger");
      },
    });
  }

  function readSearchBatchKeywordsText() {
    return document.getElementById("textareaSearchBatchKeywords")?.value;
  }

  function readSearchBatchMode() {
    return !!document.getElementById("chkSearchBatchMode")?.checked;
  }

  function readSearchScheduledStart() {
    return document.getElementById("inputSearchScheduledStart")?.value || "";
  }

  function readExpandedKeywordsInput() {
    const textarea = document.getElementById("textareaExpandedKeywords");
    return Object.freeze({
      present: Boolean(textarea),
      value: textarea ? textarea.value : undefined,
    });
  }

  function showBatchKeywordStopping() {
    const button = document.getElementById("btnRunBatchKeywords");
    if (button) {
      button.textContent = "停止中...";
    }
  }

  function showBatchKeywordRunning() {
    const button = document.getElementById("btnRunBatchKeywords");
    if (button) {
      button.textContent = "取消批量采集";
      button.classList.remove("btn-primary");
      button.classList.add("btn-danger");
      button.disabled = false;
      button.classList.remove("is-disabled");
    }
  }

  function showBatchKeywordIdle() {
    const button = document.getElementById("btnRunBatchKeywords");
    if (button) {
      button.textContent = "开始批量采集";
      button.classList.add("btn-primary");
      button.classList.remove("btn-danger");
    }
  }

  function readBatchLoopGapMinutesInput() {
    return document.getElementById("inputLoopGapMin")?.value;
  }

  function readBatchLoopRoundsInput() {
    return document.getElementById("inputLoopRounds")?.value;
  }

  function readBatchScheduledStart() {
    return document.getElementById("inputBatchScheduledStart")?.value || "";
  }

  function beginUnattendedCancelPresentation() {
    const progressText = document.getElementById("progressText");
    const button = document.getElementById("btnCancel");
    if (progressText) {
      progressText.textContent = "正在中止当前采集任务...";
    }
    if (button) {
      button.textContent = "停止中...";
      button.disabled = true;
    }
    return Object.freeze({
      finish() {
        if (button) {
          button.disabled = false;
          button.textContent = "中止任务";
        }
      },
    });
  }

  function applyUnattendedKeywords(keywords) {
    const textarea = document.getElementById("textareaBatchKeywords");
    if (textarea) {
      textarea.value = keywords.join("\n");
      updateBatchKeywordInputState();
    }
  }

  function applyUnattendedLoopSettings({plannedRounds, readGapMinutes}) {
    const autoLoopInput = document.getElementById("chkAutoLoop");
    if (autoLoopInput) {
      autoLoopInput.checked = plannedRounds > 1;
      document
        .getElementById("batchLoopFields")
        ?.classList.toggle("is-disabled", plannedRounds <= 1);
    }
    const loopGapInput = document.getElementById("inputLoopGapMin");
    if (loopGapInput) {
      // Keep the business value lazy: the old code read it only if this input existed.
      loopGapInput.value = String(readGapMinutes());
    }
    const loopRoundsInput = document.getElementById("inputLoopRounds");
    if (loopRoundsInput) {
      loopRoundsInput.value = String(plannedRounds);
    }
    const scheduledInput = document.getElementById("inputBatchScheduledStart");
    if (scheduledInput) {
      scheduledInput.value = "";
    }
  }

  function readRunnerLocationSearch() {
    return window.location.search;
  }

  return Object.freeze({
    openUrlBatchControls,
    readSearchBatchKeywordsText,
    readSearchBatchMode,
    readSearchScheduledStart,
    readExpandedKeywordsInput,
    showBatchKeywordStopping,
    showBatchKeywordRunning,
    showBatchKeywordIdle,
    readBatchLoopGapMinutesInput,
    readBatchLoopRoundsInput,
    readBatchScheduledStart,
    beginUnattendedCancelPresentation,
    applyUnattendedKeywords,
    applyUnattendedLoopSettings,
    readRunnerLocationSearch,
  });
}
