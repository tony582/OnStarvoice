import assert from 'node:assert/strict';
import test from 'node:test';

import { matchDangerKeywords } from '../server/services/alert-risk-matcher.js';

test('普通安全表达不会仅因出现“安全”而触发高危预警', () => {
  const text = '哪都敢去，因为我知道它不会把我丢路上。#别克 #别克至境L7 #安全感 #美系车';
  assert.deepEqual(matchDangerKeywords(text, ['安全', '事故']), []);
});

test('安全词需要明确风险语境才触发', () => {
  assert.deepEqual(matchDangerKeywords('刹车系统失效，已经影响行车安全', ['安全']), ['安全']);
  assert.deepEqual(matchDangerKeywords('这个问题存在严重安全隐患', ['安全']), ['安全']);
  assert.deepEqual(matchDangerKeywords('车辆安全配置很齐全，开起来很安心', ['安全']), []);
});

test('隐私词需要泄露、侵犯或风险语境才触发', () => {
  assert.deepEqual(matchDangerKeywords('隐私保护做得很好', ['隐私']), []);
  assert.deepEqual(matchDangerKeywords('定位数据疑似造成隐私泄露', ['隐私']), ['隐私']);
});

test('具体高危短语仍然按配置直接命中', () => {
  assert.deepEqual(
    matchDangerKeywords('车辆突然起火，刹车失灵', ['起火', '刹车失灵', '死亡']),
    ['起火', '刹车失灵'],
  );
});
