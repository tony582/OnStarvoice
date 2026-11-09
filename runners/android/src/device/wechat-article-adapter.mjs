import {createWechatDeviceAdapter} from './wechat-adapter.mjs';
import {createWechatArticleFlow} from './wechat-article-flow.mjs';

// Articles share device checks, keyboard restoration, pending-operation tracking and closure with Channels.
export function createWechatArticleAdapter(options) {
  return createWechatDeviceAdapter(options, {
    flowFactory: createWechatArticleFlow,
    flowMethods: ['search', 'readCards', 'openCard', 'openArticleLink', 'copyLink', 'readArticle', 'returnToResults', 'recoverResults', 'scroll'],
    platform: 'wechat_articles',
    profileId: 'wechat-articles-8.0.80-de106-api27-p0',
  });
}
