/**
 * Douyin API Interceptor - MAIN World
 *
 * 运行于页面的 MAIN world（document_start），通过 Proxy / 类继承监听
 * 抖音 aweme detail / feed API 响应，将数据缓存到 sessionStorage，
 * 供 ISOLATED world 的 content script 读取。
 *
 * 设计原则：
 *   - 只读监听，不修改任何请求内容
 *   - fetch 使用 Proxy 包装（保留 toString、length 等元属性）
 *   - XHR 使用 class 继承（不污染原始 XMLHttpRequest.prototype）
 *   - 通过 sessionStorage 与 ISOLATED world 通信（共享同一 origin）
 *   - 不重定向任何网络资源，不发起额外请求
 *
 * 通信协议（sessionStorage key 格式）：
 *   __mc_dy_detail_{aweme_id}  →  JSON { ts: number, detail: object }
 *
 * Claude Code · onstarvoice
 */
(function () {
  'use strict';

  var CACHE_KEY_PREFIX = '__mc_dy_detail_';
  var MEDIA_CACHE_KEY = '__mc_dy_media_requests__';
  var DETAIL_REQUEST_EVENT = '__mc_dy_request_detail__';
  var MAX_CACHE_ENTRIES = 30;
  var MAX_MEDIA_CACHE_ENTRIES = 80;
  var CACHE_TTL_MS = 30 * 60 * 1000; // 30 分钟
  var pendingDetailRequests = Object.create(null);

  var INTERCEPT_PATHS = [
    '/aweme/v1/aweme/detail/',
    '/aweme/v2/aweme/detail/',
    '/aweme/v1/web/aweme/detail/',
    '/aweme/v1/feed/',
    '/aweme/v1/web/general/search/single/',
    '/aweme/v1/web/general/search/stream/',
  ];

  // ── 工具函数 ────────────────────────────────────────────────────────────

  function isAwemeApiUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return (
      INTERCEPT_PATHS.some(function (p) { return url.indexOf(p) !== -1; }) ||
      url.indexOf('/aweme/') !== -1
    );
  }

  function isLikelyMediaRequestUrl(url) {
    if (!url || typeof url !== 'string') return false;
    var lower = url.toLowerCase();
    if (!/^https?:\/\//i.test(lower)) return false;
    if (lower.indexOf('mime_type=video_') !== -1) return true;
    if (lower.indexOf('mime_type=audio_') !== -1) return true;
    if (lower.indexOf('/video/tos/') !== -1) return true;
    if (lower.indexOf('douyinvod.com') !== -1) return true;
    if (lower.indexOf('bytevod.com') !== -1) return true;
    if (lower.indexOf('zjcdn.com') !== -1) return true;
    if (lower.indexOf('/aweme/v1/play/') !== -1) return true;
    return /\.(mp4|m3u8|mpd|webm)(\?|$)/i.test(lower);
  }

  function appendMediaRequest(url) {
    if (!isLikelyMediaRequestUrl(url)) return;
    try {
      var normalized = String(url);
      var raw = sessionStorage.getItem(MEDIA_CACHE_KEY) || '[]';
      var parsed = JSON.parse(raw);
      var list = Array.isArray(parsed) ? parsed : [];
      var next = [{ url: normalized, ts: Date.now() }]
        .concat(list.filter(function (item) {
          return item && typeof item.url === 'string' && item.url !== normalized;
        }))
        .slice(0, MAX_MEDIA_CACHE_ENTRIES);
      sessionStorage.setItem(MEDIA_CACHE_KEY, JSON.stringify(next));
      try {
        console.debug('[OnStarVoice][DouyinInterceptor] media request hit:', normalized);
      } catch (_) {}
    } catch (error) {
      try {
        console.warn('[OnStarVoice][DouyinInterceptor] media request cache failed:', error);
      } catch (_) {}
    }
  }

  function storeDetail(awemeId, detail) {
    if (!awemeId || !detail || typeof detail !== 'object') return;
    var serialized = JSON.stringify({ ts: Date.now(), detail: detail });
    var wroteSession = false;
    var wroteLocal = false;
    try {
      sessionStorage.setItem(CACHE_KEY_PREFIX + awemeId, serialized);
      wroteSession = true;
    } catch (error) {
      try {
        console.warn('[OnStarVoice][DouyinInterceptor] sessionStorage write failed:', awemeId, error);
      } catch (_) {}
    }
    try {
      localStorage.setItem(CACHE_KEY_PREFIX + awemeId, serialized);
      wroteLocal = true;
    } catch (error) {
      try {
        console.warn('[OnStarVoice][DouyinInterceptor] localStorage write failed:', awemeId, error);
      } catch (_) {}
    }
    if (wroteSession || wroteLocal) {
      pruneOldEntries();
    } else {
      try {
        console.warn('[OnStarVoice][DouyinInterceptor] cache write skipped:', awemeId);
      } catch (_) {}
    }
  }

  function pruneOldEntries() {
    try {
      [sessionStorage, localStorage].forEach(function (storage) {
        var keys = [];
        for (var i = 0; i < storage.length; i++) {
          var k = storage.key(i);
          if (k && k.indexOf(CACHE_KEY_PREFIX) === 0) {
            keys.push(k);
          }
        }
        if (keys.length <= MAX_CACHE_ENTRIES) return;
        var entries = keys.map(function (k) {
          try {
            var parsed = JSON.parse(storage.getItem(k));
            return { k: k, ts: (parsed && parsed.ts) || 0 };
          } catch (_) {
            return { k: k, ts: 0 };
          }
        });
        entries.sort(function (a, b) { return a.ts - b.ts; });
        entries.slice(0, entries.length - MAX_CACHE_ENTRIES).forEach(function (e) {
          storage.removeItem(e.k);
        });
      });
    } catch (_) {}
  }

  function processApiJson(json) {
    if (!json || typeof json !== 'object') return;
    var extractedCount = extractAndStoreAwemeNodes(json);
    if (extractedCount > 0) {
      try {
        console.debug('[OnStarVoice][DouyinInterceptor] cached aweme nodes:', extractedCount);
      } catch (_) {}
    }
  }

  function fetchDetailViaApi(awemeId) {
    var normalizedId = String(awemeId || '').trim();
    if (!normalizedId) {
      return Promise.resolve(false);
    }

    if (pendingDetailRequests[normalizedId]) {
      return pendingDetailRequests[normalizedId];
    }

    var endpoints = [
      '/aweme/v1/web/aweme/detail/?aweme_id=' + encodeURIComponent(normalizedId),
      '/aweme/v1/aweme/detail/?aweme_id=' + encodeURIComponent(normalizedId),
      '/aweme/v2/aweme/detail/?aweme_id=' + encodeURIComponent(normalizedId),
    ];

    pendingDetailRequests[normalizedId] = (async function () {
      for (var i = 0; i < endpoints.length; i += 1) {
        var endpoint = endpoints[i];
        try {
          var response = await window.fetch(endpoint, {
            credentials: 'include',
            headers: {
              'accept': 'application/json, text/plain, */*',
            },
          });
          if (!response || !response.ok) {
            continue;
          }

          var json = await response.clone().json();
          processApiJson(json);

          var detail =
            json && typeof json === 'object'
              ? (json.aweme_detail || json.awemeDetail || null)
              : null;
          if (detail && String(detail.aweme_id || '') === normalizedId) {
            return true;
          }
          if (readCache(normalizedId)) {
            return true;
          }
        } catch (error) {
          try {
            console.warn('[OnStarVoice][DouyinInterceptor] detail request failed:', normalizedId, endpoint, error);
          } catch (_) {}
        }
      }
      return false;
    })().finally(function () {
      delete pendingDetailRequests[normalizedId];
    });

    return pendingDetailRequests[normalizedId];
  }

  function readCache(awemeId) {
    if (!awemeId) return null;
    var cacheKey = CACHE_KEY_PREFIX + awemeId;
    var storages = [sessionStorage, localStorage];
    for (var i = 0; i < storages.length; i += 1) {
      try {
        var raw = storages[i].getItem(cacheKey);
        if (!raw) continue;
        var parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') continue;
        if (Date.now() - (parsed.ts || 0) > CACHE_TTL_MS) continue;
        if (parsed.detail && typeof parsed.detail === 'object') {
          return parsed.detail;
        }
      } catch (_) {}
    }
    return null;
  }

  function isAwemeDetailNode(node) {
    if (!node || typeof node !== 'object') return false;
    if (!node.aweme_id) return false;
    return !!(
      node.video ||
      node.images ||
      node.image_infos ||
      node.statistics ||
      node.author ||
      node.music
    );
  }

  function extractAndStoreAwemeNodes(root) {
    if (!root || typeof root !== 'object') return 0;

    var queue = [root];
    var seen = [];
    var storedIds = {};
    var scanned = 0;

    while (queue.length > 0 && scanned < 5000) {
      scanned += 1;
      var current = queue.shift();
      if (!current || typeof current !== 'object') continue;
      if (seen.indexOf(current) !== -1) continue;
      seen.push(current);

      if (isAwemeDetailNode(current)) {
        storedIds[String(current.aweme_id)] = current;
      }

      if (Array.isArray(current)) {
        current.forEach(function (item) {
          if (item && typeof item === 'object') queue.push(item);
        });
        continue;
      }

      Object.keys(current).forEach(function (key) {
        if (!key) return;
        var value = current[key];
        if (value && typeof value === 'object') {
          queue.push(value);
        }
      });
    }

    Object.keys(storedIds).forEach(function (awemeId) {
      storeDetail(awemeId, storedIds[awemeId]);
    });

    return Object.keys(storedIds).length;
  }

  // ── fetch Proxy ─────────────────────────────────────────────────────────

  if (typeof window.fetch === 'function') {
    var _originalFetch = window.fetch;
    window.fetch = new Proxy(_originalFetch, {
      apply: function (target, thisArg, args) {
        var input = args[0];
        var url = '';
        if (typeof input === 'string') {
          url = input;
        } else if (input && typeof input === 'object' && input.url) {
          url = input.url;
        }

        var promise = Reflect.apply(target, thisArg, args);
        appendMediaRequest(url);

        if (isAwemeApiUrl(url)) {
          try {
            console.debug('[OnStarVoice][DouyinInterceptor] fetch hit:', url);
          } catch (_) {}
          promise.then(function (response) {
            if (response && response.ok) {
              response.clone().json().then(processApiJson).catch(function () {});
            }
          }).catch(function () {});
        }

        return promise;
      }
    });
  }

  // ── XMLHttpRequest 子类 ─────────────────────────────────────────────────
  // 使用 class 继承而非覆盖 prototype，原始 XMLHttpRequest.prototype 不受影响

  class _McXHR extends window.XMLHttpRequest {
    constructor() {
      super();
      this._mcUrl = '';
    }

    open(method, url) {
      this._mcUrl = typeof url === 'string' ? url : '';
      return super.open(...arguments);
    }

    send() {
      appendMediaRequest(this._mcUrl);
      if (isAwemeApiUrl(this._mcUrl)) {
        try {
          console.debug('[OnStarVoice][DouyinInterceptor] xhr hit:', this._mcUrl);
        } catch (_) {}
        var self = this;
        this.addEventListener('load', function () {
          try {
            if (self.status === 200) {
              var rt = self.responseType;
              var json;
              if (rt === '' || rt === 'text') {
                json = JSON.parse(self.responseText);
              } else if (rt === 'json') {
                json = self.response;
              }
              if (json) processApiJson(json);
            }
          } catch (_) {}
        }, { once: true });
      }
      return super.send(...arguments);
    }
  }

  window.XMLHttpRequest = _McXHR;

  window.addEventListener(DETAIL_REQUEST_EVENT, function (event) {
    try {
      var awemeId = event && event.detail ? event.detail.awemeId : '';
      if (!awemeId) return;
      fetchDetailViaApi(awemeId).catch(function () {});
    } catch (_) {}
  });

  try {
    console.debug('[OnStarVoice][DouyinInterceptor] ready');
  } catch (_) {}

})();
