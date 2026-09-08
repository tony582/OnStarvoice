import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import {hasUnattendedNegativePatrol, unattendedNegativePatrolRequest, negativePatrolCapabilityAvailable} from './unattendedNegativePatrol.mjs';

const componentSource = readFileSync(new URL('./NegativePatrolScheduleOption.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(componentSource, {compilerOptions: {
  module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022,
}}).outputText;
const exports = {};
vm.runInNewContext(compiled, {exports, React});
const Option = exports.NegativePatrolScheduleOption;

test('new plans stay opt-in and one-time tasks cannot carry the patrol setting', () => {
  assert.deepEqual(unattendedNegativePatrolRequest(false, 'unattended_plan'), {});
  assert.deepEqual(unattendedNegativePatrolRequest(true, 'one_time'), {});
  assert.deepEqual(unattendedNegativePatrolRequest(true, 'unattended_plan'), {negativePatrol: {enabled: true, lookbackDays: 7}});
});

test('editing and copying reads the saved plan setting, including explicit disable', () => {
  assert.equal(hasUnattendedNegativePatrol(undefined), false);
  assert.equal(hasUnattendedNegativePatrol({}), false);
  assert.equal(hasUnattendedNegativePatrol({negativePatrol: {enabled: false}}), false);
  assert.equal(hasUnattendedNegativePatrol({negativePatrol: {enabled: 'true'}}), false);
  assert.equal(hasUnattendedNegativePatrol({negativePatrol: {enabled: true, lookbackDays: 7}}), true);
});

test('toggling the patrol setting changes the immutable submission fingerprint', () => {
  const base = {platform: 'douyin', keywords: ['安吉星'], executionMode: 'unattended_plan'};
  const off = JSON.stringify({...base, ...unattendedNegativePatrolRequest(false, base.executionMode)});
  const on = JSON.stringify({...base, ...unattendedNegativePatrolRequest(true, base.executionMode)});
  assert.notEqual(on, off);
  assert.equal(JSON.parse(on).negativePatrol.lookbackDays, 7);
});

test('negative patrol requires targeted capture plus a durable terminal receipt capability', () => {
  const capabilities = {remoteTargetedPostCaptureV1: true, negativePostPatrol: true, negativePatrolTerminalReceiptV1: true};
  assert.equal(negativePatrolCapabilityAvailable(capabilities), true);
  for (const field of Object.keys(capabilities)) {
    assert.equal(negativePatrolCapabilityAvailable({...capabilities, [field]: false}), false, field);
  }
});

test('checkbox renders the published-date window and continuation behavior, and forwards explicit changes', () => {
  const rendered = renderToStaticMarkup(React.createElement(Option, {checked: false, onChange() {}}));
  assert.match(rendered, /同时巡查近7天负面内容/);
  assert.match(rendered, /帖子发布时间/);
  assert.match(rendered, /关键词采集优先/);
  assert.match(rendered, /沿用现有处理状态/);
  assert.doesNotMatch(rendered, /checked=""/);
  const disabled = renderToStaticMarkup(React.createElement(Option, {checked: true, disabled: true, onChange() {}}));
  assert.match(disabled, /checked=""/);
  assert.match(disabled, /disabled=""/);
  let next;
  const tree = Option({checked: false, onChange(value) { next = value; }});
  tree.props.children[0].props.onChange({target: {checked: true}});
  assert.equal(next, true);
});
