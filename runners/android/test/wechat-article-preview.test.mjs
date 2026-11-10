import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {readArticleDocument} from '../src/preview/article-dom.mjs';
import {createSharePreview} from '../src/preview/share-preview.mjs';

// No browser, network, HTML fetch or site access: all nodes and CDP replies are local test doubles.
const URL_A = 'https://mp.weixin.qq.com/s/ArticleFixture123';
const URL_B = 'https://mp.weixin.qq.com/s/AnotherFixture456';
const AT = '2026-11-09T10:00:00.000Z';
function element(tagName, attributes = {}, ...children) {
  const node = {nodeType: 1, tagName: tagName.toUpperCase(), attributes, style: {}, parentElement: null,
    getAttribute: key => attributes[key] ?? null,
    getClientRects: () => [{}],
    get children() { return this.childNodes.filter(child => child.nodeType === 1); },
    get textContent() { return this.childNodes.map(child => child.textContent).join(''); },
    get innerText() { return this.childNodes.filter(child => !child.hidden && child.style?.display !== 'none'
      && !['SCRIPT','STYLE'].includes(child.tagName)).map(child => child.innerText ?? child.textContent).join(''); },
    contains(other) { return this === other || this.children.some(child => child.contains(other)); },
  };
  node.childNodes = children.flat().map(child => typeof child === 'string' ? {nodeType: 3, textContent: child} : child);
  for (const child of node.childNodes) child.parentElement = node;
  return node;
}
function documentFixture({url = URL_A, date = '2026年11月9日 17:30', title = '测试文章', content, extra = [], readyState = 'complete', bodyOnly} = {}) {
  const root = element('div', {id: 'js_content', class: 'rich_media_content'}, ...(content ?? [element('p', {}, '第一段正文。'), element('p', {}, '第二段正文。')]));
  const body = bodyOnly ?? element('body', {}, element('h1', {id: 'activity-name'}, title),
    element('span', {id: 'js_name'}, '测试公众号'), element('span', {id: 'publish_time'}, date), root, ...extra);
  const nodes = node => [node, ...node.children.flatMap(nodes)];
  const querySelectorAll = selectors => {
    const choices = selectors.split(',').map(value => value.trim());
    return nodes(body).filter(node => choices.some(selector => selector.startsWith('#') ? node.attributes.id === selector.slice(1)
      : selector.startsWith('.') ? String(node.attributes.class ?? '').split(' ').includes(selector.slice(1))
        : selector.startsWith('[') ? node.attributes[selector.match(/^\[([^=]+)/u)?.[1]] === selector.match(/="([^"]+)"/u)?.[1]
          : node.tagName === selector.toUpperCase()));
  };
  return {URL: url, readyState, body, root, querySelectorAll, defaultView: {getComputedStyle: node => node.style}};
}
const extract = (document, options = {}) => readArticleDocument(document, {expectedUrl: URL_A, capturedAt: AT, ...options});

test('visible DOM supplies exact paragraphs and ordered image references without claiming storage', () => {
  const hidden = element('p', {}, '隐藏的令牌不要读取'); hidden.style.display = 'none';
  const document = documentFixture({content: [element('p', {}, '开头', element('strong', {}, '正文')),
    element('img', {'data-src': 'https://images.example.test/one.png', alt: '第一张'}), hidden,
    element('script', {}, 'window.secret="ignore"'), element('p', {}, '后半段'),
    element('img', {src: '//images.example.test/two.jpg'})]});
  const result = extract(document);
  assert.equal(result.ok, true);
  const article = result.article;
  assert.equal(article.content, '开头正文\n后半段');
  assert.deepEqual(article.bodyBlocks.map(block => block.type), ['text','image','text','image']);
  assert.deepEqual(article.images.map(image => [image.order,image.url,image.stored]), [[0,'https://images.example.test/one.png',false],[1,'https://images.example.test/two.jpg',false]]);
  assert.equal(article.source, 'page_dom');
  assert.equal(article.publishedAt, '2026-11-09T17:30:00+08:00');
  assert.equal(article.evidence.selectorAcceptance, 'live_dom_20261109');
  assert.equal(article.bodyStatus, 'complete');
});

