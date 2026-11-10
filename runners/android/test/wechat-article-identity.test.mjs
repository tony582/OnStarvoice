import assert from 'node:assert/strict';
import test from 'node:test';
import {comparable, similarity} from '../src/shared/wechat-text-match.mjs';
import {canonicalArticleUrl, cardMatchesHeader, sameArticleTitle} from '../src/shared/wechat-article-identity.mjs';
import {canonicalArticleUrl as evidenceUrl} from '../src/core/wechat-article-evidence.mjs';
import {comparable as deviceComparable, similarity as deviceSimilarity} from '../src/device/wechat-ocr-parse.mjs';
import {cardMatchesHeader as deviceMatch, sameArticleTitle as deviceTitle} from '../src/device/wechat-article-parse.mjs';

test('core and legacy device entry points share the identical pure comparison and canonical URL functions', () => {
  assert.equal(deviceComparable, comparable); assert.equal(deviceSimilarity, similarity);
  assert.equal(deviceMatch, cardMatchesHeader); assert.equal(deviceTitle, sameArticleTitle);
  assert.equal(evidenceUrl, canonicalArticleUrl);
});

test('shared matching retains normalization, short-name boundaries and complete byline tokens', () => {
  assert.equal(comparable(' 別克 ＡＢＣ… '), '别克abc');
  assert.equal(similarity('同名', '同名'), 1); assert.equal(similarity('同名', '同明'), 0);
  const card = {title: '务，统统一键解决！', author: '连确'};
  const header = {title: '手机应用再次升级，修车保养、续费服务，统统一键解决！', account: '冷水泡壶茶 连确'};
  assert.equal(cardMatchesHeader(card, header), true);
  for (const account of ['连确汽车', '连确服务', '另一个账号']) assert.equal(cardMatchesHeader(card, {...header, account}), false);
  assert.equal(cardMatchesHeader({...card, title: '统统一键解'}, header), false);
  assert.equal(cardMatchesHeader({...card, title: '统一键解！！！'}, header), false);
});

test('one shared article URL policy ignores tracking but rejects other hosts, schemes and path forms', () => {
  const url = 'https://mp.weixin.qq.com/s/SharedArticle123';
  assert.equal(canonicalArticleUrl(`${url}/?scene=1#copy`), url);
  for (const invalid of ['http://mp.weixin.qq.com/s/SharedArticle123', 'https://user@mp.weixin.qq.com/s/SharedArticle123',
    'https://mp.weixin.qq.com:8443/s/SharedArticle123', 'https://mp.weixin.qq.com.evil.test/s/SharedArticle123',
    'https://mp.weixin.qq.com/s?__biz=unknown', 'https://mp.weixin.qq.com/s/short']) assert.equal(canonicalArticleUrl(invalid), '');
});
