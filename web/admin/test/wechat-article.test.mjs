import test from 'node:test'
import assert from 'node:assert/strict'
import { wechatArticleMetric, wechatArticlePresentation } from '../src/lib/wechat-article.mjs'
import { agentCreatePlatforms, mobileAgentPlatforms, mobileReadinessLabel } from '../src/pages/dispatch/cloud-tasks/lib.ts'
import { wechatFilterSummary } from '../src/pages/dispatch/cloud-tasks/wechatFilters.ts'

test('old runner cannot qualify solely by advertising the platform', () => {
  const capabilities = {agentKind:'android_mobile', supportedPlatforms:['wechat_articles']}
  assert.deepEqual(mobileAgentPlatforms({capabilities}), [])
  assert.deepEqual(mobileAgentPlatforms({capabilities:{...capabilities, runnerFeatures:['wechat_articles']}}), ['wechat_articles'])
  assert.deepEqual(mobileAgentPlatforms({capabilities:{...capabilities, agentKind:'browser', runnerFeatures:['wechat_articles']}}), [])
})

test('shared platform policy keeps video support and tenant restrictions while hiding unready article capability', () => {
  const capabilities={agentKind:'android_mobile', supportedPlatforms:['douyin','wechat_channels','wechat_articles'], runnerFeatures:['wechat_articles'], readyForSearch:true,readyPlatforms:['wechat_channels','wechat_articles']}
  assert.deepEqual(mobileAgentPlatforms({capabilities,allowed_platforms:['wechat_channels']}),['wechat_channels'])
  assert.deepEqual(mobileAgentPlatforms({capabilities:{agentKind:'android_mobile'}}),['douyin'])
  assert.deepEqual(agentCreatePlatforms({capabilities}),['douyin'])
  assert.equal(mobileReadinessLabel({capabilities:{...capabilities,runnerFeatures:[]}}),'可采 视频号')
})

test('shared WeChat filters keep latest time-window locking and omit unsupported article controls', () => {
  const filters={sort:'likes',publishTime:'week',videoDuration:'under_5m',searchScope:'followed'}
  assert.equal(wechatFilterSummary(filters),'最新 · 一周内 · 时长5分钟以下 · 已关注')
  assert.equal(wechatFilterSummary(filters,'wechat_articles'),'最新 · 一周内 · 文章及图文')
  assert.equal(wechatFilterSummary({...filters,publishTime:'all'},'wechat_articles'),'最热 · 不限时间 · 文章及图文')
})

test('unknown article metrics do not display stored legacy zeros; bounded text keeps its precision', () => {
  const record = {likes:0, shares:null, payload:{wechatArticle:{metrics:{like:{raw:'',value:null},read:{raw:'10万+',value:100000,precision:'lower_bound'},recommend:{raw:'0',value:0}}}}}
  assert.equal(wechatArticleMetric(record,'likes'),'—')
  assert.equal(wechatArticleMetric(record,'shares'),'—')
  assert.equal(wechatArticleMetric(record,'reads'),'10万+')
  assert.equal(wechatArticleMetric(record,'collects'),'0')
})

test('an empty local comment array is not evidence of no comments', () => {
  for (const status of ['closed','unavailable','unknown','disabled']) {
    const presentation=wechatArticlePresentation({payload:{wechatArticle:{comments:{status}}}},0)
    assert.equal(presentation.commentStatus,status)
    assert.equal(presentation.commentTab,'留言')
  }
  assert.equal(wechatArticlePresentation({comments_capture_status:'empty'},0).commentTab,'留言 (0)')
})

test('follow-only posting stays distinct from comment visibility and partial body stays visible', () => {
  const p=wechatArticlePresentation({payload:JSON.stringify({wechatArticle:{bodyStatus:'partial',comments:{status:'captured',postingState:'follow_required'}}})},3)
  assert.equal(p.bodyStatus,'partial')
  assert.equal(p.commentStatus,'captured')
  assert.equal(p.commentTab,'留言 (3)')
  assert.match(p.postingNote,/不影响查看/)
})

test('complete screen text does not imply original images were saved', () => {
  const p=wechatArticlePresentation({payload:{wechatArticle:{bodyStatus:'complete',evidence:{originalImagesCaptured:false}}}})
  assert.equal(p.bodyLabel,'正文已读完')
  assert.match(p.bodyDescription,/原始图片尚未保存/)
})

test('desktop text and observed image URLs do not claim saved original files or OCR provenance', () => {
  const p=wechatArticlePresentation({payload:{wechatArticle:{source:'page_dom',bodyStatus:'complete',
    images:[{url:'https://images.example.test/article.png',stored:false}],evidence:{originalImagesCaptured:false}}}})
  assert.equal(p.bodyLabel,'网页正文已读取')
  assert.match(p.bodyDescription,/正文来自文章网页/)
  assert.match(p.bodyDescription,/原始图片尚未确认保存/)
  assert.doesNotMatch(p.bodyDescription,/文字由手机画面识别/)
  assert.match(p.metricNotice,/未显示数字的项目记为未知/)
})

test('latest partial capture does not hide retained body and metric provenance', () => {
  const p=wechatArticlePresentation({metadata:{wechatArticle:{bodyStatus:'complete',metrics:{like:{value:23}},latestCapture:{bodyStatus:'partial',metrics:{like:{value:null}}}}}})
  assert.equal(p.bodyLabel,'正文已读完')
  assert.match(p.bodyDescription,/最近一次补采未读完整/)
  assert.match(p.metricNotice,/此前已知值/)
  assert.equal(wechatArticlePresentation({metadata:{wechatArticle:{metrics:{like:{value:23}},latestCapture:{metrics:{like:{value:23}}}}}}).metricNotice,'')
})

test('unread comment total remains unknown even when an older stored column was zero', () => {
  assert.equal(wechatArticleMetric({comments_count:0,metadata:{wechatArticle:{comments:{status:'unknown',headerCount:null}}}},'comments_count'),'—')
  assert.equal(wechatArticleMetric({metadata:{wechatArticle:{comments:{status:'empty',headerCount:0}}}},'comments_count'),'0')
})

test('closed comments distinguish retained earlier comments from newly visible ones', () => {
  const p=wechatArticlePresentation({metadata:{wechatArticle:{comments:{status:'closed'}}}},2)
  assert.equal(p.commentTab,'留言 (2)')
  assert.match(p.commentDescription,/此前已采集/)
})