test('DOM extractor remains self-contained when serialized into the page', () => {
  const document = documentFixture();
  const result = vm.runInNewContext(`(${readArticleDocument.toString()})(document,options)`, {document, options:{expectedUrl:URL_A,capturedAt:AT}, URL, Date, Set});
  assert.equal(result.article.title, '测试文章');
});

test('short-link identity is strict while tracking query and fragment do not change identity', () => {
  assert.equal(extract(documentFixture({url:URL_A+'?tracking=1#wechat_redirect'})).article.url,URL_A);
  for (const url of [URL_B,'https://mp.weixin.qq.com.evil.test/s/ArticleFixture123','http://mp.weixin.qq.com/s/ArticleFixture123','https://user@mp.weixin.qq.com/s/ArticleFixture123','https://mp.weixin.qq.com/s?__biz=x']) {
    assert.equal(extract(documentFixture({url})).reason,'article_preview_identity_mismatch');
  }
});

test('verification and unavailable pages fail without mistaking article prose for a gate', () => {
  assert.equal(extract(documentFixture({bodyOnly:element('body',{},'环境异常，请完成验证')})).reason,'article_preview_verification_required');
  assert.equal(extract(documentFixture({bodyOnly:element('body',{},'该内容已被发布者删除')})).reason,'article_preview_unavailable');
  assert.equal(extract(documentFixture({extra:[element('div',{role:'dialog'},'请完成安全验证')]})).reason,'article_preview_verification_required');
  assert.equal(extract(documentFixture({content:[element('p',{},'本文讨论安全验证与内容已被删除的处理。')]})).ok,true);
});

test('incomplete DOM and folded content do not report a complete body', () => {
  assert.equal(extract(documentFixture({readyState:'loading'})).reason,'article_preview_loading');
  assert.equal(extract(documentFixture({title:''})).reason,'article_preview_header_incomplete');
  assert.equal(extract(documentFixture({content:[]})).reason,'article_preview_body_empty');
  assert.equal(extract(documentFixture({content:[element('p',{},'部分正文'),element('button',{},'展开全文')]})).reason,'article_preview_body_folded');
  assert.equal(extract(documentFixture({extra:[element('div',{role:'button'},'继续阅读')]})).reason,'article_preview_body_folded');
  assert.equal(extract(documentFixture({content:[element('p',{},'继续阅读')]})).ok,true);
  const article=extract(documentFixture({content:[element('p',{},'文字'),element('img',{src:'data:image/png;base64,eA=='})]})).article;
  assert.equal(article.bodyStatus,'partial'); assert.equal(article.bodyReason,'image_url_unavailable');
});

test('date precision and unknown dates are preserved, invalid/future dates fail', () => {
  const day=extract(documentFixture({date:'2026年11月8日'})).article;
  assert.equal(day.publishedAt,'2026-11-08'); assert.equal(day.timePrecision,'date');
  const unknown=extract(documentFixture({date:'昨天'})).article;
  assert.equal(unknown.publishedAt,null); assert.equal(unknown.timePrecision,'unknown');
  for (const date of ['2026年2月30日','2026年13月1日','2026年11月9日 25:00','2027年1月1日']) {
    assert.equal(extract(documentFixture({date})).reason,'article_preview_invalid_time');
  }
  for (const [date, time] of [['Nov 8, 2026, 11:59 PM','23:59'], ['Nov 8, 2026, 12:01 AM','00:01'], ['Nov 8, 2026, 12:00 PM','12:00']]) {
    assert.equal(extract(documentFixture({date})).article.publishedAt,`2026-11-08T${time}:00+08:00`);
  }
  for (const date of ['Feb 30, 2026, 1:00 PM','Nov 8, 2026, 0:01 AM','Nov 8, 2026, 13:01 PM','Nov 8, 2026, 12:60 AM']) {
    assert.equal(extract(documentFixture({date})).reason,'article_preview_invalid_time');
  }
});

