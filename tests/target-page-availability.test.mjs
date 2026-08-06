import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import test from "node:test";
import vm from "node:vm";
import {fileURLToPath} from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(
  resolve(repoRoot, "utils/capture/target-page-availability.js"),
  "utf8",
);
const captureSyncSource = await readFile(
  resolve(repoRoot, "utils/capture-sync.js"),
  "utf8",
);
const context = vm.createContext({});
vm.runInContext(source, context, {
  filename: "utils/capture/target-page-availability.js",
});
const availability = context.OnStarvoiceTargetPageAvailability;

test("detects the Xiaohongshu unavailable QR page shown to users", () => {
  const result = availability.classifySnapshot({
    platform: "xiaohongshu",
    url: "https://www.xiaohongshu.com/explore/note-1",
    title: "小红书",
    bodyText: [
      "Sorry, This Page Isn't Available Right Now.",
      "请打开小红书App扫码查看",
      "问题反馈",
      "返回首页",
    ].join("\n"),
  });

  assert.equal(result.unavailable, true);
  assert.equal(result.businessOutcome, "post_unavailable");
  assert.equal(result.availabilityStatus, "deleted");
  assert.equal(result.retryable, false);
  assert.equal(result.code, "TARGET_POST_UNAVAILABLE");
  assert.ok(result.evidence.includes("xhs_page_not_available"));
  assert.ok(result.evidence.includes("xhs_unavailable_qr_layout"));
});

test("classifies the Chinese Xiaohongshu QR unavailable page as deleted", () => {
  const result = availability.classifySnapshot({
    platform: "xiaohongshu",
    url: "https://www.xiaohongshu.com/explore/note-2",
    title: "小红书",
    bodyText: [
      "当前笔记暂时无法浏览",
      "请打开小红书App扫码查看",
      "小红书如何扫码",
      "问题反馈",
      "返回首页",
    ].join("\n"),
  });

  assert.equal(result.unavailable, true);
  assert.equal(result.availabilityStatus, "deleted");
  assert.equal(result.message, "平台提示该帖子已删除");
  assert.ok(result.evidence.includes("xhs_unavailable_qr_layout"));
});

test("classifies the current Xiaohongshu close-button modal over a long feed", () => {
  const result = availability.classifySnapshot({
    platform: "xiaohongshu",
    url: "https://www.xiaohongshu.com/explore",
    title: "小红书 - 你的生活兴趣社区",
    bodyText: [
      "推荐内容 点赞 评论 收藏".repeat(300),
      "当前笔记暂时无法浏览",
      "该内容暂时无法查看",
      "请打开小红书App扫码查看",
      "小红书如何扫码",
      "问题反馈",
      "关闭",
    ].join("\n"),
  });

  assert.equal(result.unavailable, true);
  assert.equal(result.businessOutcome, "post_unavailable");
  assert.equal(result.availabilityStatus, "deleted");
  assert.equal(result.retryable, false);
  assert.ok(result.evidence.includes("xhs_unavailable_qr_layout"));
});

test("classifies the Xiaohongshu page-gone countdown as deleted", () => {
  const result = availability.classifySnapshot({
    platform: "xiaohongshu",
    url: "https://www.xiaohongshu.com/explore/note-gone",
    title: "小红书",
    bodyText: [
      "你访问的页面不见了",
      "2 秒后将自动返回首页",
      "返回首页",
    ].join("\n"),
  });

  assert.equal(result.unavailable, true);
  assert.equal(result.businessOutcome, "post_unavailable");
  assert.equal(result.availabilityStatus, "deleted");
  assert.equal(result.retryable, false);
  assert.ok(result.evidence.includes("xhs_page_gone_countdown"));
});

test("rechecks a failed Xiaohongshu target after redirect and retains both ends of a long page", () => {
  assert.match(
    captureSyncSource,
    /bodyText\.slice\(0, 10000\)[\s\S]*bodyText\.slice\(-10000\)/u,
  );
  assert.match(
    captureSyncSource,
    /targetPlatform === "xiaohongshu"[\s\S]*captureResult\?\.ok !== true/u,
  );
  assert.match(
    captureSyncSource,
    /shouldRecheckUnavailableXhsTarget[\s\S]*classifyTargetPageAvailabilityInTab\(runnerTabId, url\)/u,
  );
});

