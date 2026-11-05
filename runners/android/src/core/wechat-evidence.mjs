import {createHash} from 'node:crypto';
import {eventIdFor} from './discovery-evidence.mjs';

// One captured Channels post as a durable upload event. The server derives the work identity again from the
// preview page fields; the local work key only keeps one event per post per keyword attempt.
export const WECHAT_EVENT_KIND = 'wechat_post';
const bounded = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';

export function wechatWorkKey(info) {
  return `wx:${createHash('sha256').update(`${info.createtime}|${info.nickname}`).digest('hex').slice(0, 24)}`;
}

export function wechatPostEvent({task, card, rank, shareUrl, info, comments, capturedAt}) {
  const workKey = wechatWorkKey(info);
  return {
    eventKind: WECHAT_EVENT_KIND,
    eventId: eventIdFor(task, {detailId: workKey}, workKey),
    ...task.identity,
    keyword: task.keyword,
    mode: task.mode === 'patrol' ? 'patrol' : 'keyword',
    rank: Number.isSafeInteger(rank) ? rank : null,
    capturedAt: new Date(capturedAt).toISOString(),
    card: {snippet: bounded(card?.snippet, 400), author: bounded(card?.author, 120), timeLabel: bounded(card?.timeLabel, 40),
      likeLabel: bounded(card?.likeLabel, 20)},
    link: {shareUrl},
    preview: {description: bounded(info.description, 20_000), createtime: info.createtime, nickname: bounded(info.nickname, 200),
      avatarUrl: bounded(info.avatarUrl, 1000), likeCountFmt: bounded(info.likeCountFmt, 20), favCountFmt: bounded(info.favCountFmt, 20),
      forwardCountFmt: bounded(info.forwardCountFmt, 20), commentCountFmt: bounded(info.commentCountFmt, 20),
      coverUrl: bounded(info.coverUrl, 2000), isImage: info.isImage === true, exportId: bounded(info.exportId, 200)},
    comments: {
      status: comments?.status ?? 'disabled',
      headerCount: Number.isSafeInteger(comments?.headerCount) ? comments.headerCount : null,
      items: (comments?.items ?? []).slice(0, 500).map(item => ({author: bounded(item.author, 120), location: bounded(item.location, 20),
        timeLabel: bounded(item.timeLabel, 40), content: bounded(item.content, 2000),
        likeCount: Number.isSafeInteger(item.likeCount) ? item.likeCount : null, reply: item.reply === true,
        parentIndex: Number.isSafeInteger(item.parentIndex) ? item.parentIndex : null})),
    },
  };
}
