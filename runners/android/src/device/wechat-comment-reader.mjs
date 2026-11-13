import {DeviceError} from './bounded.mjs';
import {pause} from './ui-wait.mjs';
import {SWIPE} from './wechat-profile.mjs';
import {COMMENT_INPUT_TOP, comparable, findText} from './wechat-ocr-parse.mjs';
import {PANEL_TOP, mergeCommentScreens, parseCommentScreen} from './wechat-comments-parse.mjs';

const STALL_SCREENS = 2;
const MAX_TOP_SWIPES = 10;
const topLevel = screen => ({comments: screen.comments.filter(item => !item.reply)});
const anchors = screen => new Set(screen.anchors.filter(item => item.timeLabel && comparable(item.author))
  .map(item => JSON.stringify([comparable(item.author), item.timeLabel])));
const overlaps = (before, after) => {
  const previous = anchors(before);
  return [...anchors(after)].some(key => previous.has(key));
};

function unchangedViewport(before, after) {
  const contents = rows => rows.filter(row => row.y >= PANEL_TOP + 60 && row.y + row.h <= COMMENT_INPUT_TOP
    && row.x >= 120 && row.x < 860).sort((a, b) => a.y - b.y || a.x - b.x);
  const left = contents(before), right = contents(after);
  return left.length > 0 && left.length === right.length && left.every((row, i) =>
    Math.abs(row.y - right[i].y) <= 12 && comparable(row.text) === comparable(right[i].text));
}

// Wait for the current viewport's OCR before advancing. A reverse must start from the screen it repairs.
export async function readCommentPanel({screen, view, limit = 50, signal, maxScreens = null, wait = pause, canScroll = () => true}) {
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
  const headerCount = first.headerCount;
  const scroll = async gesture => {
    await screen.swipeAndHold(...gesture, {signal});
    await wait(350, signal);
    rows = await view.look({signal});
    return parseCommentScreen(rows);
  };
  // WeChat can restore the last scroll position on reopening the panel.
  let unchanged = 0;
  for (let i = 0; !first.post && i < MAX_TOP_SWIPES && unchanged < STALL_SCREENS && canScroll(); i++) {
    const before = rows;
    first = await scroll(SWIPE.commentsTowardTop);
    unchanged = unchangedViewport(before, rows) ? unchanged + 1 : 0;
  }

  const screens = [topLevel(first)];
  let previous = first, scrollReason;
  let stalled = 0, known = mergeCommentScreens(screens).length;
  const cap = maxScreens ?? Math.min(30, Math.ceil(limit / 3) + 3);
  for (let index = 1; index <= cap && known < limit && stalled < STALL_SCREENS; index++) {
    if (!canScroll()) { scrollReason = 'comment_time_limit'; break; }
    let next = await scroll(SWIPE.comments);
    if (!overlaps(previous, next)) {
      if (canScroll()) next = await scroll(SWIPE.commentsBack);
      if (!overlaps(previous, next)) scrollReason = 'scroll_gap';
    }
    screens.push(topLevel(next));
    if (scrollReason) break;
    const count = mergeCommentScreens(screens).length;
    stalled = count > known ? 0 : stalled + 1;
    known = count;
    previous = next;
  }
  const items = mergeCommentScreens(screens, {limit});
  const reason = first.post ? scrollReason : 'top_unverified';
  return {status: !reason && stalled >= STALL_SCREENS ? 'captured' : 'partial', ...(reason ? {reason} : {}),
    headerCount: first.headerCount ?? headerCount, post: first.post, items};
}
