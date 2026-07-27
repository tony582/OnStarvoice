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

test("classifies explicit platform deletion copy as deleted", () => {
  const result = availability.classifySnapshot({
    platform: "xhs",
    bodyText: "该笔记已被作者删除，返回首页",
  });

  assert.equal(result.unavailable, true);
  assert.equal(result.availabilityStatus, "deleted");
  assert.equal(result.reason, "post_deleted_or_unavailable");
});

test("does not treat a normal detail page or another platform as deleted", () => {
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
