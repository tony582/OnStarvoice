import test from 'node:test';
import assert from 'node:assert/strict';
import {detailMatchesCard, readDetail, resource} from '../src/device/douyin-profile.mjs';
import {parseUiTree} from '../src/device/ui-tree.mjs';

test('a native note with heading and body in one text node matches only the first heading separator', () => {
  const card = {author: '车主🏜️', title: '请问这个胎压要补气吗。管家说正常，但又建议2.9#胎压'};
  for (const newline of ['\n', '\r\n']) {
    const detail = {kind: 'note', author: card.author, title: `请问这个胎压要补气吗${newline}管家说正常，但又建议2.9#胎压`};
    assert.equal(detailMatchesCard(detail, card), true);
    assert.equal(detailMatchesCard({...detail, author: '另一个作者'}, card), false);
    assert.equal(detailMatchesCard({...detail, title: detail.title.replace('2.9', '2.8')}, card), false);
    assert.equal(detailMatchesCard({...detail, kind: 'video'}, card), false);
  }
  const detail = {kind: 'note', author: card.author, title: '标题\n正文\n第二段'};
  assert.equal(detailMatchesCard(detail, {author: card.author, title: '标题。正文第二段'}), true);
  assert.equal(detailMatchesCard(detail, {author: card.author, title: '标题正文。第二段'}), false);
  assert.equal(detailMatchesCard({...detail, title: '标题 正文'}, {author: card.author, title: '标题。正文'}), false);
  assert.equal(detailMatchesCard({...detail, title: '标题，\n正文'}, {author: card.author, title: '标题。正文'}), false);
  assert.equal(detailMatchesCard({...detail, title: '\n正文'}, {author: card.author, title: '。正文'}), false);
  assert.equal(detailMatchesCard({...detail, title: '标题\n '}, {author: card.author, title: '标题。'}), false);
});

test('the real single-node note layout retains its line boundary through UI parsing and both identity checks', () => {
  const node = (id, text = '') => `<node package="com.ss.android.ugc.aweme" displayed="true" bounds="[0,0][300,300]" resource-id="${resource(id)}" text="${text}"/>`;
  const tree = parseUiTree(`<hierarchy>${node('tv_desc', '哨兵模式&#10;需要64g以上的U盘#车机')}
    ${node('w67', '车主🚗')}${node('n00')}</hierarchy>`);
  const detail = readDetail(tree);
  assert.equal(detail.title, '哨兵模式\n需要64g以上的U盘#车机');
  assert.equal(detail.heading, undefined);
  const card = {author: '车主🚗', title: '哨兵模式。需要64g以上的U盘#车机'};
  assert.equal(detailMatchesCard(detail, card), true, 'the opened note');
  assert.equal(detailMatchesCard(readDetail(tree), card), true, 'the same note re-read before copying');
  assert.equal(detailMatchesCard(detail, {...card, title: '哨兵模式。需要64g以下的U盘#车机'}), false);
});
