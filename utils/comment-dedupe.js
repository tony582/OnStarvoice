/**
 * 对已规范化的评论做稳定去重。
 *
 * - 两条都有不同 commentId 时，即使文案相同也保留；
 * - 至少一条缺少 commentId 时，才用“用户 + 文案 + 点赞数”兼容旧快照；
 * - 新数据带 ID、旧快照不带 ID 时，用新数据替换旧项，便于后续精确去重。
 */
export function dedupeNormalizedCommentItems(items = []) {
  const cleaned = [];
  const seenIds = new Set();
  const firstIndexBySemanticKey = new Map();

  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    const content = String(item.content || '').trim();
    if (!content) continue;

    const commentId = String(item.commentId || '').trim();
    const userId = String(item.userId || '').trim() || 'anonymous';
    const likesNum = Number(item.likes);
    const likes = Number.isFinite(likesNum) && likesNum >= 0
      ? Math.floor(likesNum)
      : 0;
    const semanticKey = `${userId}|${content.toLowerCase()}|${likes}`;

    if (commentId && seenIds.has(commentId)) {
      continue;
    }

    const semanticIndex = firstIndexBySemanticKey.get(semanticKey);
    if (commentId) {
      if (semanticIndex !== undefined) {
        const existingId = String(cleaned[semanticIndex]?.commentId || '').trim();
        if (!existingId) {
          cleaned[semanticIndex] = item;
          seenIds.add(commentId);
          continue;
        }
        // 两条都有不同的稳定 ID，视为两条真实评论。
      } else {
        firstIndexBySemanticKey.set(semanticKey, cleaned.length);
      }
      seenIds.add(commentId);
      cleaned.push(item);
      continue;
    }

    if (semanticIndex !== undefined) {
      continue;
    }
    firstIndexBySemanticKey.set(semanticKey, cleaned.length);
    cleaned.push(item);
  }

  return cleaned;
}

/** 重试时不能因为用户调低配置而截掉已经保存的评论。 */
export function resolveCommentMergeLimit(configuredLimit, savedItemCount = 0) {
  const configured = Number(configuredLimit);
  const saved = Number(savedItemCount);
  return Math.max(
    1,
    Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 0,
    Number.isFinite(saved) && saved > 0 ? Math.floor(saved) : 0,
  );
}
