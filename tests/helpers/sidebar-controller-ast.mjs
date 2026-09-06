import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';

// Both parsers are already pinned by the existing admin lockfile. This helper
// neither installs dependencies nor uses Git, network, a browser or live data.
const root = new URL('../../', import.meta.url);
const requireAdmin = createRequire(new URL('web/admin/package.json', root));
const espree = requireAdmin('espree');
const {analyze} = requireAdmin('eslint-scope');
export const AST_AUDIT_VERSION = 'l3b-owner-normalization-v1';

export const approvedAstReadPorts = Object.freeze({
  readExpandedKeywordsBuffer: 'expandedKeywordsBuffer',
  readKeywordAnalysisInFlight: 'keywordAnalysisInFlight',
  readKeywordBenchmarkAnalysisStatus: 'keywordBenchmarkAnalysisStatus',
  readKeywordBenchmarkErrorMessage: 'keywordBenchmarkErrorMessage',
  readKeywordBenchmarkInFlight: 'keywordBenchmarkInFlight',
  readKeywordBenchmarkLoadingMeta: 'keywordBenchmarkLoadingMeta',
  readKeywordBenchmarkLoadingTitle: 'keywordBenchmarkLoadingTitle',
  readKeywordBenchmarkResult: 'keywordBenchmarkResult',
  readKeywordExpandCancelRequested: 'keywordExpandCancelRequested',
  readKeywordExpandInFlight: 'keywordExpandInFlight',
  readKeywordOpportunityErrorMessage: 'keywordOpportunityErrorMessage',
  readKeywordOpportunityInFlight: 'keywordOpportunityInFlight',
  readKeywordOpportunityResult: 'keywordOpportunityResult',
  readKeywordPlanState: 'keywordPlanState',
  readKeywordSortDimension: 'keywordSortDimension',
  readLastRuntimePageTypeForKeywordSort: 'lastRuntimePageTypeForKeywordSort',
  readLastRuntimePageUrlForKeywordSort: 'lastRuntimePageUrlForKeywordSort',
  readActiveRecoveryProgress: 'activeRecoveryProgress',
  readDetailBatchCaptureInFlight: 'detailBatchCaptureInFlight',
  readBatchUrlCaptureInFlight: 'batchUrlCaptureInFlight',
  readTargetedPostRunState: 'targetedPostRunState',
  readBatchKeywordCaptureInFlight: 'batchKeywordCaptureInFlight',
  readActiveBatchRunnerTabId: 'activeBatchRunnerTabId',
  readMonitorRunInFlight: 'monitorRunInFlight',
  readActiveUnattendedRunRequestId: 'activeUnattendedRunRequestId',
});

export const approvedKeywordModelPorts = Object.freeze({
  activeUnattendedRunRequestId: 'readActiveUnattendedRunRequestId',
  expandedKeywordsBuffer: 'readExpandedKeywordsBuffer',
  keywordAnalysisInFlight: 'readKeywordAnalysisInFlight',
  keywordBenchmarkAnalysisStatus: 'readKeywordBenchmarkAnalysisStatus',
  keywordBenchmarkErrorMessage: 'readKeywordBenchmarkErrorMessage',
  keywordBenchmarkInFlight: 'readKeywordBenchmarkInFlight',
  keywordBenchmarkLoadingMeta: 'readKeywordBenchmarkLoadingMeta',
  keywordBenchmarkLoadingTitle: 'readKeywordBenchmarkLoadingTitle',
  keywordBenchmarkResult: 'readKeywordBenchmarkResult',
  keywordExpandCancelRequested: 'readKeywordExpandCancelRequested',
  keywordExpandInFlight: 'readKeywordExpandInFlight',
  keywordOpportunityErrorMessage: 'readKeywordOpportunityErrorMessage',
  keywordOpportunityInFlight: 'readKeywordOpportunityInFlight',
  keywordOpportunityResult: 'readKeywordOpportunityResult',
  keywordPlanState: 'readKeywordPlanState',
  keywordSortDimension: 'readKeywordSortDimension',
  lastRuntimePageTypeForKeywordSort: 'readLastRuntimePageTypeForKeywordSort',
  lastRuntimePageUrlForKeywordSort: 'readLastRuntimePageUrlForKeywordSort',
});

export const approvedAstSetPorts = Object.freeze({
  setStrategyPanelVisible: 'keywordStrategyPanelVisible',
  setStrategyActiveTab: 'keywordStrategyActiveTab',
  setExpandedKeywordsVisible: 'expandedKeywordsPanelVisible',
});

