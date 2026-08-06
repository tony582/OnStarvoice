import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const load = relativePath => readFile(
  new URL(`../${relativePath}`, import.meta.url),
  'utf8',
)

const [desktopApp, sidebar, themeToggle, mobileApp] = await Promise.all([
  load('web/admin/src/desktop/DesktopApp.tsx'),
  load('web/admin/src/components/layout/Sidebar.tsx'),
  load('web/admin/src/components/layout/ThemeToggle.tsx'),
  load('web/admin/src/mobile/MobileApp.tsx'),
])

test('desktop shell gives the workspace full height while preserving navigation recovery', () => {
  assert.match(desktopApp, /<div className="lg:hidden">\s*<TopBar/u)
  assert.match(desktopApp, /onOpenMobileNavigation=\{\(\) => setMobileNavigationOpen\(true\)\}/u)
  assert.match(desktopApp, /aria-label="展开导航"/u)
  assert.match(sidebar, /lg:w-\[208px\]/u)
  assert.match(desktopApp, /lg:ml-\[208px\]/u)
  assert.match(desktopApp, /page === 'official-comments'[\s\S]*xl:h-dvh/u)
  assert.match(desktopApp, /page === 'dispatch'[\s\S]*xl:h-dvh/u)
  assert.doesNotMatch(desktopApp, /calc\(100dvh-3\.5rem\)|lg:ml-\[240px\]/u)
})

test('bottom-left account menu owns workspace and personal controls for every user', () => {
  const accountStart = sidebar.indexOf('左下账号入口')
  assert.notEqual(accountStart, -1)
  const accountMenu = sidebar.slice(accountStart)
  const workspaceSwitch = accountMenu.indexOf('switchWorkspace(alternateWorkspace.key)')
  const internalAdmin = accountMenu.indexOf('{isInternal() && (')

  assert.match(accountMenu, /role="menu" aria-label="账号与设置"/u)
  assert.match(accountMenu, /user\?\.name \|\| user\?\.email/u)
  assert.match(accountMenu, /tenants\.length > 1[\s\S]*switchTenant/u)
  assert.ok(workspaceSwitch >= 0 && workspaceSwitch < internalAdmin)
  assert.match(accountMenu.slice(internalAdmin), /ADMIN_NAV\.map/u)
  assert.match(accountMenu.slice(internalAdmin), /item\.platformAdmin && !isPlatformAdmin\(\)/u)
  assert.match(accountMenu, /<ThemeToggle variant="menu" \/>/u)
  assert.match(accountMenu, /onClick=\{\(\) => void logout\(\)\}/u)
  assert.match(accountMenu, /aria-controls="account-settings-menu"/u)
  assert.doesNotMatch(sidebar, /工作区分段切换/u)
})

test('theme controls remain accessible in account and mobile menus', () => {
  assert.match(themeToggle, /variant === 'menu'[\s\S]*role="menuitem"/u)
  assert.match(themeToggle, /aria-label="切换主题"/u)
  assert.match(mobileApp, /<Route path="\/m\/more" element=\{<MoreHub/u)
  assert.match(mobileApp, /function MoreHub[\s\S]*<ThemeToggle \/>/u)
  assert.match(mobileApp, /function MoreHub[\s\S]*onClick=\{logout\}/u)
})
