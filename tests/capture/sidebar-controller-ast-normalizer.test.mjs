import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
import {createSidebarTaskController} from '../../sidebar/task-controller/coordinator.js';
import {createLegacyKeywordView} from '../../sidebar/legacy-view/coordinator.js';
import {
  approvedAstReadPorts,
  approvedKeywordModelPorts,
  approvedAstSetPorts,
  parseSidebarAst,
  findSidebarFunctionAst,
  hashSidebarFunctionAst,
} from '../helpers/sidebar-controller-ast.mjs';

const root = new URL('../../', import.meta.url);
const functionAst = source => findSidebarFunctionAst(parseSidebarAst(source), 'probe');
const hash = source => hashSidebarFunctionAst(functionAst(source));
const bodyHash = body => hash(`function probe(value) { ${body} }`);

test('AST dependencies come from the existing locked admin installation without new packages', () => {
  const lock = JSON.parse(readFileSync(new URL('web/admin/package-lock.json', root), 'utf8'));
  const requireAdmin = createRequire(new URL('web/admin/package.json', root));
  for (const name of ['espree', 'eslint-scope']) {
    assert.equal(requireAdmin(`${name}/package.json`).version, lock.packages[`node_modules/${name}`].version, name);
  }
  const workflow = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8');
  const compatibility = workflow.match(/^  production-runtime-compatibility:\n([\s\S]*?)(?=^  [\w-]+:|$(?![\s\S]))/mu)?.[1];
  assert.ok(compatibility, 'the clean production-runtime job must prepare AST tooling');
  assert.match(compatibility, /node-version-file: \.nvmrc[\s\S]*npm --prefix web\/admin ci --ignore-scripts[\s\S]*node-version: 18\.20\.8[\s\S]*npm --prefix server ci[\s\S]*npm --prefix server test/u);
  assert.doesNotMatch(compatibility, /continue-on-error|--test-skip-pattern/u);
});

test('normalizer removes only approved free state-owner qualification and exact named bridge calls', () => {
  for (const [owner, state] of [['controllerState', 'keywordPlanState'], ['controllerBindings', 'activeKeywordRunState'], ['legacyViewState', 'keywordStrategyPanelVisible']]) {
    assert.equal(bodyHash(`return ${owner}.${state};`), bodyHash(`return ${state};`));
  }
  assert.equal(Object.keys(approvedAstReadPorts).length, 25);
  assert.equal(Object.keys(approvedKeywordModelPorts).length, 18);
  assert.equal(Object.keys(approvedAstSetPorts).length, 3);
  for (const [read, state] of Object.entries(approvedAstReadPorts)) assert.equal(bodyHash(`return sidebarTaskController.${read}();`), bodyHash(`return ${state};`), read);
  for (const state of Object.keys(approvedKeywordModelPorts)) assert.equal(bodyHash(`return keywordModel.${state}();`), bodyHash(`return ${state};`), state);
  for (const [setter, state] of Object.entries(approvedAstSetPorts)) assert.equal(bodyHash(`controllerPorts.taskView.${setter}(value);`), bodyHash(`${state} = value;`), setter);
});

