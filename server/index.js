/**
 * StarVoice Backend Server
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { initDb, closeDb } from './db/init.js';
import { startCronJobs } from './cron.js';
import { sendTestEmail } from './services/email-notifier.js';
import { labelPendingRecords } from './services/ai-labeler.js';
import { generateDailyReport, generateWeeklyReport, generateMonthlyReport } from './services/report-generator.js';
import { requireAdmin } from './middleware/auth.js';

import authRouter from './routes/auth.js';
import verifyRouter from './routes/verify.js';
import syncRouter from './routes/sync.js';
import targetRouter from './routes/target.js';
import monitorRouter from './routes/monitor.js';
import updateManifestRouter from './routes/update-manifest.js';
import adminRouter from './routes/admin.js';
import userRouter from './routes/user.js';
import issuesRouter from './routes/issues.js';
import reportsRouter from './routes/reports.js';
import recordsRouter from './routes/records.js';
import commentsRouter from './routes/comments.js';
import triageRouter from './routes/triage.js';
import workspaceRouter from './routes/workspace.js';
import analyticsRouter from './routes/analytics.js';
import leadsRouter from './routes/leads.js';
import keywordOpportunityRouter, { keywordAnalysisRouter, benchmarkDiscoveryRouter } from './routes/keyword-strategy.js';
import contentRouter from './routes/content.js';
import imageProxyRouter from './routes/image-proxy.js';
import ticketsRouter from './routes/tickets.js';
import { asrMediaRouter } from './services/asr-media-host.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== 中间件 ====================

const configuredCorsOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001,http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (configuredCorsOrigins.includes(origin) || origin.startsWith('chrome-extension://')) {
      return callback(null, true);
    }
    return callback(new Error(`CORS origin not allowed: ${origin}`));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-auth-code', 'x-admin-token', 'x-tenant-id', 'x-session-token', 'Authorization'],
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Cookie 解析
app.use((req, res, next) => {
  req.cookies = {};
  const cookieHeader = req.headers.cookie || '';
  cookieHeader.split(';').forEach(pair => {
    const [key, value] = pair.trim().split('=');
    if (key) req.cookies[key] = decodeURIComponent(value || '');
  });
  next();
});

// 请求日志
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    console.log(`[REQ] ${req.method} ${req.path} body-keys: ${Object.keys(req.body || {}).join(',')}`);
  }
  next();
});

// ==================== 静态文件 ====================

// React 构建产物
app.use('/admin', express.static(join(__dirname, '..', 'web', 'admin', 'dist')));
app.use('/dashboard', express.static(join(__dirname, '..', 'web', 'dashboard', 'dist')));
// 旧版静态文件（向后兼容，作为 fallback）
app.use('/admin', express.static(join(__dirname, 'admin')));
app.use('/dashboard', express.static(join(__dirname, 'dashboard')));
app.use('/images', express.static(join(__dirname, '..', 'images')));

// 关于 / 联系 / 定价 / 更新日志(插件内多处入口指向此页）
app.get(['/about', '/contact', '/changelog', '/pricing'], (req, res) => {
  res.sendFile(join(__dirname, 'public', 'about.html'));
});

// ==================== API 路由 ====================

app.use('/api/auth', authRouter);
app.use('/api/verify', verifyRouter);
app.use('/api/sync', syncRouter);
app.use('/api/target', targetRouter);
app.use('/api/monitor', monitorRouter);
app.use('/api/update-manifest', updateManifestRouter);
app.use('/api/admin', adminRouter);
app.use('/api/user', userRouter);
app.use('/api/issues', issuesRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/records', recordsRouter);
app.use('/api/comments', commentsRouter);
app.use('/api/triage', triageRouter);
app.use('/api/workspace', workspaceRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/leads', leadsRouter);
app.use('/api/keyword-analysis', keywordAnalysisRouter);
app.use('/api/keyword-opportunity', keywordOpportunityRouter);
app.use('/api/benchmark-discovery', benchmarkDiscoveryRouter);
app.use('/api/content', contentRouter);
app.use('/api/img', imageProxyRouter);
app.use('/api/tickets', ticketsRouter);
// 公网无鉴权:仅供阿里云百炼拉取 ASR 临时托管的媒体(token 一次性、短时效)
app.use('/api/asr-media', asrMediaRouter);

app.post('/api/admin/test-email', requireAdmin, async (req, res) => {
  try { return res.json(await sendTestEmail()); }
  catch (err) { return res.json({ ok: false, message: err.message }); }
});

app.post('/api/admin/run-labeling', requireAdmin, async (req, res) => {
  try { return res.json({ ok: true, ...(await labelPendingRecords(req.body?.limit || 20)) }); }
  catch (err) { return res.json({ ok: false, message: err.message }); }
});

app.post('/api/admin/generate-report', requireAdmin, async (req, res) => {
  try {
    const { type = 'daily', tenantId = null } = req.body;
    if (type === 'monthly') await generateMonthlyReport(tenantId);
    else if (type === 'weekly') await generateWeeklyReport(tenantId);
    else await generateDailyReport(tenantId);
    return res.json({ ok: true, message: `${type} 报表已生成并发送` });
  } catch (err) { return res.json({ ok: false, message: err.message }); }
});

app.get('/api/health', (req, res) => {
  return res.json({ ok: true, version: '0.1.0', uptime: process.uptime() });
});

// SPA fallback — 让 React Router 处理客户端路由
app.get('/admin/*', (req, res) => {
  res.sendFile(join(__dirname, '..', 'web', 'admin', 'dist', 'index.html'));
});
app.get('/dashboard/*', (req, res) => {
  res.sendFile(join(__dirname, '..', 'web', 'dashboard', 'dist', 'index.html'));
});

app.get('/', (req, res) => { res.redirect('/admin'); });

app.use((err, req, res, next) => {
  console.error('[Server] Unhandled error:', err);
  return res.status(500).json({ ok: false, error: 'server_error', message: err.message });
});

// ==================== 启动 ====================

async function start() {
  await initDb();
  startCronJobs();

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
  setTimeout(() => {
    import('./services/comment-workflow.js')
      .then(m => m.reprocessPendingComments())
      .catch(err => console.error('[Reprocess] 启动自愈失败:', err.message));
  }, 15000);

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

process.on('SIGINT', async () => { console.log('\n[Server] Shutting down...'); await closeDb(); process.exit(0); });
process.on('SIGTERM', async () => { await closeDb(); process.exit(0); });
