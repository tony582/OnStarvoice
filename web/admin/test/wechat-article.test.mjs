import test from 'node:test'
import assert from 'node:assert/strict'
import { wechatArticleBodyBlocks, wechatArticleDetail, wechatArticleMetric, wechatArticlePresentation } from '../src/lib/wechat-article.mjs'
import { proxiedImg } from '../src/lib/utils.ts'
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

test('article detail preserves text/image order and matches local images by original ref, including repeated images', () => {
  const first='https://mmbiz.qpic.cn/first/640?wx_fmt=png',second='https://mmecoa.qpic.cn/second/640?wx_fmt=jpg'
  const record={metadata:{wechatArticle:{images:[{url:first,stored:true,localUrl:'/media/images/first.png'},{url:second,stored:false}],bodyBlocks:[
    {type:'text',text:'第一段'}, {type:'image',url:first,alt:'第一张'}, {type:'text',text:'第二段'},
    {type:'image',url:second}, {type:'image',url:first}, {type:'image',url:'javascript:alert(1)'},
  ]}}}
  const blocks=wechatArticleBodyBlocks(record,[{ref:second,url:'/api/img?url=second'},{ref:first,url:'/media/images/first.png'}])
  assert.deepEqual(blocks.map(block=>block.type),['text','image','text','image','image'])
  assert.deepEqual(blocks.filter(block=>block.type==='image').map(block=>[block.url,block.ref]),[
    ['/media/images/first.png',first],['/api/img?url=second',second],['/media/images/first.png',first],
  ])
  assert.equal(wechatArticleBodyBlocks(record,[{ref:first,url:'/api/img?url=first'}])[1].url,'/media/images/first.png')
  assert.deepEqual(wechatArticleBodyBlocks({content:'旧正文'}),[])
})

test('article detail preserves validated image layers without inventing layers on old or invalid data', () => {
  const url='https://mmbiz.qpic.cn/layer/640'
  const record={metadata:{wechatArticle:{images:[{url,stored:true,localUrl:'/media/images/layer.png'}],
    bodyBlocks:['visible','interactive','invalid',null,undefined].map(layer=>({type:'image',url,layer}))}}}
  const blocks=wechatArticleBodyBlocks(record)
  assert.deepEqual(blocks.map(block=>block.layer),['visible','interactive',undefined,undefined,undefined])
  assert.ok(blocks.every(block=>block.ref===url&&block.url==='/media/images/layer.png'))
  assert.ok(blocks.slice(2).every(block=>!Object.hasOwn(block,'layer')))
})

test('detail metrics prioritize unknown values, retain genuine zero and record individual source/time', () => {
  const record={likes:0,metadata:{wechatArticle:{metrics:{
    read:{value:100000,raw:'10万+',source:'page_dom',capturedAt:'2026-11-09T01:02:03Z'},
    like:{value:0,raw:'0',source:'screen_ocr',capturedAt:'2026-11-09T01:04:05Z'},
    share:{value:null,raw:'Share',source:'page_dom',capturedAt:'2026-11-09T01:02:03Z'},
    recommend:{value:null,raw:'12'},
  },comments:{headerCount:null,status:'unavailable',source:'screen_ocr',capturedAt:'2026-11-09T01:06:07Z'}}}}
  const metrics=Object.fromEntries(wechatArticleDetail(record).metrics.map(metric=>[metric.key,metric]))
  assert.equal(metrics.read.value,'10万+');assert.equal(metrics.read.source,'网页')
  assert.equal(metrics.read.capturedAt,'2026-11-09 09:02:03（北京时间）')
  assert.equal(metrics.like.value,'0');assert.equal(metrics.like.source,'手机')
  assert.equal(metrics.like.capturedAt,'2026-11-09 09:04:05（北京时间）')
  assert.equal(metrics.share.value,'未显示');assert.equal(metrics.recommend.value,'未显示')
  assert.equal(metrics.recommend.capturedAt,'读取时间未记录');assert.equal(metrics.comments.value,'未显示')
  assert.equal(wechatArticleMetric({shares:null},'shares'),'—')
})

