// Image notes can contain a playing video in a media-only .focusPanel.
// Bind the entire note page before considering those player containers.
export function findDirectDouyinNoteRoot({url, expectedNoteId = '', document, isVisible}) {
  let routeId;
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol) ||
        !/^(www\.)?douyin\.com$/i.test(parsed.hostname) ||
        parsed.searchParams.has('modal_id')) return null;
    routeId = parsed.pathname.match(/^\/note\/(\d{8,})\/?$/)?.[1];
  } catch {
    return null;
  }
  if (!routeId || (expectedNoteId && String(expectedNoteId) !== routeId)) return null;

  const roots = Array.from(document.querySelectorAll('main[data-e2e="note-detail"]'))
    .filter(root => !root.closest('[aria-hidden="true"], [hidden]') && isVisible(root));
  if (roots.length !== 1) return null;
  const root = roots[0];
  const caption = root.querySelector('.daVLa2m7 .Bfj9rfeR');
  const publisher = root.querySelector('[data-e2e="user-info"] a[href*="/user/"]');
  return caption?.textContent?.trim() && publisher ? root : null;
}
