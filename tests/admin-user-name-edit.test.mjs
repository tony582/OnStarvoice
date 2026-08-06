import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function between(text, start, end) {
  const startAt = text.indexOf(start);
  const endAt = text.indexOf(end, startAt + start.length);
  assert.ok(startAt >= 0 && endAt > startAt, `missing section: ${start}`);
  return text.slice(startAt, endAt);
}

test('account management edits a user name inline on desktop and mobile', () => {
  const page = source('web/admin/src/pages/AdminPages.tsx');
  const users = between(page, 'export function UsersPage', '/* ==================== AuthCodesPage');

  assert.match(users, /const \[editingNameId, setEditingNameId\]/);
  assert.match(users, /const \[editingNameSurface, setEditingNameSurface\]/);
  assert.match(users, /const nextName = editingName\.trim\(\)/);
  assert.match(users, /用户名称不能为空/);
  assert.match(users, /用户名称不能超过 100 个字符/);
  assert.match(users, /api\.patch\('\/admin\/users\/' \+ user\.id, \{ name: nextName \}, \{ skipTenant: true \}\)/);
  assert.match(users, /setUsers\(current => current\.map\(item => item\.id === user\.id \? \{ \.\.\.item, name: nextName \} : item\)\)/);

  assert.match(users, /beginNameEdit\(u, 'mobile'\)/);
  assert.match(users, /beginNameEdit\(u, 'desktop'\)/);
  assert.match(users, /<Pencil[^>]*\/>编辑名称/);
  assert.match(users, /maxLength=\{100\}/);
  assert.match(users, /e\.key === 'Escape'/);
  assert.match(users, /保存名称/);
  assert.match(users, /用户名称已更新/);
});

test('admin user name updates are trimmed, bounded, audited, and return the saved name', () => {
  const route = source('server/routes/admin.js');
  const patchRoute = between(
    route,
    "router.patch('/users/:id'",
    "router.post('/users/:id/reset-password'",
  );

  assert.match(patchRoute, /if \(typeof name !== 'string'\)/);
  assert.match(patchRoute, /normalizedName = name\.trim\(\)/);
  assert.match(patchRoute, /if \(!normalizedName\)/);
  assert.match(patchRoute, /normalizedName\.length > 100/);
  assert.match(patchRoute, /SELECT id, name FROM users WHERE id = \$1 FOR UPDATE/);
  assert.match(patchRoute, /if \(!targetUser\) return null/);
  assert.match(patchRoute, /add\('name', normalizedName\)/);
  assert.match(patchRoute, /'user\.updated'/);
  assert.match(patchRoute, /error: 'user_not_found'/);
  assert.match(patchRoute, /return res\.json\(\{ ok: true, user: result \}\)/);
});
