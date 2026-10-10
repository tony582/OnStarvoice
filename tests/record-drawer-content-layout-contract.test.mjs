import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const drawer = readFileSync(new URL('../web/admin/src/components/shared/RecordDrawer.tsx', import.meta.url), 'utf8');

test('the content tab shows the post itself first and the AI output below it', () => {
  const start = drawer.indexOf('function RecordContentTab(');
  const end = drawer.indexOf('function ContentGroupHeader(');
  assert.ok(start > 0 && end > start, 'RecordContentTab exists');
  const tab = drawer.slice(start, end);
  const at = marker => {
    const index = tab.indexOf(marker);
    assert.ok(index >= 0, `missing ${marker}`);
    return index;
  };

  // 原帖：视频 / 图片、正文、逐字稿原文
  const original = at('title="原帖内容"');
  const ai = at('title="AI 分析"');
  assert.ok(original < ai);
  for (const marker of ['<RecordVideoPlayer', '{!video && gallery}', '>正文</h4>', '<TranscriptTextSection', '{video && gallery}']) {
    const index = at(marker);
    assert.ok(original < index && index < ai, `${marker} belongs to 原帖内容`);
  }
  // AI：摘要、深度剖析、视频内容分析、判断依据
  for (const marker of ['>摘要</h4>', '>深度剖析</h4>', '<RecordAnalysisPanel', '<TranscriptAnalysisSection', '<PostJudgmentDetails record={r} />']) {
    assert.ok(at(marker) > ai, `${marker} belongs to AI 分析`);
  }

  // 逐字稿原文和它的 AI 分析共用一份状态，只拉取一次
  assert.match(tab, /const transcript = useRecordTranscript\(r, video\)/);
  assert.equal((drawer.match(/useRecordTranscript\(/g) || []).length, 2, 'one definition and one call');
  assert.match(drawer, /\{tab === 'content' && \(\s*<RecordContentTab/);
});
