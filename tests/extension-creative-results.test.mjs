import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {renderCreativeOpportunity as opportunity, renderCreativeBenchmark as benchmark, renderCreativeInsightSummary as summary, renderCreativeInsightCategories as categories} from "../sidebar/creative-results.js";

test("result templates are read-only and have no collector, timer, storage or network dependency", async () => {
  const source = await readFile(new URL("../sidebar/creative-results.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:fetch|setTimeout|setInterval|requestAnimationFrame|MutationObserver)\s*\(|chrome\.|localStorage|sessionStorage|\bimport\b/);
});
test("opportunity keeps all directions, five metrics, subtopics, angles and source links", () => {
  const result = {keyword:"安吉星",ruleMetrics:{sampleCount:80,heatLevel:"high",highBandStart:1,highBandEnd:11,cliffDropRatio:.84,highBandAvgLikes:4280,medianLikes:8},distributionSummary:"这是结论。",hotTopicDirections:[{name:"方向甲",sampleCount:0,shareRatio:0,avgLikes:0,userIntent:"问题甲",whyItWorks:"依据甲",organicNote:"边界甲",representativeTitles:["真实标题"]}],coreWinningSubtopics:["细分甲"],recommendedAngles:[{title:"选题甲",audiencePainPoint:"问题乙",formatSuggestion:"形式甲",executionHint:"做法甲"}]};
  const html = opportunity(result,{resolveTitleUrl:(raw,title)=>{assert.equal(raw,result);assert.equal(title,"真实标题");return "https://example.invalid/note/1";}});
  for (const value of ["80 条搜索样本","样本热度","第 1–11 名","84%","4,280","样本中位赞","0 篇","样本占比 0%","问题甲","依据甲","边界甲","真实标题","细分甲","选题甲","问题乙","形式甲","做法甲"]) assert.ok(html.includes(value),value);
  assert.match(html,/href="https:\/\/example.invalid\/note\/1"/);
  assert.match(html,/data-action="copy-opportunity"/);
  assert.match(html,/data-action="share-opportunity-as-image"/);
  assert.doesNotMatch(html,/keyword-insight-share-menu|linear-gradient/);
});
test("unknown counts and ratios are never made into zero or a positive conclusion", () => {
  const html = opportunity({ruleMetrics:{},hotTopicDirections:[{shareRatio:null}]});
  assert.match(html,/样本数量未记录/);
  assert.match(html,/样本占比 未获取/);
  assert.match(html,/<dt>点赞落差<\/dt><dd>未获取/);
  assert.doesNotMatch(html,/样本占比 0%|不明显/);
  assert.match(opportunity({ruleMetrics:{sampleCount:0}}),/0 条搜索样本/);
});
test("long narrative is progressively disclosed without truncating or rewriting its content", () => {
  const remaining = "逐条依据与样本边界。".repeat(20);
  const html = opportunity({distributionSummary:`结论。${remaining}`});
  assert.match(html,/<p class="cr-copy">结论。<\/p><details/);
  assert.ok(html.includes(remaining));
});
test("escaping covers text, attributes, source links and rejects executable links", () => {
  const html = benchmark({keyword:'<img src=x onerror="x">',candidates:[{authorName:'"<script>',authorProfileUrl:"javascript:alert(1)",analysis:{tags:["A&B"]},topItems:[{title:"<unsafe>",url:"data:text/html,a"}]}]});
  assert.doesNotMatch(html,/<script|<img|href="(?:javascript|data):|data-url="javascript/);
  assert.match(html,/&lt;script&gt;/);
  assert.match(html,/A&amp;B/);
  assert.doesNotMatch(html,/A&amp;amp;B/);
});
test("benchmark retains original delegated controls, actual metrics and evidence helpers", () => {
  const candidate = {authorName:"示例",authorProfileUrl:"https://example.invalid/author",occurrenceCount:3,maxLikes:100,averageLikes:45,profile:{followersCount:500,likedAndCollectedCount:0,captureStatus:"done"},analysis:{recommendationReason:"理由",focusAssessment:"主页判断",tags:["标签"]}};
  const html=benchmark({keyword:"词",sampleCount:20,candidates:[candidate]}, {
    decisionAngle:()=>"判断角度：方向相关", evidence:()=>["粉丝 500，最高赞约为粉丝数 1 倍，有低粉高表现信号"],
    works:(raw,limit)=>{assert.equal(raw,candidate);assert.equal(limit,3);return [{title:"作品",url:"https://example.invalid/n",likes:0,collects:0}];},
  });
  for(const value of ['data-action="open-benchmark-profile"','data-action="monitor-benchmark-account"','data-url="https://example.invalid/author"','data-name="示例"',"主页判断","标签","点赞 0","收藏 0","主页赞藏 0","0.2 倍"]) assert.ok(html.includes(value),value);
  assert.equal((html.match(/判断角度/g)||[]).length,1);
  assert.doesNotMatch(html,/粉丝数 1 倍/);
});
test("unfinished profile does not turn normalized missing zero into a measured zero", () => {
  const html = benchmark({candidates:[{profile:{followersCount:0,likedAndCollectedCount:0,captureStatus:"failed"}}]});
  assert.match(html,/粉丝 未获取/);
  assert.match(html,/主页赞藏 未获取/);
});
test("longtail has truthful copy affordances without invented selection or batch capture", () => {
  const analysis={summary:"需求概览",categories:[{id:'a"b',name:"续费",keywords:["价格","价值"],insight:"观察"}]};
  const head=summary({seedKeyword:"安吉星",totalKeywords:2,analysis});
  assert.match(head,/2 个扩展词 · 1 个需求方向/);
  assert.match(head,/点击词语可复制/);
  assert.doesNotMatch(head,/已选|0\/10/);
  const closed=categories({analysis,totalKeywords:2});
  assert.match(closed,/aria-expanded="false"/);
  assert.doesNotMatch(closed,/data-action="toggle-keyword"/);
  const open=categories({analysis,totalKeywords:2,expandedIds:new Set(['a"b'])});
  assert.match(open,/aria-expanded="true"/);
  assert.match(open,/data-category-id="a&quot;b"/);
  assert.match(open,/<button[^>]*data-action="toggle-keyword"[^>]*data-keyword="价格"/);
});
test("longtail sample source and missing-data states remain accessible", () => {
  const analysis={categories:[{id:"a",keywords:[]},{id:"b",keywords:[]},{id:"c",keywords:[]}]};
  const html=categories({analysis,sampleStatusByCategoryId:{a:"loading",b:"error"},sampleResultsByCategoryId:{b:{errorMessage:"测试失败"},c:{usedKeyword:"来源词",samples:[{title:"",likes:null,url:"https://example.invalid/n"}]}}});
  for(const value of ["正在读取样本","测试失败","来源词","查看原作品（无标题）","点赞 未获取","https://example.invalid/n"])assert.ok(html.includes(value),value);
  assert.doesNotMatch(html,/❤️|🤔/);
});
test("malformed cached arrays do not prevent the rest of a result from rendering", () => {
  assert.doesNotThrow(()=>opportunity({hotTopicDirections:[null],recommendedAngles:[null]}));
  assert.doesNotThrow(()=>benchmark({candidates:[null]}));
  assert.doesNotThrow(()=>categories({analysis:{categories:[null]}}));
  assert.doesNotThrow(()=>categories({analysis:{categories:[{id:"a"}]},sampleStatusByCategoryId:null,sampleResultsByCategoryId:null}));
  assert.equal(opportunity(null),"");assert.equal(benchmark(null),"");assert.equal(summary(),"");
});
