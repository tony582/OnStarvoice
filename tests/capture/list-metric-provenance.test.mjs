import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {isListMetricExplicitlyKnown} from '../../utils/capture-sync.js';

const xhsKeywordSource = await readFile(
  new URL('../../utils/capture/keyword-search.js', import.meta.url),
  'utf8',
);
const douyinKeywordSource = await readFile(
  new URL('../../utils/capture/douyin-keyword-search.js', import.meta.url),
  'utf8',
);

test('legacy list placeholder zero is unknown while positive counts remain usable', () => {
  const legacy = {
    likes: 8,
    comments: 0,
    collects: 0,
    displayMetricDimension: 'likes',
    displayMetricCount: 8,
  };

  assert.equal(isListMetricExplicitlyKnown(legacy, 'likes'), true);
  assert.equal(isListMetricExplicitlyKnown(legacy, 'comments'), false);
  assert.equal(isListMetricExplicitlyKnown(legacy, 'collects'), false);
});

test('only provenance-backed zero may replace an existing list metric', () => {
  assert.equal(
    isListMetricExplicitlyKnown(
      {comments: 0, metricKnown: {comments: true}},
      'comments',
    ),
    true,
  );
  assert.equal(
    isListMetricExplicitlyKnown(
      {
        comments: 0,
        displayMetricDimension: 'comments',
        displayMetricCount: 0,
      },
      'comments',
    ),
    false,
  );
  assert.equal(
    isListMetricExplicitlyKnown(
      {
        comments: 0,
        displayMetricDimension: 'comments',
        displayMetricCount: 0,
        displayMetricKnown: true,
      },
      'comments',
    ),
    true,
  );
});

test('keyword extractors no longer manufacture zero for unobserved dimensions', () => {
  assert.doesNotMatch(
    xhsKeywordSource,
    /return \{likes: 0, collects: count, comments: 0\}/,
  );
  assert.doesNotMatch(
    xhsKeywordSource,
    /return \{likes: count, collects: 0, comments: 0\}/,
  );
  assert.doesNotMatch(
    douyinKeywordSource,
    /collects:\s*0,\s*comments:\s*0,/,
  );
  assert.match(xhsKeywordSource, /displayMetricKnown:\s*interaction\.known/);
  assert.match(douyinKeywordSource, /displayMetricKnown:\s*likesMetric\.known/);
});
