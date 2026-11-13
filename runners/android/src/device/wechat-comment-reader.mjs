import {DeviceError} from './bounded.mjs';
import {pause} from './ui-wait.mjs';
import {SWIPE} from './wechat-profile.mjs';
import {comparable, findText} from './wechat-ocr-parse.mjs';
import {mergeCommentScreens, parseCommentScreen} from './wechat-comments-parse.mjs';

const STALL_SCREENS = 2;
const topLevel = screen => ({comments: screen.comments.filter(item => !item.reply)});
const anchors = screen => new Set(screen.anchors.filter(item => item.timeLabel && comparable(item.author))
  .map(item => JSON.stringify([comparable(item.author), item.timeLabel])));
const overlaps = (before, after) => {
  const previous = anchors(before);
  return [...anchors(after)].some(key => previous.has(key));
};

// Wait for the current viewport's OCR before advancing. A reverse must start from the screen it repairs.
export async function readCommentPanel({screen, view, limit = 50, signal, maxScreens = null, wait = pause}) {
  let rows = await view.look({signal});
  let first = parseCommentScreen(rows);
  const titled = () => first.headerCount !== null || findText(rows, '评论', {region: {y0: 600, y1: 720, x1: 400}}).length > 0;
  // The 「评论 N」 title was missed on a first reading while the comments were already there (2026-11-06): look again.
  for (let again = 0; again < 2 && !titled(); again++) {
    await wait(700, signal);
    rows = await view.look({signal});
    first = parseCommentScreen(rows);
  }
  if (!titled()) {
    throw new DeviceError('comments_unverified', 'The comment panel was not confirmed', {deviceSettled: true});
  }
  const empty = findText(rows, '暂无评论', {exact: false}).length > 0;
  if (empty || limit <= 0) return {status: empty ? 'empty' : 'disabled', headerCount: empty ? 0 : first.headerCount, post: first.post, items: []};
  const screens = [topLevel(first)];
  let previous = first, reason;
  let stalled = 0, known = mergeCommentScreens(screens).length;
  const scroll = async gesture => {
    await screen.swipeAndHold(...gesture, {signal});
    await wait(350, signal);
    return parseCommentScreen(await view.look({signal}));
  };
  const cap = maxScreens ?? Math.min(30, Math.ceil(limit / 3) + 3);
  for (let index = 1; index <= cap && known < limit && stalled < STALL_SCREENS; index++) {
    let next = await scroll(SWIPE.comments);
    if (!overlaps(previous, next)) {
      next = await scroll(SWIPE.commentsBack);
      if (!overlaps(previous, next)) reason = 'scroll_gap';
    }
    screens.push(topLevel(next));
    if (reason) break;
    const count = mergeCommentScreens(screens).length;
    stalled = count > known ? 0 : stalled + 1;
    known = count;
    previous = next;
  }
  const items = mergeCommentScreens(screens, {limit});
  return {status: !reason && stalled >= STALL_SCREENS ? 'captured' : 'partial', ...(reason ? {reason} : {}),
    headerCount: first.headerCount, post: first.post, items};
}
