import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_SUGGESTION_TENANT_ID, NON_MONITOR_REASON_PHRASES, NON_MONITOR_RISK_TERMS,
  NON_MONITOR_SERVICE_TERMS, TRIAGE_SUGGESTION_RULE_VERSION,
  evaluateNonMonitorSuggestion, formatTriageSuggestionReason, triageSuggestionEnabled,
} from '../shared/triage-suggestions.mjs';
import {parseTriageSuggestionBackfillArgs} from '../server/scripts/triage-suggestions-backfill.js';

const base={title:'别克全新车型亮相',content:'周末来看看这次的新车展示',ai_result:{
  contentTopic:'gm_other',relevance:'relevant',currentKeywordMatch:'irrelevant',category:'brand_image',
  sentiment:'neutral',relevanceReason:'属于通用品牌内容，未涉及当前监测主题，与搜索词不匹配。',
}};
const withAi=fields=>({...base,ai_result:{...base.ai_result,...fields}});
const hit=record=>assert.ok(evaluateNonMonitorSuggestion(record));
const miss=record=>assert.equal(evaluateNonMonitorSuggestion(record),null);

test('rule F requires the other-GM topic',()=>{
  hit(base);
  for(const contentTopic of ['onstar','infotainment','sentry','',undefined]) miss(withAi({contentTopic}));
});
test('rule F requires overall relevant and current keyword irrelevant together',()=>{
  hit(base);
  for(const relevance of ['irrelevant','uncertain','',undefined]) miss(withAi({relevance}));
  for(const currentKeywordMatch of ['relevant','uncertain','',undefined]) miss(withAi({currentKeywordMatch}));
});
test('rule F allows only brand image or other category',()=>{
  hit(withAi({category:'brand_image'}));hit(withAi({category:'other'}));
  for(const category of ['service_quality','feature_usage','renewal_billing','',undefined]) miss(withAi({category}));
});
test('rule F excludes negative sentiment',()=>{
  hit(withAi({sentiment:'positive'}));hit(withAi({sentiment:'neutral'}));
  for(const sentiment of ['negative',null,undefined,'','   ',0]) miss(withAi({sentiment}));
});
test('rule F requires an explicit mismatch phrase and retains its explanation',()=>{
  for(const phrase of NON_MONITOR_REASON_PHRASES) {
    const result=evaluateNonMonitorSuggestion(withAi({relevanceReason:`其它品牌动态，${phrase}搜索主题`}));
    assert.equal(result.evidence.reasonPhrase,phrase);
  }
  for(const relevanceReason of ['',undefined,{},'内容属于通用品牌动态']) miss(withAi({relevanceReason}));
});
test('rule F requires at least eight characters after removing hashtags mentions and spaces',()=>{
  miss({...base,title:'',content:'#别克 #全新车型 @别克官方'});
  miss({...base,title:'一二三四',content:'五 六 七 #车型 @名字'});
  hit({...base,title:'一二三四',content:'五 六 七 八 #车型 @名字'});
  miss({...base,title:'',content:'＃全新别克车型上市展示 ＠别克官方'});
  hit({...base,title:'别克全新车型亮相',content:'#车型#品牌 @名字'});
});
test('rule F checks all risk terms throughout the full original title and body',()=>{
  hit(base);
  for(const term of NON_MONITOR_RISK_TERMS) {
    miss({...base,title:`${base.title}${term}`});
    miss({...base,content:`${'新'.repeat(1000)}${term}`});
    miss({...base,content:`${base.content} #${term}`});
  }
});
test('rule F excludes every service term in the first 800 original characters, case-insensitively',()=>{
  hit(base);
  for(const term of NON_MONITOR_SERVICE_TERMS) {
    miss({...base,title:`${base.title}${term}`});
    miss({...base,content:`${base.content}${term.toLowerCase()}`});
    miss({...base,content:`${base.content}${term.toUpperCase()}`});
  }
  // Empty title contributes the joining newline. Terms entirely after the 800-character boundary do not veto rule F.
  hit({...base,title:'',content:`${'车'.repeat(799)}车机`});
  miss({...base,title:'',content:`${'车'.repeat(797)}车机`});
});
test('known acceptable false-positive categories remain matches: Escalade photos and LaCrosse milestone',()=>{
  // Synthetic descriptions of the documented categories, not copied customer records.
  hit({...base,title:'凯雷德晒图',content:'周末带大家看看这台大块头的新照片'});
  hit({...base,title:'君越第150万辆正式下线',content:'见证品牌发展历程中的又一重要时刻'});
});
test('shared explanations are readable, versioned and robust to serialized or malformed AI input',()=>{
  const result=evaluateNonMonitorSuggestion(base);
  assert.equal(result.ruleVersion,TRIAGE_SUGGESTION_RULE_VERSION);
  assert.match(formatTriageSuggestionReason(result),/与搜索词不匹配/u);
  assert.equal(formatTriageSuggestionReason(JSON.stringify(result)),result.summary);
  assert.ok(formatTriageSuggestionReason(null));
  assert.deepEqual(evaluateNonMonitorSuggestion({...base,ai_result:JSON.stringify(base.ai_result)}),result);
  for(const ai_result of ['invalid',null,[],42]) miss({...base,ai_result});
});
test('only the designated tenant defaults on, with explicit settings taking precedence',()=>{
  assert.equal(triageSuggestionEnabled(undefined,DEFAULT_SUGGESTION_TENANT_ID),true);
  assert.equal(triageSuggestionEnabled(undefined,'other'),false);
  for(const value of ['true','1','yes','ON']) assert.equal(triageSuggestionEnabled(value,'other'),true);
  for(const value of ['false','0','off','', 'invalid']) assert.equal(triageSuggestionEnabled(value,DEFAULT_SUGGESTION_TENANT_ID),false);
});
test('backfill CLI defaults to dry-run and requires an explicit tenant and write switch',()=>{
  assert.deepEqual(parseTriageSuggestionBackfillArgs(['--tenant',DEFAULT_SUGGESTION_TENANT_ID]),
    {tenantId:DEFAULT_SUGGESTION_TENANT_ID,apply:false,sampleLimit:20});
  assert.equal(parseTriageSuggestionBackfillArgs(['--tenant',DEFAULT_SUGGESTION_TENANT_ID,'--apply']).apply,true);
  for(const args of [[],['--tenant','all'],['--tenant',DEFAULT_SUGGESTION_TENANT_ID,'--samples','101'],
    ['--tenant',DEFAULT_SUGGESTION_TENANT_ID,'--samples','NaN'],['--force']])
    assert.throws(()=>parseTriageSuggestionBackfillArgs(args));
});
