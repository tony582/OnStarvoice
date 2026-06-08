import { NOTE_DETAIL_SELECTORS } from "../../selectors.js";

export const XIAOHONGSHU_DOM_PROFILE = Object.freeze({
  platform: "xiaohongshu",
  searchResults: Object.freeze({
    fields: Object.freeze({
      searchInput: Object.freeze([
        '#search-input',
        'input[type="search"]',
        'input.search-input',
        '.input-box input',
        '[class*="search"] input',
        'input[placeholder*="搜索"]',
        'input[placeholder*="探索"]',
      ]),
      suggestionDropdown: Object.freeze([
        '.sug-box',
        '.sug-container',
        '.sug-container-wrapper',
        '[class*="search-suggest"]',
        '[class*="searchSuggest"]',
        '[class*="suggest"]',
        '[class*="recommend"]',
        '[role="listbox"]',
      ]),
      suggestionItem: Object.freeze([
        '.sug-item',
        '.sug-box .sug-item',
        '.sug-wrapper .sug-item',
        '[class*="sug-item"]',
        '[class*="suggest-item"]',
        '[class*="search-item"]',
        '[role="option"]',
        'li',
        'a',
      ]),
    }),
  }),
  noteDetail: Object.freeze({
    ready: Object.freeze({
      anyOf: Object.freeze([
        ...NOTE_DETAIL_SELECTORS.title,
        ...NOTE_DETAIL_SELECTORS.content,
        ...NOTE_DETAIL_SELECTORS.container,
      ]),
      minimumCount: 1,
    }),
    rootSelectors: Object.freeze([...NOTE_DETAIL_SELECTORS.container]),
    rootSignals: Object.freeze([
      ...NOTE_DETAIL_SELECTORS.title,
      ...NOTE_DETAIL_SELECTORS.content,
      ...NOTE_DETAIL_SELECTORS.author.container,
    ]),
    rootValidationSelectors: Object.freeze([
      ...NOTE_DETAIL_SELECTORS.title,
      ...NOTE_DETAIL_SELECTORS.content,
    ]),
    fields: Object.freeze({
      title: Object.freeze([...NOTE_DETAIL_SELECTORS.title]),
      authorName: Object.freeze([...NOTE_DETAIL_SELECTORS.author.name]),
      authorLink: Object.freeze([...NOTE_DETAIL_SELECTORS.author.link]),
      publishTime: Object.freeze([...NOTE_DETAIL_SELECTORS.publishDate]),
      tags: Object.freeze([...NOTE_DETAIL_SELECTORS.tags]),
      interactions: Object.freeze({
        likes: Object.freeze([...NOTE_DETAIL_SELECTORS.interactions.likes]),
        comments: Object.freeze([...NOTE_DETAIL_SELECTORS.interactions.comments]),
        collects: Object.freeze([...NOTE_DETAIL_SELECTORS.interactions.collects]),
      }),
      video: Object.freeze([...NOTE_DETAIL_SELECTORS.video]),
      images: Object.freeze([...NOTE_DETAIL_SELECTORS.images]),
      coverImage: Object.freeze([...NOTE_DETAIL_SELECTORS.coverImage]),
    }),
  }),
});
