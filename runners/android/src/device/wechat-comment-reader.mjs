import {DeviceError} from './bounded.mjs';
import {pause} from './ui-wait.mjs';
import {SWIPE} from './wechat-profile.mjs';
import {findText} from './wechat-ocr-parse.mjs';
import {mergeCommentScreens, parseCommentScreen} from './wechat-comments-parse.mjs';

// Reads an open comment panel. The first screen is read synchronously (it confirms the panel and shows where
// the first "N条回复" controls are); after that the panel is scrolled and photographed without waiting: text
// recognition runs in parallel and at most MAX_AHEAD screens may be unread while the phone keeps scrolling.
export const MAX_AHEAD = 2;
const STALL_SCREENS = 2;

export async function readCommentPanel({screen, view, limit = 50, expandLimit = 3, signal, maxScreens = null}) {
  let rows = await view.look({signal});
  let first = parseCommentScreen(rows);
  if (first.headerCount === null && !findText(rows, '评论', {region: {y0: 600, y1: 720, x1: 400}}).length) {
    throw new DeviceError('comments_unverified', 'The comment panel was not confirmed', {deviceSettled: true});
  }
  const empty = findText(rows, '暂无评论', {exact: false}).length > 0;
  if (empty || limit <= 0) return {status: empty ? 'empty' : 'disabled', headerCount: empty ? 0 : first.headerCount, post: first.post, items: []};
  // Expand replies from the lowest control upwards: opening one only moves the rows below it.
  const expandable = first.expand.filter(item => item.tap.y < 2050).slice(0, expandLimit).sort((a, b) => b.tap.y - a.tap.y);
  for (const control of expandable) {
    await screen.tap(control.tap.x, control.tap.y, {signal});
    await pause(1100, signal);
  }
  if (expandable.length) { rows = await view.look({signal}); first = parseCommentScreen(rows); }
  const screens = [first];
  const inFlight = [];
  let stalled = 0, known = mergeCommentScreens(screens).length;
  const settle = async () => {
    const {text, index} = inFlight.shift();
    const parsed = parseCommentScreen((await text).rows);
    screens[index] = parsed;
    const count = mergeCommentScreens(screens.filter(Boolean)).length;
    stalled = count > known ? 0 : stalled + 1;
    known = count;
  };
  const cap = maxScreens ?? Math.min(30, Math.ceil(limit / 3) + 3);
  for (let index = 1; index <= cap && known < limit && stalled < STALL_SCREENS; index++) {
    await screen.swipe(...SWIPE.comments, {signal});
    await pause(650, signal);
    const shot = await view.capture({signal});
    screens.push(null);
    inFlight.push({text: shot.text, index});
    if (inFlight.length >= MAX_AHEAD) await settle();
  }
  while (inFlight.length) await settle();
  const items = mergeCommentScreens(screens.filter(Boolean), {limit});
  const complete = stalled >= STALL_SCREENS;
  return {status: complete ? 'captured' : 'partial', headerCount: first.headerCount, post: first.post, items};
}