test('article metadata separates account from author and formats the server Beijing publication shape accurately', () => {
  const record={author_name:'旧公众号',metadata:{wechatArticle:{account:'公众号',author:'署名作者',location:'上海',
    publishedAt:'2026-11-08 23:59',timePrecision:'minute',metrics:{like:{value:1,source:'screen_ocr',capturedAt:'2026-11-09 10:00'}}}}}
  const detail=wechatArticleDetail(record)
  assert.equal(detail.account,'公众号');assert.equal(detail.author,'署名作者');assert.equal(detail.location,'上海')
  assert.equal(detail.published,'2026-11-08 23:59（北京时间）')
  assert.equal(detail.metrics.find(metric=>metric.key==='like').capturedAt,'读取时间未记录')
  record.metadata.wechatArticle.publishedAt='2026-11-08T15:59:00Z'
  assert.equal(wechatArticleDetail(record).published,'2026-11-08 23:59（北京时间）')
  record.metadata.wechatArticle.publishedAt='2026-11-08';record.metadata.wechatArticle.timePrecision='date'
  assert.equal(wechatArticleDetail(record).published,'2026-11-08')
  record.metadata.wechatArticle.timePrecision='unknown'
  assert.equal(wechatArticleDetail(record).published,'')
})

test('missing comment entry is distinct from a zero count and preserves earlier comments',()=>{
  const record={metadata:{wechatArticle:{comments:{status:'unavailable',reason:'no_comment_entry',headerCount:null}}}}
  const presentation=wechatArticlePresentation(record,2)
  assert.equal(presentation.commentTitle,'未显示留言入口');assert.equal(presentation.commentTab,'留言 (2)')
  assert.match(presentation.commentDescription,/不能据此判断留言数量为零/)
  assert.match(presentation.commentDescription,/此前已采集/)
  assert.equal(wechatArticlePresentation({metadata:{wechatArticle:{comments:{status:'unavailable',reason:'read_failed'}}}}).commentTitle,'留言暂不可读取')
})

test('image storage describes saved discovered URLs without implying all original article images were captured',()=>{
  const record={metadata:{wechatArticle:{source:'page_dom',bodyStatus:'complete',evidence:{originalImagesCaptured:true,imageStorage:{expected:3,stored:3}}}}}
  assert.match(wechatArticlePresentation(record).bodyDescription,/已发现配图已保存 3\/3 张/)
  assert.doesNotMatch(wechatArticlePresentation(record).bodyDescription,/全部原图|完整采集|尚未保存/)
  record.metadata.wechatArticle.evidence.originalImagesCaptured=false
  record.metadata.wechatArticle.evidence.imageStorage.stored=1
  assert.match(wechatArticlePresentation(record).bodyDescription,/已发现配图已保存 1\/3 张/)
})

test('existing image proxy uses exact qpic hosts and preserves local paths and unrelated query strings',()=>{
  const previous=globalThis.window
  globalThis.window={location:{origin:'http://localhost'}}
  try {
    for (const url of ['https://qpic.cn/a.jpg','https://mmbiz.qpic.cn/a/640?wx_fmt=png','https://mmecoa.qpic.cn/mmecoa_png/b']) {
      assert.equal(proxiedImg(url),`/api/img?url=${encodeURIComponent(url)}`)
    }
    for (const url of ['https://qpic.cn.evil.test/a.jpg','https://evilqpic.cn/a.jpg','https://evil.test/a?host=mmbiz.qpic.cn','/media/images/local.png','/api/img?url=original']) {
      assert.equal(proxiedImg(url),url)
    }
  } finally { if(previous===undefined) delete globalThis.window; else globalThis.window=previous }
})
