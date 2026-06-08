/**
 * OnStarVoice Backend Server
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { initDb, closeDb, startAutoSave } from './db/init.js';
import { startCronJobs } from './cron.js';
import { sendTestEmail } from './services/email-notifier.js';
import { labelPendingRecords } from './services/ai-labeler.js';
import { generateDailyReport, generateWeeklyReport } from './services/report-generator.js';
import { requireAdmin } from './middleware/auth.js';

import verifyRouter from './routes/verify.js';
import syncRouter from './routes/sync.js';
import targetRouter from './routes/target.js';
import monitorRouter from './routes/monitor.js';
import updateManifestRouter from './routes/update-manifest.js';
import adminRouter from './routes/admin.js';
import userRouter from './routes/user.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== 中间件 ====================

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-auth-code', 'x-admin-token', 'Authorization'],
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

app.use('/admin', express.static(join(__dirname, 'admin')));
app.use('/dashboard', express.static(join(__dirname, 'dashboard')));

// ==================== API 路由 ====================

app.use('/api/verify', verifyRouter);
app.use('/api/sync', syncRouter);
app.use('/api/target', targetRouter);
app.use('/api/monitor', monitorRouter);
app.use('/api/update-manifest', updateManifestRouter);
app.use('/api/admin', adminRouter);
app.use('/api/user', userRouter);

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
    const { type = 'daily' } = req.body;
    if (type === 'weekly') await generateWeeklyReport();
    else await generateDailyReport();
    return res.json({ ok: true, message: `${type} 报表已生成并发送` });
  } catch (err) { return res.json({ ok: false, message: err.message }); }
});

app.get('/api/health', (req, res) => {
  return res.json({ ok: true, version: '0.1.0', uptime: process.uptime() });
});

app.get('/', (req, res) => { res.redirect('/admin'); });

// ==================== 启动 ====================

async function start() {
  await initDb();
  startAutoSave();
  startCronJobs();

  app.listen(PORT, () => {
    console.log(`\n  ╔══════════════════════════════════════════╗`);
    console.log(`  ║  OnStarVoice Backend Server              ║`);
    console.log(`  ║  http://localhost:${PORT}                   ║`);
    console.log(`  ║  Admin: http://localhost:${PORT}/admin       ║`);
    console.log(`  ╚══════════════════════════════════════════╝\n`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

process.on('SIGINT', () => { console.log('\n[Server] Shutting down...'); closeDb(); process.exit(0); });
process.on('SIGTERM', () => { closeDb(); process.exit(0); });
