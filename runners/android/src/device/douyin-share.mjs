import { setTimeout as delay } from 'node:timers/promises';
import { bounded, DeviceError } from './bounded.mjs';
import { appNodes, byId } from './douyin-profile.mjs';
import { readVerifiedDetail } from './douyin-detail.mjs';
import { observeCopiedShare } from '../calibration/share-evidence.mjs';

export async function copyBoundShare({ui, card, before, marker, signal}) {
  const options = {signal};
  const labels=['复制链接','分享链接'];
  const choicesFor=tree=>{
    const nodes=appNodes(tree),described=nodes.filter(node=>labels.includes(node.attributes['content-desc']));
    return described.length ? described : nodes.filter(node=>labels.includes(node.attributes.text));
  };
  const original = await ui.getClipboard(options);
  if (Buffer.byteLength(original) > 16 * 1024) {
    throw new DeviceError('clipboard_restore_unsupported', 'Existing clipboard exceeds the safe restore limit');
  }
  let observation;
  try {
    await ui.setClipboard(marker, options); const beforeText = await ui.getClipboard(options);
    if (beforeText !== marker) throw new DeviceError('clipboard_not_fresh', 'Clipboard marker was not confirmed');
    await ui.clickId(before.share, options);
    const sheet = await ui.waitFor(tree => choicesFor(tree).length > 0, options);
    const choices = choicesFor(sheet);
    if (choices.length !== 1) throw new DeviceError('share_option_ambiguous', 'Share action could not be identified uniquely');
    if (labels.includes(choices[0].attributes['content-desc'])) {
      await ui.clickXPath(`//*[@package='com.ss.android.ugc.aweme' and @content-desc='${choices[0].attributes['content-desc']}']`,options);
    } else await ui.clickText(choices[0].attributes.text, options);
    const afterText = await bounded(async signal => {
      while (true) {
        const value = await ui.getClipboard({ signal });
        if (value !== marker && !value.includes(marker)) return value;
        await delay(250, undefined, { signal });
      }
    }, { signal, timeoutMs: 5000 });
    let tree = await ui.read(options);
    // 40.6.0 keeps a separate confirmation sheet after copying the link.
    if (byId(tree, 'zz4').some(node => node.attributes.text === '链接已复制成功，去粘贴分享：')) {
      await ui.clickId('zzz', options);
      tree = await ui.read(options);
    }
    if (byId(tree, 'vl3').length === 1) await ui.back(options);
    const after = await readVerifiedDetail({ ui, card, signal });
    observation = observeCopiedShare({ marker, beforeText, afterText, card, detailBefore: before, detailAfter: after });
  } finally {
    // This is bounded cleanup of our temporary clipboard value, never stored on disk.
    try { await ui.setClipboard(original, { timeoutMs: 5000 }); }
    catch { throw new DeviceError('clipboard_restore_unconfirmed', 'Clipboard cleanup requires confirmation', { stopConfirmationRequired: true }); }
  }
  return observation;
}
