/**
 * StarVoice Backend Server
 */

import 'dotenv/config';

import { createApp } from './app.js';
import { closeDb } from './db/init.js';
import { startCronJobs } from './cron.js';
import { probeDeepSeekPrimaryModel } from './services/ai-labeler.js';
import {runAiFailoverRecoverySweep} from './services/ai-failover.js';
import { failStaleAnalyses } from './services/opinion-analysis.js';
import { startVerifyRateLimitCleanup, stopVerifyRateLimitCleanup } from './routes/verify.js';
import { startAsrMediaCleanup, stopAsrMediaCleanup } from './services/asr-media-host.js';
import { ensureMediaDirs, backfillRecentCovers, backfillRecentImages } from './services/media-store.js';
import { prepareCompatibilityProcess } from './runtime/compatibility-process.js';

const app = createApp();
const PORT = process.env.PORT || 3000;
let processRoleLockHandle = null;
let lockLossExitStarted = false;

function exitOnProcessRoleLockLoss(details) {
  if (lockLossExitStarted) return;
  lockLossExitStarted = true;
  console.error(
    `[ProcessRole] Lost ${details.role} execution authority; exiting immediately.`,
  );
  // P2-B cannot safely demote this process: Cron and recursive AI timers do
  // not yet expose complete stop handles. Exiting is the fail-closed fence.
  process.exit(1);
}

// ==================== 启动 ====================