test('transparent or zero-height image ancestors mark interaction layers without exposing hidden text', () => {
  const image=element('img',{'data-src':'https://mmbiz.qpic.cn/mmbiz_png/public/640?wx_fmt=png#imgIndex=1'});
  image.style.opacity='0';
  const article=extract(documentFixture({content:[image]})).article;
  assert.equal(article.contentType,'image');assert.equal(article.images.length,1);
  assert.equal(article.images[0].url,'https://mmbiz.qpic.cn/mmbiz_png/public/640?wx_fmt=png');
  assert.equal(article.bodyBlocks[0].url,article.images[0].url);
  assert.equal(article.images[0].layer,'visible');
  for (const [property,value] of [['opacity','0'],['height','0px']]) {
    const parent=element('section',{},image);parent.style[property]=value;
    const captured=extract(documentFixture({content:[parent]})).article;
    assert.equal(captured.images[0].layer,'interactive');assert.equal(captured.bodyBlocks[0].layer,'interactive');
  }
  const transparent=element('section',{},'不应读取的透明文字',image);transparent.style.opacity='0';
  assert.equal(extract(documentFixture({content:[transparent]})).article.content,'');
  for (const [property,value] of [['display','none'],['visibility','hidden'],['visibility','collapse']]) {
    const parent=element('section',{},image);parent.style[property]=value;
    assert.equal(extract(documentFixture({content:[parent]})).reason,'article_preview_body_empty');
  }
  image.style.display='none';
  assert.equal(extract(documentFixture({content:[image]})).reason,'article_preview_body_empty');
  const classPlaceholder=element('img',{class:'js_img_placeholder',src:'https://mmbiz.qpic.cn/public/640'});
  classPlaceholder.style.opacity='0';
  assert.equal(extract(documentFixture({content:[classPlaceholder]})).article.images.length,1);
  for (const attribute of ['hidden','aria-hidden']) {
    const parent=element('section',{[attribute]:'true'},image);parent.hidden=attribute==='hidden';
    assert.equal(extract(documentFixture({content:[parent]})).reason,'article_preview_body_empty');
  }
});

test('SVG and arbitrary element backgrounds precede their text and deduplicate at first URL position', () => {
  const first='https://mmbiz.qpic.cn/first/640?x=1;y=2';
  const second='https://mmecoa.qpic.cn/second/640?wx_fmt=png';
  const svg=element('svg',{'data-lazy-bgimg':first+'#one','aria-label':'主图'},element('text',{},'SVG文字'),
    element('foreignObject',{},element('p',{},'子正文')));
  const hiddenLayer=element('section',{},element('div',{style:`background-image: url('${second}#layer')`},'透明文字'));
  hiddenLayer.style.opacity='0';
  const result=extract(documentFixture({content:[element('p',{},'开头'),svg,
    element('div',{style:`background-image: url("${first}#again")`}),hiddenLayer,
    element('img',{'data-src':second}),element('p',{},'结尾')]})).article;
  assert.deepEqual(result.images.map(({url,layer})=>({url,layer})),[{url:first,layer:'visible'},{url:second,layer:'interactive'}]);
  assert.deepEqual(result.bodyBlocks.map(block=>block.type),['text','image','text','text','image','text']);
  assert.equal(result.content,'开头\nSVG文字\n子正文\n结尾');
  assert.equal(result.images[0].alt,'主图');
});

test('lazy background attributes win placeholders; data URLs and hard-hidden backgrounds stay excluded', () => {
  const url='https://mmbiz.qpic.cn/background/640?wx_fmt=png';
  const result=extract(documentFixture({content:[
    element('div',{'data-lazy-bgimg':url,style:'background-image:url("data:image/gif;base64,eA==")'}),
    element('section',{'data-lazy-bgimg':'data:image/png;base64,eA==',style:'background-image:url("https://mmbiz.qpic.cn/do-not-fallback")'}),
    element('svg',{style:'background-image:url(data:image/gif;base64,eA==)'}),
  ]})).article;
  assert.deepEqual(result.images.map(image=>image.url),[url]);
  for (const style of [{display:'none'},{visibility:'hidden'}]) {
    const parent=element('div',{},element('svg',{'data-lazy-bgimg':url}));parent.style=style;
    assert.equal(extract(documentFixture({content:[parent]})).reason,'article_preview_body_empty');
  }
});

