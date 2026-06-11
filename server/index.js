/**
 * OnStarVoice Backend Server
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
    console.log(`  ║  OnStarVoice 星语 Backend Server         ║`);
    console.log(`  ║  http://localhost:${PORT}                   ║`);
    console.log(`  ║  Admin: http://localhost:${PORT}/admin       ║`);
    console.log(`  ╚══════════════════════════════════════════╝\n`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

process.on('SIGINT', async () => { console.log('\n[Server] Shutting down...'); await closeDb(); process.exit(0); });
process.on('SIGTERM', async () => { await closeDb(); process.exit(0); });