test('unknown, computed, optional, wrong-receiver and extra-argument ports remain different ASTs', () => {
  const stateCases = [
    ['controllerState.notApproved', 'notApproved'],
    ['controllerBindings.notApproved', 'notApproved'],
    ['legacyViewState.notApproved', 'notApproved'],
    ['other.keywordPlanState', 'keywordPlanState'],
    ['toString.keywordPlanState', 'keywordPlanState'],
    ['controllerState["keywordPlanState"]', 'keywordPlanState'],
    ['controllerState?.keywordPlanState', 'keywordPlanState'],
    ['controllerState.keywordPlanState()', 'keywordPlanState()'],
    ['controllerState.keywordPlanState`tag`', 'keywordPlanState`tag`'],
    ['sidebarTaskController.readNotApproved()', 'notApproved'],
    ['keywordModel.notApproved()', 'notApproved'],
    ['other.readKeywordPlanState()', 'keywordPlanState'],
    ['sidebarTaskController["readKeywordPlanState"]()', 'keywordPlanState'],
    ['sidebarTaskController?.readKeywordPlanState()', 'keywordPlanState'],
    ['sidebarTaskController.readKeywordPlanState?.()', 'keywordPlanState'],
    ['sidebarTaskController.readKeywordPlanState(value)', 'keywordPlanState'],
    ['keywordModel.keywordPlanState(value)', 'keywordPlanState'],
  ];
  for (const [expression, expected] of stateCases) assert.notEqual(bodyHash(`return ${expression};`), bodyHash(`return ${expected};`), expression);
  for (const expression of [
    'other.taskView.setStrategyPanelVisible(value)',
    'other.controllerPorts.taskView.setStrategyPanelVisible(value)',
    'taskView.setStrategyPanelVisible(value)',
    'controllerPorts["taskView"].setStrategyPanelVisible(value)',
    'controllerPorts.taskView["setStrategyPanelVisible"](value)',
    'controllerPorts.taskView?.setStrategyPanelVisible(value)',
    'controllerPorts.taskView.setStrategyPanelVisible?.(value)',
    'controllerPorts.taskView.setStrategyPanelVisible()',
    'controllerPorts.taskView.setStrategyPanelVisible(value, sideEffect())',
    'controllerPorts.taskView.setStrategyPanelVisible(...value)',
    'controllerPorts.taskView.notApproved(value)',
  ]) assert.notEqual(bodyHash(`${expression};`), bodyHash('keywordStrategyPanelVisible = value;'), expression);
});

test('shadowed parameters, locals, catch bindings and nested functions are not injected owner ports', () => {
  for (const [before, after] of [
    ['function probe(controllerState) { return controllerState.keywordPlanState; }', 'function probe(controllerState) { return keywordPlanState; }'],
    ['function probe() { const keywordModel = value; return keywordModel.keywordPlanState(); }', 'function probe() { const keywordModel = value; return keywordPlanState; }'],
    ['function probe() { try { work(); } catch (controllerBindings) { return controllerBindings.keywordPlanState; } }', 'function probe() { try { work(); } catch (controllerBindings) { return keywordPlanState; } }'],
    ['function probe() { return function nested(sidebarTaskController) { return sidebarTaskController.readKeywordPlanState(); }; }', 'function probe() { return function nested(sidebarTaskController) { return keywordPlanState; }; }'],
    ['function probe(controllerPorts, value) { controllerPorts.taskView.setStrategyPanelVisible(value); }', 'function probe(controllerPorts, value) { keywordStrategyPanelVisible = value; }'],
  ]) assert.notEqual(hash(before), hash(after));
});

test('template raw and cooked content both survive normalization, including equal-cooked escapes and whitespace', () => {
  const escaped = functionAst('function probe() { return `line\\nvalue`; }');
  const literalNewline = functionAst('function probe() { return `line\nvalue`; }');
  assert.equal(escaped.body.body[0].argument.quasis[0].value.cooked, literalNewline.body.body[0].argument.quasis[0].value.cooked);
  assert.notEqual(hashSidebarFunctionAst(escaped), hashSidebarFunctionAst(literalNewline));
  for (const key of ['raw', 'cooked']) {
    const changed = functionAst('function probe() { return `<div>\n  value\n</div>`; }');
    const before = hashSidebarFunctionAst(changed);
    changed.body.body[0].argument.quasis[0].value[key] += '  ';
    assert.notEqual(hashSidebarFunctionAst(changed), before, key);
  }
  assert.notEqual(bodyHash('return `<div>\n  value`;'), bodyHash('return `<div>\nvalue`;'));
});