test('visible author text and region wrapper take precedence over hidden legacy elements', () => {
  const old=element('span',{id:'js_author_name'},'旧作者');old.style.display='none';
  const region=element('em',{id:'js_ip_wording_wrp','aria-label':'上海'},element('span',{id:'js_ip_wording','aria-hidden':'true'},'地区字样'));
  const article=extract(documentFixture({extra:[old,element('span',{id:'js_author_name_text'},'可见作者'),region]})).article;
  assert.equal(article.author,'可见作者');assert.equal(article.location,'上海');
  assert.equal(extract(documentFixture({extra:[element('em',{id:'js_ip_wording_wrp'},'北京')]})).article.location,'北京');
  assert.equal(extract(documentFixture()).article.location,null);
});

test('unread embedded WeChat cards do not leak their child text or images into the article', () => {
  for (const [tag,attributes] of [['section',{class:'channels_iframe_wrp'}],['mp-common',{}],['mpvoice',{}],['mp-miniprogram',{}]]) {
    const article=extract(documentFixture({content:[element('p',{},'已读正文'),element(tag,attributes,'卡片文字',element('img',{src:'https://images.example.test/card.png'}))]})).article;
    assert.equal(article.content,'已读正文');assert.equal(article.images.length,0);
    assert.equal(article.bodyStatus,'partial');assert.equal(article.bodyReason,'embedded_media_unread');
  }
});