async function start() {
  const runtime = await prepareCompatibilityProcess({
    env: process.env,
    logger: console,
    onLockLost: exitOnProcessRoleLockLoss,
  });
  processRoleLockHandle = runtime.lockHandle;
  ensureMediaDirs();
  startVerifyRateLimitCleanup();
  startAsrMediaCleanup();
  startCronJobs();

  // 舆情剖析收尸:剖析任务靠 setImmediate 在内存里跑,进程重启即丢,
  // 把上一进程遗留的 pending/running 置为 failed,前端不再无限轮询
  failStaleAnalyses().catch(err => console.error('[OpinionAnalysis] 启动收尸失败:', err.message));

  app.listen(PORT, () => {
    console.log(`\n  ╔══════════════════════════════════════════╗`);
    console.log(`  ║  StarVoice 星语 Backend Server         ║`);
    console.log(`  ║  http://localhost:${PORT}                   ║`);
    console.log(`  ║  Admin: http://localhost:${PORT}/admin       ║`);
    console.log(`  ╚══════════════════════════════════════════╝\n`);
  });

  // 自愈:启动 15s 后(避开启动峰值)非阻塞补回积压的评论入库 ——
  // 异步队列曾因 LLM 请求挂死而卡死、或进程重启丢失内存队列,导致 record_comments 漏入。
  // 评论数据本就安全存在 records.payload,这里从 payload 重新入库。LLM 已加超时,不会再卡。
  setTimeout(async () => {
    try {
      const workflow = await import('./services/comment-workflow.js');
      await workflow.reprocessPendingComments();

      // 一次性把旧版因裸命中“安全”而落库的负面评论重新排入 AI 语义分类。
      // “安全”只用于缩小历史候选范围，不作为最终正负结论；AI 回写前保留旧事实，
      // 避免规则 fallback 暂时把真实安全投诉降成非负面。
      const { queryOne, execute } = await import('./db/init.js');
      const flag = 'comment_safety_semantic_reclassify_v1';
      const done = await queryOne('SELECT 1 FROM schema_migrations WHERE version = $1', [flag]);
      if (!done) {
        const stats = await workflow.reclassifyComments(null, {
          safetySemanticReviewCandidatesOnly: true,
          queueForAI: true,
        });
        await execute(
          'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
          [flag],
        );
        console.log(`[CommentSafety] 存量评论已重新排入 AI 语义分类:${stats.changed} 条`);
      }
    } catch (err) {
      console.error('[Reprocess] 启动自愈或安全词重算失败:', err.message);
    }
  }, 15000);

  // 封面落地:启动 25s 后回填近 24h 采集、还没落地的封面(链接多半还有效,过期的自动跳过)
  setTimeout(() => {
    Promise.all([backfillRecentCovers(), backfillRecentImages()])
      .then(([covers, images]) => {
        if (covers) console.log(`[CoverStore] 启动回填:尝试 ${covers} 条封面落地`);
        if (images) console.log(`[ImageStore] 启动回填:尝试 ${images} 条正文图片落地`);
      })
      .catch(() => {});
  }, 25000);

  // 后台 AI 精炼:评论已规则入库且可见,这里持续把"未 AI 分类"的评论批量精炼回填。
  // 自调度循环(不重叠):单轮把积压排干(分多次 limit),再隔 15s 检查;LLM 失败的留到下轮重试。
  const drainCommentAi = async () => {
    try {
      const m = await import('./services/comment-workflow.js');
      let total = 0;
      for (let i = 0; i < 30; i++) { // 单轮上限 30×300=9000,防跑飞
        const n = await m.refineCommentsWithAI({ limit: 300 });
        total += n;
        if (n === 0) break;
      }
      if (total) console.log(`[CommentRefine] 本轮 AI 精炼 ${total} 条评论`);
    } catch (err) {
      console.error('[CommentRefine] 轮询失败:', err.message);
    } finally {
      setTimeout(drainCommentAi, 15000);
    }
  };
  setTimeout(drainCommentAi, 20000); // 启动 20s 后开始(让 15s 的 reprocess 先把评论入库)

  // AI 主模型恢复探测:只有已切到备用模型且到达 next_primary_probe_at 的
  // 租户才会发送一条不含业务数据的最小 JSON 探针。连续通过配置次数后自动回主模型。
  // 自调度且不重叠;数据库 claim + advisory lock 也避免未来多进程重复探测。
  const checkAiFailoverRecovery = async () => {
    try {
      const result = await runAiFailoverRecoverySweep({
        probe: probeDeepSeekPrimaryModel,
      });
      if (result.probed || result.recovered) {
        console.info('[AIFailover] recovery sweep', result);
      }
    } catch (error) {
      console.error('[AIFailover] recovery sweep failed:', error?.message || error);
    } finally {
      setTimeout(checkAiFailoverRecovery, 60000);
    }
  };
  setTimeout(checkAiFailoverRecovery, 60000);

  // 一次性:上汽通用监控范围放宽(别克/凯迪拉克/雪佛兰/车机壁纸等现算相关)后,
  // 把存量"原判 irrelevant"的记录重判一遍 —— 该进分诊的自动进,无需重采。gated 只跑一次。
  setTimeout(async () => {
    try {
      const { queryAll } = await import('./db/init.js');
      const FLAG = 'relabel_saicgm_scope_v3';
      const done = await queryAll('SELECT 1 FROM schema_migrations WHERE version = $1', [FLAG]);
      if (done.length) return;
      const { labelRecord } = await import('./services/ai-labeler.js');
      const recs = await queryAll("SELECT id FROM records WHERE ai_result->>'relevance' = 'irrelevant'");
      if (recs.length) {
        console.log(`[Relabel] 上汽通用范围放宽:重判 ${recs.length} 条原判无关的记录`);
        for (const r of recs) {
          try { await labelRecord(r.id, { force: true }); } catch (e) { console.error('[Relabel]', r.id, e.message); }
        }
      }
      await queryAll('INSERT INTO schema_migrations (version) VALUES ($1)', [FLAG]);
      console.log('[Relabel] 完成');
    } catch (e) {
      console.error('[Relabel] 启动重判失败:', e.message);
    }
  }, 25000);
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

process.on('SIGINT', async () => {
  console.log('\n[Server] Shutting down...');
  stopVerifyRateLimitCleanup();
  stopAsrMediaCleanup();
  await closeDb();
  // Keep the role-lock session until process exit. P2-C will add complete
  // Cron/timer/server stop handles before graceful early unlock is safe.
  process.exit(0);
});
process.on('SIGTERM', async () => {
  stopVerifyRateLimitCleanup();
  stopAsrMediaCleanup();
  await closeDb();
  process.exit(0);
});