const historical = JSON.parse(readFileSync(new URL('tests/fixtures/sidebar-controller-migration.json', root), 'utf8'));
const candidate = JSON.parse(readFileSync(new URL('tests/fixtures/sidebar-controller-l3b-migration.json', root), 'utf8'));
const stateNames = {
  controllerState: new Set([...historical.state.map(entry => entry.name),
    ...candidate.state.filter(entry => entry.owner === 'controllerState').map(entry => entry.name)]),
  controllerBindings: new Set(['keywordPlanState', 'activeKeywordRunState', 'keywordSortDimension', 'expandedKeywordsBuffer']),
  legacyViewState: new Set(candidate.state.filter(entry => entry.owner === 'legacyViewState').map(entry => entry.name)),
};
const metadata = new Set(['range', 'loc', 'start', 'end']);
const identifier = name => ({type: 'Identifier', name});
const plainMember = node => node?.type === 'MemberExpression' && node.computed === false && node.optional === false && node.property?.type === 'Identifier';
const plainCall = node => node?.type === 'CallExpression' && node.optional === false;

export function parseSidebarAst(source) {
  return espree.parse(source, {ecmaVersion: 'latest', sourceType: 'module', range: true});
}

export function findSidebarFunctionAst(ast, name) {
  const matches = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration' && node.id?.name === name) matches.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(ast);
  assert.equal(matches.length, 1, `expected one exact AST declaration of ${name}`);
  return matches[0];
}

export function normalizeSidebarFunctionAst(node) {
  assert.equal(node?.type, 'FunctionDeclaration');
  // Analyze this function in isolation: only free references can be injected
  // state/query ports. A same-named parameter, local or catch binding stays real.
  const scope = analyze({type: 'Program', sourceType: 'module', body: [node], range: node.range},
    {ecmaVersion: 2022, sourceType: 'module', optimistic: false, ignoreEval: false});
  const free = new Set(scope.globalScope.through.map(reference => reference.identifier));
  const freeOwner = (value, name) => value?.type === 'Identifier' && value.name === name && free.has(value);
  function normalize(value, parent = null, field = '') {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(child => normalize(child, parent, field));
    if (plainMember(value)) {
      const owner = value.object?.name;
      const changesReceiver = ((parent?.type === 'CallExpression' || parent?.type === 'NewExpression') && field === 'callee') ||
        (parent?.type === 'TaggedTemplateExpression' && field === 'tag');
      if (!changesReceiver && Object.hasOwn(stateNames, owner) && stateNames[owner].has(value.property.name) && freeOwner(value.object, owner)) return identifier(value.property.name);
    }
    if (plainCall(value) && plainMember(value.callee)) {
      const member = value.callee;
      const name = member.property.name;
      if (value.arguments.length === 0 && freeOwner(member.object, 'keywordModel') && Object.hasOwn(approvedKeywordModelPorts, name)) return identifier(name);
      if (value.arguments.length === 0 && freeOwner(member.object, 'sidebarTaskController') && Object.hasOwn(approvedAstReadPorts, name)) return identifier(approvedAstReadPorts[name]);
      if (value.arguments.length === 1 && value.arguments[0].type !== 'SpreadElement' &&
          plainMember(member.object) && member.object.property.name === 'taskView' &&
          freeOwner(member.object.object, 'controllerPorts') && Object.hasOwn(approvedAstSetPorts, name)) {
        return {type: 'AssignmentExpression', operator: '=', left: identifier(approvedAstSetPorts[name]), right: normalize(value.arguments[0])};
      }
    }
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      if (typeof value.type === 'string' && metadata.has(key)) continue;
      // Only a Literal's alternate quote/number spelling is non-semantic.
      // TemplateElement.value.raw AND cooked, and Literal.regex.pattern/flags,
      // are ordinary records and are retained byte-for-byte.
      if (value.type === 'Literal' && key === 'raw') continue;
      result[key] = normalize(child, value, key);
    }
    return result;
  }
  return normalize(node);
}

export function serializeSidebarAst(value) {
  return JSON.stringify(value, (_key, child) => {
    if (typeof child === 'bigint') return {bigintValue: child.toString()};
    if (!child || typeof child !== 'object' || Array.isArray(child)) return child;
    return Object.fromEntries(Object.keys(child).sort().map(key => [key, child[key]]));
  });
}

export function hashSidebarFunctionAst(node) {
  return createHash('sha256').update(serializeSidebarAst(normalizeSidebarFunctionAst(node))).digest('hex');
}