function liveFixture(name) {
  const directory=new URL('./fixtures/wechat-articles/dom/',import.meta.url);
  const html=readFileSync(new URL(`${name}.html`,directory),'utf8');
  const snapshot=JSON.parse(readFileSync(new URL(`${name}.tree.json`,directory),'utf8'));
  assert.equal(createHash('sha256').update(html).digest('hex'),snapshot.htmlSha256);
  assert.equal(snapshot.provenance,'user_provided_live_dom_20261109');
  assert.doesNotMatch(html,/<script\b/iu);
  const hydrate=value=>{
    if (typeof value==='string') return value;
    const [tag,attributes,children]=value;
    const node=element(tag,attributes,...children.map(hydrate));
    for (const property of ['display','visibility','opacity','height']) {
      const match=String(attributes.style??'').match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;!]+)`,'iu'));
      if (match) node.style[property]=match[1].trim();
    }
    node.hidden=Object.hasOwn(attributes,'hidden');
    return node;
  };
  return {url:snapshot.url,document:documentFixture({url:snapshot.url,bodyOnly:hydrate(snapshot.tree)})};
}

for (const expected of [
  {id:'FYL3oVvFiTPoeeaxO0ERCQ',title:'2.2亿美元和解之后，你的急刹数据归谁',account:'汽车前瞻资讯',author:'汽车前瞻资讯',publishedAt:'2026-11-08T23:59:00+08:00',characters:4148,images:4,interactive:0,type:'article'},
  {id:'1ZigfwkDqDuKmKi-M0baeA',title:'解锁安吉星小程序4大板块',account:'安吉星',author:'安吉星',publishedAt:'2026-07-13T14:59:00+08:00',characters:0,images:38,interactive:15,type:'image'},
  {id:'kL-i_FzeHUakdh5_x49Sog',title:'安吉星微信小程序上线啦！',account:'安吉星服务',author:'安吉星服务',publishedAt:'2026-07-10T14:57:00+08:00',characters:0,images:42,interactive:19,type:'image'},
]) test(`provided live DOM replay: ${expected.id}`,()=>{
  const {url,document}=liveFixture(expected.id);
  const result=extract(document,{expectedUrl:url});
  assert.equal(result.ok,true);
  const article=result.article;
  for (const key of ['title','account','author','publishedAt']) assert.equal(article[key],expected[key],key);
  assert.equal(article.location,'上海');assert.equal(article.timePrecision,'minute');
  assert.equal(article.content.length,expected.characters);assert.equal(article.images.length,expected.images);
  assert.equal(article.contentType,expected.type);
  assert.equal(article.images.filter(image=>image.layer==='interactive').length,expected.interactive);
  assert.equal(article.images.filter(image=>image.layer==='visible').length,expected.images-expected.interactive);
  assert.equal(new Set(article.images.map(image=>image.url)).size,expected.images);
  assert.ok(article.images.every(image=>new URL(image.url).hostname.endsWith('.qpic.cn')));
  if (expected.type==='image') {
    const first=document.querySelectorAll('svg').find(node=>node.getAttribute('data-lazy-bgimg'));
    assert.equal(article.images[0].url,first.getAttribute('data-lazy-bgimg').split('#')[0]);
  }
  assert.equal(article.evidence.selectorAcceptance,'live_dom_20261109');
  assert.ok(article.images.every(image=>!new URL(image.url).hash&&image.stored===false));
  assert.ok(Object.values(article.metrics).every(metric=>metric.value===null));
  assert.deepEqual(article.bodyBlocks.filter(block=>block.type==='image').map(block=>block.url),article.images.map(image=>image.url));
  assert.deepEqual(article.bodyBlocks.filter(block=>block.type==='image').map(block=>block.layer),article.images.map(image=>image.layer));
  assert.equal(article.bodyStatus,'complete');assert.equal(article.bodyReason,'');
});

test('kL-i retains all seven IMG nodes under zero-height parents, including four opacity-hidden layers',()=>{
  const {document}=liveFixture('kL-i_FzeHUakdh5_x49Sog');
  const content=document.querySelectorAll('#js_content')[0];
  const images=document.querySelectorAll('img').filter(image=>content.contains(image));
  const ancestorHidden=images.filter(image=>{
    for (let node=image.parentElement;node&&node!==content;node=node.parentElement) if (node.style.opacity==='0') return true;
    return false;
  });
  assert.equal(images.length,7);assert.equal(ancestorHidden.length,4);
  const url=document.URL;
  const article=extract(document,{expectedUrl:url}).article;
  for (const image of images) {
    const source=new URL(image.getAttribute('data-src'));source.hash='';
    assert.equal(article.images.find(item=>item.url===source.href)?.layer,'interactive');
  }
});

test('fourth supplied sample is a JSON-only observation, not a fabricated live DOM fixture',()=>{
  const sample=JSON.parse(readFileSync(new URL('./fixtures/wechat-articles/dom/bMWKCZnPrhVlz2uCqmRzKw.extracted.json',import.meta.url),'utf8'));
  assert.equal(sample.title,'5年后安吉星要不要续费');assert.equal(sample.account,'白白过一天');
  assert.equal(sample.content.length,740);assert.equal(sample.images.length,0);
  // Exercise its observed English label in the synthetic fixture without claiming original HTML exists.
  const parsed=extract(documentFixture({date:sample.timeLabel})).article;
  assert.equal(parsed.publishedAt,'2026-08-24T14:39:00+08:00');
});

test('only visible labelled footer counts are metrics; unknown stays null and true zero stays zero', () => {
  const hidden=element('span',{},'推荐 99'); hidden.style.visibility='hidden';
  const footer=element('div',{id:'js_article_bottom_bar'},element('span',{},'阅读 10万+'),element('span',{},'点赞 0'),hidden,element('span',{},'11'));
  const {metrics}=extract(documentFixture({content:[element('p',{},'分享 999')],extra:[footer]})).article;
  assert.equal(metrics.read.value,100000);assert.equal(metrics.read.raw,'10万+');assert.equal(metrics.read.precision,'lower_bound');
  assert.equal(metrics.like.value,0);assert.equal(metrics.share.value,null);assert.equal(metrics.recommend.value,null);
  assert.equal(metrics.like.source,'page_dom');assert.equal(metrics.like.capturedAt,AT);
});

function cdpFixture(t, {holdNavigation=false, delayCreationMs=0, result, maxTabs=1, timeoutMs=1500} = {}) {
  const calls=[], targets=new Map(), sessions=new Map(), sockets=[];
  let spawns=0, nextTarget=0;
  const emit = (socket, value) => socket.emit('message', {data:JSON.stringify(value)});
  class FakeSocket extends EventEmitter {
    constructor() { super(); sockets.push(this); queueMicrotask(()=>this.emit('open')); }
    addEventListener(name, fn, options) { options?.once ? this.once(name,fn) : this.on(name,fn); }
    close() { this.closed=true; this.emit('close'); }
    send(raw) {
      const request=JSON.parse(raw); calls.push(request);
      const respond = ()=> {
        if (this.closed) return;
        const {id,method,params,sessionId}=request;
        let answer={};
        if (method==='Target.createTarget') { const targetId=`target-${++nextTarget}`; targets.set(targetId,{}); answer={targetId}; }
        if (method==='Target.attachToTarget') { const name=`session-${params.targetId}`; sessions.set(name,params.targetId); answer={sessionId:name}; }
        if (method==='Target.closeTarget') { targets.delete(params.targetId); answer={success:true}; }
        if (method==='Page.navigate') targets.get(sessions.get(sessionId)).url=params.url;
        if (method==='Runtime.evaluate') {
          const url=targets.get(sessions.get(sessionId)).url;
          answer={result:{value:typeof result==='function' ? result() : result ?? extract(documentFixture({url}),{expectedUrl:url})}};
        }
        if (method==='Network.getResponseBody') answer={body:JSON.stringify({errCode:0,data:{feedInfo:{description:'视频号原路径',createtime:1794000000},authorInfo:{nickname:'账号'}}})};
        emit(this,{id,result:answer});
        if (method==='Page.navigate' && !holdNavigation) {
          if (params.url.includes('/sph/')) {
            emit(this,{sessionId,method:'Network.responseReceived',params:{requestId:'feed',response:{url:'https://channels.weixin.qq.com/finder-preview/api/feed/get_feed_info'}}});
            emit(this,{sessionId,method:'Network.loadingFinished',params:{requestId:'feed'}});
          } else emit(this,{sessionId,method:'Page.loadEventFired',params:{}});
        }
      };
      if (request.method==='Target.createTarget' && delayCreationMs) setTimeout(respond,delayCreationMs);
      else queueMicrotask(respond);
    }
  }
  const directory=mkdtempSync(join(tmpdir(),'article-preview-test-'));
  const preview=createSharePreview({profileDir:directory,chromePath:process.execPath,maxTabs,timeoutMs,
    spawnImpl:()=>{spawns++;const process=new EventEmitter();process.kill=()=>process.emit('exit');return process;},
    fetchImpl:async url=>{assert.match(url,/^http:\/\/127\.0\.0\.1:9333\/json\/version$/u);return {json:async()=>({webSocketDebuggerUrl:'ws://127.0.0.1:9333/fake'})};},
    WebSocketImpl:FakeSocket});
  t.after(()=>{preview.close();rmSync(directory,{recursive:true,force:true});});
  return {preview,calls,targets,sockets,spawns:()=>spawns};
}

test('articles and Channels reuse one browser/queue; article tab has desktop layout and no mobile UA', async t => {
  const fixture=cdpFixture(t);
  const [article,channel]=await Promise.all([fixture.preview.resolveArticle(URL_A+'?tracking=1'),fixture.preview.resolve('https://weixin.qq.com/sph/Fixture123')]);
  assert.equal(article.url,URL_A);assert.equal(channel.description,'视频号原路径');assert.equal(fixture.spawns(),1);
  const mobile=fixture.calls.filter(call=>call.method==='Emulation.setUserAgentOverride');
  assert.equal(mobile.length,1);assert.match(mobile[0].sessionId,/target-2$/u);
  const desktop=fixture.calls.find(call=>call.method==='Emulation.setDeviceMetricsOverride');
  assert.equal(desktop.params.mobile,false);assert.equal(desktop.params.width,1280);
  for (const [method,params] of [['Emulation.setLocaleOverride',{locale:'zh-CN'}],
    ['Emulation.setTimezoneOverride',{timezoneId:'Asia/Shanghai'}]]) {
    const overrides=fixture.calls.filter(call=>call.method===method);
    assert.equal(overrides.length,1);assert.equal(overrides[0].sessionId,desktop.sessionId);
    assert.deepEqual(overrides[0].params,params);
    const navigation=fixture.calls.find(call=>call.method==='Page.navigate'&&call.sessionId===desktop.sessionId);
    assert.ok(fixture.calls.indexOf(overrides[0])<fixture.calls.indexOf(navigation));
    assert.notEqual(overrides[0].sessionId,mobile[0].sessionId);
  }
  assert.equal(fixture.targets.size,0);
});

test('invalid article URL fails before any browser is started',async t=>{
  const fixture=cdpFixture(t);
  await assert.rejects(fixture.preview.resolveArticle('https://evil.test/s/ArticleFixture123'),{code:'article_link_invalid'});
  assert.equal(fixture.spawns(),0);
});

test('verification failure is explicit and closes its tab without a retry navigation',async t=>{
  const fixture=cdpFixture(t,{result:{ok:false,reason:'article_preview_verification_required',retryable:false}});
  await assert.rejects(fixture.preview.resolveArticle(URL_A),{code:'article_preview_verification_required'});
  assert.equal(fixture.calls.filter(call=>call.method==='Page.navigate').length,1);assert.equal(fixture.targets.size,0);
});

test('timeout closes a loading article tab',async t=>{
  const fixture=cdpFixture(t,{holdNavigation:true,timeoutMs:25});
  await assert.rejects(fixture.preview.resolveArticle(URL_A),{code:'preview_timeout'});
  assert.equal(fixture.targets.size,0);
});

test('eight repeated completed-page failures stop with the observed reason and close the tab',async t=>{
  const fixture=cdpFixture(t,{timeoutMs:4000,result:{ok:false,reason:'article_preview_body_empty',retryable:true,readyState:'complete'}});
  await assert.rejects(fixture.preview.resolveArticle(URL_A),{code:'article_preview_body_empty'});
  assert.equal(fixture.calls.filter(call=>call.method==='Runtime.evaluate').length,8);assert.equal(fixture.targets.size,0);
});

test('the repeated-failure threshold does not apply while the document is still loading',async t=>{
  let attempts=0;
  const fixture=cdpFixture(t,{timeoutMs:4000,result:()=>++attempts<=8
    ? {ok:false,reason:'article_preview_body_empty',retryable:true,readyState:'loading'} : extract(documentFixture())});
  assert.equal((await fixture.preview.resolveArticle(URL_A)).title,'测试文章');
  assert.equal(attempts,10);
});

test('a different retryable reason resets the completed-page failure streak',async t=>{
  let attempts=0;
  const fixture=cdpFixture(t,{timeoutMs:5000,result:()=>++attempts<=9
    ? {ok:false,reason:attempts<=4?'article_preview_body_empty':'article_preview_header_incomplete',retryable:true,readyState:'complete'} : extract(documentFixture())});
  assert.equal((await fixture.preview.resolveArticle(URL_A)).title,'测试文章');
  assert.equal(attempts,11);
});

test('queued abort never opens its URL, active abort closes its own tab',async t=>{
  const fixture=cdpFixture(t,{holdNavigation:true});
  const active=new AbortController(), queued=new AbortController();
  const first=fixture.preview.resolveArticle(URL_A,{signal:active.signal});
  const second=fixture.preview.resolveArticle(URL_B,{signal:queued.signal});
  queued.abort();await assert.rejects(second,{code:'aborted'});
  await new Promise(resolve=>setImmediate(resolve));active.abort();await assert.rejects(first,{code:'aborted'});
  assert.equal(fixture.calls.filter(call=>call.method==='Page.navigate').length,1);assert.equal(fixture.targets.size,0);
});

test('closing shared preview rejects pending work instead of leaving promises unresolved',async t=>{
  const fixture=cdpFixture(t,{holdNavigation:true});
  const first=fixture.preview.resolveArticle(URL_A),second=fixture.preview.resolveArticle(URL_B);
  const settled=Promise.allSettled([first,second]);
  await new Promise(resolve=>setImmediate(resolve));fixture.preview.close();
  const results=await settled;assert.ok(results.every(item=>item.status==='rejected'));
});

test('cancel before createTarget replies closes the late-created tab',async t=>{
  const fixture=cdpFixture(t,{delayCreationMs:30});
  const controller=new AbortController();
  const request=fixture.preview.resolveArticle(URL_A,{signal:controller.signal});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(fixture.calls.filter(call=>call.method==='Target.createTarget').length,1);
  controller.abort(); await assert.rejects(request,{code:'aborted'});
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(fixture.calls.filter(call=>call.method==='Target.closeTarget').length,1);
  assert.equal(fixture.targets.size,0);
  assert.equal(fixture.calls.filter(call=>call.method==='Page.navigate').length,0);
});
