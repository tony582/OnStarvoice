import {createHash} from 'node:crypto';
import {DiscoveryError, requireUuid} from '../capture-discovery/validation.js';
export const WORKFLOW = 'douyin_mobile_discovery';
export const LEASE_MS = 90_000;
export const fail = (code, status = 409) => { throw new DiscoveryError(code, status); };
export function text(value, field, max = 240) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`INVALID_${field}`, 400);
  return value.trim();
}
export const id = (value, field = 'ID') => requireUuid(value, field);
export function json(value = {}, max = 16384) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || JSON.stringify(value).length > max) fail('INVALID_OBJECT', 400);
  return JSON.parse(JSON.stringify(value));
}
export function digest(value) {
  function stable(v) { return v && typeof v === 'object' ? Array.isArray(v) ? v.map(stable)
    : Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v; }
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
export function identity(input) {
  const result = Object.fromEntries(['taskId','discoveryRunId','itemId','attemptId','agentId'].map(k => [k,id(input?.[k],k)]));
  if (result.taskId !== result.discoveryRunId) fail('RUN_TASK_MISMATCH',400);
  if (!/^[a-f0-9]{64}$/.test(input.requestHash) || !Number.isInteger(input.assignmentRevision) || input.assignmentRevision < 1) fail('INVALID_ATTEMPT',400);
  return {...result, requestHash: input.requestHash, assignmentRevision: input.assignmentRevision};
}
export function runInput(input = {}) {
  const keywords = input.keywords ?? ['别克壁纸', '君越壁纸'];
  if (!Array.isArray(keywords) || keywords.length < 1 || keywords.length > 2) fail('ONE_OR_TWO_KEYWORDS_REQUIRED',400);
  const normalized = [...new Set(keywords.map(k => text(k,'KEYWORD',128)))];
  const filters = input.filters ?? {sort:'comprehensive',range:'day'};
  if (!filters || Array.isArray(filters) || typeof filters !== 'object'
      || !['latest','comprehensive'].includes(filters.sort) || filters.range !== 'day'
      || Object.keys(filters).some(k => !['sort','range'].includes(k))) fail('INVALID_FILTERS',400);
  const limits = {maxLinks:20,maxCards:40,maxSwipes:20,keywordMs:600000,batchMs:1500000,maxPending:100};
  const budgets = {...limits,...json(input.budgets)};
  for (const [k,v] of Object.entries(budgets)) if (!(k in limits) || !Number.isInteger(v) || v < 1 || v > limits[k]) fail('INVALID_BUDGETS',400);
  return {agentId:id(input.agentId),title:text(input.title || '抖音手机发现试验','TITLE'),keywords:normalized,filters,budgets};
}