test("probes a short-lived unavailable page before the fixed render wait", () => {
  const navigationStart = captureSyncSource.indexOf(
    "await openUrlInTab(runnerTabId, url, {",
  );
  const captureStart = captureSyncSource.indexOf(
    "const singleNoteEnhancementOptions =",
    navigationStart,
  );
  assert.ok(navigationStart >= 0 && captureStart > navigationStart);

  const block = captureSyncSource.slice(navigationStart, captureStart);
  const immediateProbe = block.indexOf(
    "await classifyTargetPageAvailabilityInTab(runnerTabId, url)",
  );
  const fixedWait = block.indexOf("BATCH_KEYWORD_AFTER_NAV_WAIT_MS");
  assert.ok(immediateProbe >= 0);
  assert.ok(fixedWait > immediateProbe);
});

test("classifies explicit platform deletion copy as deleted", () => {
  const result = availability.classifySnapshot({
    platform: "xhs",
    bodyText: "该笔记已被作者删除，返回首页",
  });

  assert.equal(result.unavailable, true);
  assert.equal(result.availabilityStatus, "deleted");
  assert.equal(result.reason, "post_deleted_or_unavailable");
});

test("classifies the Douyin deleted image-post countdown before autoplay", () => {
  const result = availability.classifySnapshot({
    platform: "douyin",
    url: "https://www.douyin.com/note/7665258839256621760",
    title: "抖音",
    bodyText: [
      "你要观看的图文不存在",
      "5",
      "接下来播放",
      "去精选页查看更多视频",
    ].join("\n"),
  });

  assert.equal(result.unavailable, true);
  assert.equal(result.availabilityStatus, "deleted");
  assert.equal(result.businessOutcome, "post_unavailable");
  assert.equal(result.retryable, false);
  assert.ok(result.evidence.includes("douyin_target_not_found"));
  assert.ok(result.evidence.includes("douyin_autoplay_countdown"));
});

test("does not infer Douyin deletion from quoted copy in a normal long post", () => {
  assert.equal(
    availability.classifySnapshot({
      platform: "douyin",
      title: "平台错误提示讨论",
      bodyText: [
        "这是一条正常发布的视频，正文在分析平台提示语。",
        "有人问为什么会出现“你要观看的图文不存在”，这里仅是引用。",
        "当前视频、作者、评论、点赞、收藏和相关推荐都能正常显示。",
        "以下是更长的说明。".repeat(180),
      ].join(" "),
    }),
    null,
  );
});

test("does not treat a normal detail page or unrelated error copy as deleted", () => {
  assert.equal(
    availability.classifySnapshot({
      platform: "xiaohongshu",
      bodyText: "登录后查看更多精彩内容 请打开小红书App扫码登录",
    }),
    null,
  );
  assert.equal(
    availability.classifySnapshot({
      platform: "douyin",
      bodyText: "Sorry, This Page Isn't Available Right Now.",
    }),
    null,
  );
});

test("does not infer deletion from phrases quoted inside a normal post body", () => {
  for (const bodyText of [
    "正常笔记标题 正文：朋友说这个页面无法查看，但我这里一切正常 点赞 12 收藏 3",
    "正常笔记标题 讨论：该内容不存在是否属于平台误判 评论区",
    "正常笔记标题 该笔记已被作者删除是今天讨论的话题",
    [
      "这是一篇正常的长笔记，作者在讨论平台提示语。",
      "有人曾看到“该笔记已被作者删除。”，但当前页面正文和评论仍正常展示。",
      "下面还有大量正文、互动区、评论和相关推荐。",
      "普通页面不能因为引用一句错误提示就被标成删帖。",
    ].join(" "),
    [
      "这是一篇正常的长笔记，作者在讨论平台错误页。",
      "有人曾看到“你访问的页面不见了”，但当前笔记仍正常展示。",
      "下面还有大量正文、互动区、评论和相关推荐。".repeat(120),
    ].join(" "),
  ]) {
    assert.equal(
      availability.classifySnapshot({
        platform: "xiaohongshu",
        title: "正常笔记",
        bodyText,
      }),
      null,
    );
  }
});

test("still accepts a compact explicit deletion error page", () => {
  const result = availability.classifySnapshot({
    platform: "xiaohongshu",
    bodyText: "该笔记已被作者删除",
  });

  assert.equal(result.unavailable, true);
  assert.equal(result.availabilityStatus, "deleted");
  assert.equal(result.retryable, false);
});
