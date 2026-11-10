# Supplied article DOM snapshots — 2026-11-09

These fixtures come only from the user's existing `output/wechat-articles/live-dom-20261109/` files. No website was accessed to prepare or run these tests. `prepare.py` uses Python's standard `HTMLParser` to retain the original `#activity-name`, `#meta_content`, `#js_content`, and `.interaction_bar` fragments and remove scripts. The metadata fragment retains `#js_ip_wording_wrp` and `#js_author_name*` as supplied. Other page material, including script payloads, is excluded. Image URLs are public observed references, not downloaded images.

The companion `.tree.json` contains the decoded DOM tree plus SHA-256 hashes of its source and reduced HTML. Tests check the reduced HTML hash, reconstruct the existing fake DOM, and run the real extractor. They execute no page scripts and load no resources. The model restores **inline display/visibility/opacity/height**, and background URLs come from the original attributes/inline style; it does not calculate external CSS, layout, animation, or browser computed style. This establishes saved-DOM selector acceptance, not fresh browser, full collection, or media-download acceptance.

| Saved HTML | Title | Account / author | Parsed publication time | Region | Text length (JS UTF-16) | Unique images | visible / interactive |
| --- | --- | --- | --- | --- | ---: | ---: | ---: |
| FYL3oVvFiTPoeeaxO0ERCQ | 2.2亿美元和解之后，你的急刹数据归谁 | 汽车前瞻资讯 / 汽车前瞻资讯 | 2026-11-08T23:59:00+08:00 | 上海 | 4148 | 4 | 4 / 0 |
| 1ZigfwkDqDuKmKi-M0baeA | 解锁安吉星小程序4大板块 | 安吉星 / 安吉星 | 2026-07-13T14:59:00+08:00 | 上海 | 0 | 38 | 23 / 15 |
| kL-i_FzeHUakdh5_x49Sog | 安吉星微信小程序上线啦！ | 安吉星服务 / 安吉星服务 | 2026-07-10T14:57:00+08:00 | 上海 | 0 | 42 | 23 / 19 |

The image-only snapshots produce `contentType: image`. T7 includes 31 / 35 SVG/background image URLs plus the seven IMG URLs in each official-account snapshot, all unique after removing fragments. The first image is the first `data-lazy-bgimg` SVG in each source, not the old first IMG. URL size/query parameters stay intact. Repeated URLs keep their first DOM position and layer. `images` and image `bodyBlocks` carry the same layer.

The replay has no visible embedded media, so body status is complete for the extracted DOM content; this does not assert that all intended original media was captured. All desktop metrics remain null, and all returned images remain `stored:false`. Images beneath zero-height or transparent ancestors are labeled `interactive`, while text visibility is unchanged. Display/visibility/hidden/aria-hidden still exclude subtrees. An IMG's own lazy-placeholder opacity alone does not make it interactive.

## Explicit gaps

- Only **three real HTML fixtures** were supplied. `bMWKCZnPrhVlz2uCqmRzKw.extracted.json` is the user's earlier extraction result, not an HTML fixture. It preserves “5年后安吉星要不要续费” / “白白过一天”, 740 JS characters, and zero images. Its observed English time label parses to `2026-08-24T14:39:00+08:00` in a synthetic test; this does not establish its missing DOM, region, or fresh browser result.
- Historical T1 gap: kL-i nodes 2–5 are under `display: block;height: 0 !important;opacity: 0;` ancestors (reduced HTML line 23, zero-based Unicode offsets 34840, 37323, 39855, 42719). T1 therefore returned only three IMG URLs. T7 follows the amended interaction-layer rule and now retains all seven IMG URLs as interactive, along with the 35 background URLs. The test still asserts the seven raw IMG nodes and four opacity-hidden ancestors so the fixture is not rewritten to satisfy the new count. These remain inline-style results, not proof of the live rendered layout.
- Both image-only snapshots contain a `section.channels_iframe_wrp` under an ancestor styled `line-height: 0;height: 0px;opacity:0;margin-top: 0px;transform:scale(3);`. The hidden subtree is excluded; a separate synthetic test confirms visible embedded media is partial and its child text/images are excluded.
- English dates are interpreted in Asia/Shanghai; T2 fixes article-tab locale/timezone. The supplied later live-test report says the page still uses English date text, so the English fallback remains necessary.

## Original supplied source SHA-256

| Source file | SHA-256 |
| --- | --- |
| 1ZigfwkDqDuKmKi-M0baeA.html | `f2bad134ca0536a06e5cee632b5dc6e03610850d0a886a6fa91388ab2408f3d2` |
| FYL3oVvFiTPoeeaxO0ERCQ.html | `df2b5553ea9c79bf7278b35927af0090ec27f80933e37fe8a7e86ebe4b67fa39` |
| kL-i_FzeHUakdh5_x49Sog.html | `dfcf26ed3e1a088d4b014c0180552cc0920d32df7bda2e3afccf90162db232e9` |
| bMWKCZnPrhVlz2uCqmRzKw.json | `93b172bd045ce0e19fecfb87ebcdf8bf61a311a2ad368a8cb87af1e0e2370a0a` |

Regenerate from existing local source files only:

```sh
python3 runners/android/test/fixtures/wechat-articles/dom/prepare.py output/wechat-articles/live-dom-20261109
```
