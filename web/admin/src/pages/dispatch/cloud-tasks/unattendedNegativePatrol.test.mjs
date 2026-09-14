import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import {hasUnattendedNegativePatrol, hasFirstCollectedNegativePatrolWindow, unattendedNegativePatrolRequest, negativePatrolCapabilityAvailable} from './unattendedNegativePatrol.mjs';
import * as patrol from './unattendedNegativePatrol.mjs';

const componentSource = readFileSync(new URL('./NegativePatrolScheduleOption.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(componentSource, {compilerOptions: {
  module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022,
}}).outputText;
const exports = {};
vm.runInNewContext(compiled, {exports, React, require: name => {
  assert.equal(name, './unattendedNegativePatrol.mjs');
  return patrol;
}});
const Option = exports.NegativePatrolScheduleOption;

test('new plans stay opt-in and one-time tasks cannot carry the patrol setting', () => {
  assert.deepEqual(unattendedNegativePatrolRequest(false, 'unattended_plan'), {});
  assert.deepEqual(unattendedNegativePatrolRequest(true, 'one_time'), {});
  assert.deepEqual(unattendedNegativePatrolRequest(true, 'unattended_plan'), {negativePatrol: {enabled: true, lookbackDays: 7, triageStatuses: patrol.DEFAULT_NEGATIVE_PATROL_STATUSES}});
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

test('historical runs retain their original window semantics unless first-collection scope is explicitly recorded', () => {
  assert.equal(hasFirstCollectedNegativePatrolWindow(undefined), false);
  assert.equal(hasFirstCollectedNegativePatrolWindow({windowStart: '2026-09-01T12:30:00.100Z', summary: {notDue: 14}}), false);
  assert.equal(hasFirstCollectedNegativePatrolWindow({windowBasis: 'published_at'}), false);
  assert.equal(hasFirstCollectedNegativePatrolWindow({windowBasis: 'first_collected_at', summary: {due: 14}}), true);
});

test('checkbox renders the first-collection window and every-run behavior, and forwards explicit changes', () => {
  const rendered = renderToStaticMarkup(React.createElement(Option, {checked: false, onChange() {}}));
  assert.match(rendered, /同时巡查近7天负面内容/);
  assert.match(rendered, /启动前 7 天首次采集入库/);
  assert.match(rendered, /复查不刷新起算时间/);
  assert.match(rendered, /当天查过也可再次巡查/);
  assert.match(rendered, /关键词采集优先/);
  assert.match(rendered, /保留现有处理状态/);
  assert.doesNotMatch(rendered, /发布时间|未到期|复查间隔/);
  assert.doesNotMatch(rendered, /checked=""/);
  const disabled = renderToStaticMarkup(React.createElement(Option, {checked: true, disabled: true, onChange() {}}));
  assert.match(disabled, /checked=""/);
  assert.match(disabled, /disabled=""/);
  let next;
  const tree = Option({checked: false, onChange(value) { next = value; }});
  tree.props.children[0].props.children[0].props.onChange({target: {checked: true}});
  assert.equal(next, true);
});

function elements(tree, type) {
  if (!React.isValidElement(tree)) return [];
  return [...(tree.type === type ? [tree] : []), ...React.Children.toArray(tree.props.children).flatMap(child => elements(child, type))];
}

test('negative patrol defaults to eight handling states and lets users deliberately include non-monitor content', () => {
  const {DEFAULT_NEGATIVE_PATROL_STATUSES: defaults, NEGATIVE_PATROL_STATUS_OPTIONS: options} = patrol;
  assert.equal(options.length, 9);
  assert.equal(defaults.length, 8);
  assert.equal(defaults.includes('reviewed_non_monitor'), false);
  let changed;
  const tree = Option({checked: true, onChange() {}, triageStatuses: defaults, onStatusesChange(value) { changed = value; }});
  const inputs = elements(tree, 'input').filter(input => input.props.value);
  assert.equal(inputs.length, 9);
  assert.equal(inputs.filter(input => input.props.checked).length, 8);
  const nonMonitor = inputs.find(input => input.props.value === 'reviewed_non_monitor');
  assert.equal(nonMonitor.props.checked, false);
  nonMonitor.props.onChange({target: {checked: true}});
  assert.ok(changed.includes('reviewed_non_monitor'));
  assert.equal(changed.length, 9);
});

test('all, clear and restore-default actions preserve explicit selection and invalid empty state', () => {
  let changed;
  const tree = Option({checked: true, onChange() {}, triageStatuses: ['unhandled'], onStatusesChange(value) { changed = value; }});
  const buttons = elements(tree, 'button');
  buttons.find(button => button.props.children === '全选').props.onClick();
  assert.equal(changed.length, 9);
  assert.ok(changed.includes('reviewed_non_monitor'));
  buttons.find(button => button.props.children === '取消全选').props.onClick();
  assert.equal(changed.length, 0);
  assert.equal(patrol.validNegativePatrolStatuses(changed), false);
  const empty = renderToStaticMarkup(React.createElement(Option, {checked: true, onChange() {}, triageStatuses: [], onStatusesChange() {}}));
  assert.match(empty, /请至少选择一种处理状态/);
  buttons.find(button => button.props.children === '恢复默认').props.onClick();
  assert.deepEqual([...changed], patrol.DEFAULT_NEGATIVE_PATROL_STATUSES);
});

test('editing and copying retain saved choices while only missing historical settings get defaults', () => {
  const saved = {negativePatrol: {enabled: true, triageStatuses: ['negative_cold', 'reviewed_non_monitor']}};
  assert.deepEqual(patrol.negativePatrolTriageStatuses(saved), ['negative_cold', 'reviewed_non_monitor']);
  assert.deepEqual(patrol.negativePatrolTriageStatuses({negativePatrol: {enabled: true}}), patrol.DEFAULT_NEGATIVE_PATROL_STATUSES);
  assert.deepEqual(patrol.negativePatrolTriageStatuses({negativePatrol: {triageStatuses: []}}), []);
  assert.deepEqual(patrol.negativePatrolTriageStatuses({negativePatrol: {triageStatuses: null}}), []);
  assert.equal(patrol.validNegativePatrolStatuses(patrol.negativePatrolTriageStatuses({negativePatrol: {triageStatuses: ['unknown']}})), false);
  assert.deepEqual(patrol.negativePatrolTriageStatuses({negativePatrol: {triageStatuses: ['official_responded', 'false_positive']}}), ['replied', 'reviewed_non_monitor']);
});

test('submission and fingerprint carry the exact chosen states and never turn an explicit empty array into all', () => {
  const statuses = ['unhandled', 'reviewed_non_monitor'];
  const first = unattendedNegativePatrolRequest(true, 'unattended_plan', statuses);
  assert.deepEqual(first.negativePatrol.triageStatuses, statuses);
  assert.notEqual(first.negativePatrol.triageStatuses, statuses);
  assert.notEqual(JSON.stringify(first), JSON.stringify(unattendedNegativePatrolRequest(true, 'unattended_plan', ['negative_cold'])));
  assert.deepEqual(unattendedNegativePatrolRequest(true, 'unattended_plan', []).negativePatrol.triageStatuses, []);
  assert.equal(patrol.negativePatrolStatusSummary(statuses), '待处理、已复核-非监控内容');
});

test('preview, create, edit, copy and the confirmation summary consume the same selection', () => {
  const composer = readFileSync(new URL('./OrchestrationComposerDrawer.tsx', import.meta.url), 'utf8');
  const creator = readFileSync(new URL('./CreateTaskDrawer.tsx', import.meta.url), 'utf8');
  const dispatch = readFileSync(new URL('../DispatchPage.tsx', import.meta.url), 'utf8');
  assert.match(composer, /negative-patrol-preview', \{platform, keywords, \.\.\.unattendedNegativePatrolRequest\(true, 'unattended_plan', negativePatrolStatuses\)/);
  assert.equal((composer.match(/unattendedNegativePatrolRequest\(includeNegativePatrol, executionMode, negativePatrolStatuses\)/g) || []).length, 2);
  assert.match(composer, /negativePatrol: includeNegativePatrol \? unattendedNegativePatrolRequest\(true, 'unattended_plan', negativePatrolStatuses\)/);
  assert.match(composer, /setNegativePatrolStatuses\(negativePatrolTriageStatuses\(sourcePlan \? planSnapshot/);
  assert.match(composer, /onStatusesChange=\{statuses => \{ markDefinitionChanged\(\); setNegativePatrolStatuses\(statuses\) \}\}/);
  assert.match(composer, /负面巡查处理状态：[\s\S]*negativePatrolStatusSummary\(negativePatrolStatuses\)/);
  assert.equal((composer.match(/includeNegativePatrol && !validNegativePatrolStatuses\(negativePatrolStatuses\)/g) || []).length, 2);
  assert.match(creator, /initialNegativePatrolStatuses: negativePatrolStatuses/);
  assert.match(dispatch, /initialNegativePatrolStatuses=\{orchestrationLaunchIntent.initialNegativePatrolStatuses\}/);
});