test('regex pattern and flags, Literal values and BigInts remain distinguishable', () => {
  for (const [a, b] of [['/first/giu', '/second/giu'], ['/first/g', '/first/i'], ['10', '11'], ['"before"', '"after"'], ['true', 'false'], ['10n', '11n']]) {
    assert.notEqual(bodyHash(`return ${a};`), bodyHash(`return ${b};`), `${a} versus ${b}`);
  }
  assert.equal(bodyHash('return "A";'), bodyHash("return '\\x41';"), 'only ordinary Literal lexical raw is ignored');
  assert.equal(bodyHash('return 1_000;'), bodyHash('return 1000;'));
});

test('normalizer ignores source locations but preserves branch, await and side-effect order', () => {
  const source = 'function probe() { return controllerState.keywordPlanState; }';
  assert.equal(hash(source), hash(`\n\n// location only\n${source}`));
  assert.notEqual(bodyHash('first(); second();'), bodyHash('second(); first();'));
  assert.notEqual(bodyHash('if (value) first();'), bodyHash('if (!value) first();'));
  assert.notEqual(hash('async function probe() { return await work(); }'), hash('async function probe() { return work(); }'));
  assert.throws(() => findSidebarFunctionAst(parseSidebarAst('function a(){function probe(){}} function b(){function probe(){}}'), 'probe'), /one exact AST declaration/u);
});

test('approved read and setter ports are actual identity bridges, not assumed name-based semantics', () => {
  const controller = createSidebarTaskController({});
  const view = createLegacyKeywordView({ports: {}, application: {}, keywordModel: {}});
  const arrow = operation => functionAst(`function probe(){return (${operation.toString()});}`).body.body[0].argument;
  const expectMember = (node, owner, property) => {
    assert.equal(node.type, 'MemberExpression');
    assert.equal(node.computed, false);
    assert.equal(node.optional, false);
    assert.equal(node.object.type, 'Identifier');
    assert.equal(node.object.name, owner);
    assert.equal(node.property.type, 'Identifier');
    assert.equal(node.property.name, property);
  };
  for (const [read, state] of Object.entries(approvedAstReadPorts)) {
    const operation = arrow(controller[read]);
    assert.equal(operation.type, 'ArrowFunctionExpression');
    assert.equal(operation.async, false);
    assert.equal(operation.params.length, 0);
    expectMember(operation.body, 'controllerState', state);
  }
  for (const [setter, state] of Object.entries(approvedAstSetPorts)) {
    const operation = arrow(view[setter]);
    assert.equal(operation.type, 'ArrowFunctionExpression');
    assert.equal(operation.async, false);
    assert.equal(operation.params.length, 1);
    assert.equal(operation.params[0].type, 'Identifier');
    assert.equal(operation.params[0].name, 'value');
    assert.equal(operation.body.type, 'AssignmentExpression');
    assert.equal(operation.body.operator, '=');
    expectMember(operation.body.left, 'legacyViewState', state);
    assert.equal(operation.body.right.type, 'Identifier');
    assert.equal(operation.body.right.name, 'value');
  }
  const host = parseSidebarAst(readFileSync(new URL('sidebar/sidebar-logic.js', root), 'utf8'));
  const declaration = host.body.flatMap(node => node.type === 'VariableDeclaration' ? node.declarations : []).find(node => node.id?.name === 'legacyKeywordView');
  const model = declaration.init.arguments[0].properties.find(property => property.key.name === 'keywordModel').value;
  expectMember(model.callee, 'Object', 'freeze');
  assert.equal(model.arguments.length, 1);
  const properties = model.arguments[0].properties;
  assert.deepEqual(properties.map(property => property.key.name).sort(), Object.keys(approvedKeywordModelPorts).sort());
  for (const property of properties) {
    const operation = property.value;
    assert.equal(operation.type, 'ArrowFunctionExpression');
    assert.equal(operation.async, false);
    assert.equal(operation.params.length, 0);
    assert.equal(operation.body.type, 'CallExpression');
    assert.equal(operation.body.optional, false);
    assert.equal(operation.body.arguments.length, 0);
    expectMember(operation.body.callee, 'sidebarTaskController', approvedKeywordModelPorts[property.key.name]);
  }
});
