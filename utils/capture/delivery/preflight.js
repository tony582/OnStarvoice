// L2 preflight: unchanged stage behavior, explicit host ports and per-pipeline state.
export function createPreflightStage({state, ports, operations}) {
  const {
    DEFAULT_BLOGGER_NOTES_TABLE_NAME,
    DEFAULT_BLOGGER_PROFILE_TABLE_NAME,
    DEFAULT_CHECK_SYNC_TYPES,
    DEFAULT_COMMENT_LEADS_TABLE_NAME,
    DEFAULT_KEYWORD_NOTES_TABLE_NAME,
    ERROR_REASON,
    SYNC_TYPE,
    console,
    getAuth,
    getTarget,
    resolveSyncTableName,
  } = ports;



  async function checkBeforeSync(requiredSyncTypes = [], options = {}) {
    const onProgress =
      options && typeof options.onProgress === 'function' ? options.onProgress : null;
    try {
      if (onProgress) {
        onProgress({
          phase: 'sync_check',
          message: '正在校验授权与同步配置...',
        });
      }

      // 检查 1: 是否已鉴权
      const auth = await getAuth();

      if (!auth.verified) {
        return {
          ok: false,
          error: {
            code: ERROR_REASON.NOT_VERIFIED,
            message:
              '当前功能需要激活码授权，已有激活码请在设置中完成验证；还没有可联系管理员获取。',
          },
        };
      }

      if (!auth.code) {
        return {
          ok: false,
          error: {
            code: ERROR_REASON.NOT_VERIFIED,
            message: '激活码缺失，请重新鉴权',
          },
        };
      }

      // 检查 2: 是否已配置目标
      const target = await getTarget();
      const requestTarget = buildSyncTargetPayload(target);

      // 使用 StarVoice 后台同步，不再强制要求 feishuAppToken
      // 如果配置了 feishuAppToken 则使用，否则使用激活码直连后端
      if (!requestTarget.feishuAppToken) {
        // 设置一个占位值，让后续逻辑不报错
        requestTarget.feishuAppToken = '__onstarvoice_backend__';
      }

      const syncTypesToCheck =
        Array.isArray(requiredSyncTypes) && requiredSyncTypes.length > 0
          ? [...new Set(requiredSyncTypes.filter(Boolean))]
          : DEFAULT_CHECK_SYNC_TYPES;

      const missingType = syncTypesToCheck.find(
        (syncType) => !resolveSyncTableName(requestTarget, syncType),
      );
      if (missingType) {
        const message =
          missingType === SYNC_TYPE.COMMENT_LEADS
            ? '请先配置评论客资同步表名'
            : missingType === SYNC_TYPE.SINGLE_NOTE ||
                missingType === SYNC_TYPE.COMMENTS ||
                missingType === SYNC_TYPE.KEYWORD_NOTES
            ? '请先配置单笔记/评论/关键词同步表名'
            : '请先配置博主页面同步的数据表名称';
        return {
          ok: false,
          error: {
            code: ERROR_REASON.INVALID_TARGET,
            message,
          },
        };
      }

      // 后端 sync/syncBatch 会在真正写入前再次校验激活码；这里不再额外
      // verify，避免每次同步前多唤醒一次 Neon。
      return {
        ok: true,
        error: null,
      };
    } catch (error) {
      console.error('[CaptureSync] Check before sync failed:', error);

      return {
        ok: false,
        error: {
          code: 'CHECK_FAILED',
          message: error.message,
        },
      };
    }
  }

  function buildSyncTargetPayload(target = {}) {
    return {
      feishuAppToken: String(target?.feishuAppToken || '').trim(),
      tableId: String(target?.tableId || '').trim(),
      keywordNotesTableName:
        String(target?.keywordNotesTableName || '').trim() ||
        DEFAULT_KEYWORD_NOTES_TABLE_NAME,
      bloggerProfileTableName:
        String(target?.bloggerProfileTableName || '').trim() ||
        DEFAULT_BLOGGER_PROFILE_TABLE_NAME,
      bloggerNotesTableName:
        String(target?.bloggerNotesTableName || '').trim() ||
        DEFAULT_BLOGGER_NOTES_TABLE_NAME,
      commentLeadsTableName:
        String(target?.commentLeadsTableName || '').trim() ||
        DEFAULT_COMMENT_LEADS_TABLE_NAME,
    };
  }

  return Object.freeze({
    checkBeforeSync,
    buildSyncTargetPayload,
  });
}
