import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);

async function source(path) {
  return readFile(new URL(path, ROOT), 'utf8');
}

test('desktop and mobile duty cards separate completed recovery from blocked recovery', async () => {
  const [overview, mobile] = await Promise.all([
    source('web/admin/src/pages/OverviewPage.tsx'),
    source('web/admin/src/mobile/MobileApp.tsx'),
  ]);

  for (const ui of [overview, mobile]) {
    assert.match(ui, /sourceClosureBlockedCount/u);
    assert.match(ui, /恢复已完成/u);
    assert.match(ui, /恢复阻塞/u);
    assert.match(ui, /capture_source_closure_blocked/u);
    assert.match(ui, /incident_type \|\| firstIncident\?\.type/u);
    assert.match(ui, /验收成功/u);
    assert.doesNotMatch(ui, /已交付自愈基线/u);
    assert.doesNotMatch(ui, /label="已自动恢复"/u);
  }
});
