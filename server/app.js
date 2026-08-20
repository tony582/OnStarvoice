import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

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
import feedbackRouter from './routes/feedback.js';
import customTagsRouter from './routes/custom-tags.js';
import relevancePrefilterRouter from './routes/relevance-prefilter.js';
import captureCloudRouter from './routes/capture-cloud.js';
import captureOrchestrationsRouter from './routes/capture-orchestrations.js';
import negativePatrolRouter from './routes/negative-patrol.js';
import officialCommentPatrolRouter from './routes/official-comment-patrol.js';
import followedCreatorPatrolRouter from './routes/followed-creator-patrol.js';
import opinionAnalysisRouter from './routes/opinion-analysis.js';
import socialAccountsRouter from './routes/social-accounts.js';
import llmRelayAgentRouter from './routes/llm-relay-agent.js';
import { asrMediaRouter } from './services/asr-media-host.js';
import { MEDIA_DIR } from './services/media-store.js';
import { createProcessHealth } from './runtime/process-health.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_CORS_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

function configuredCorsOrigins(value = process.env.CORS_ORIGINS) {
  if (Array.isArray(value)) return value.map(origin => String(origin).trim()).filter(Boolean);
  if (!value) return [...DEFAULT_CORS_ORIGINS];
  return String(value)
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
}

/**
 * Build the HTTP application without opening a port, initializing PostgreSQL,
 * starting Cron, or registering background timers. The process runtimes retain
 * ownership of those process-level side effects.
 */
export function createApp({ corsOrigins, health, healthProvider, logger = console } = {}) {
  const app = express();
  const allowedCorsOrigins = configuredCorsOrigins(corsOrigins);
  if (health && healthProvider && health !== healthProvider) {
    throw new TypeError('health and healthProvider must not specify different providers');
  }
  const processHealth = health || healthProvider || createProcessHealth();

  for (const method of ['getLegacyHealth', 'getLiveness', 'getReadiness']) {
    if (typeof processHealth?.[method] !== 'function') {
      throw new TypeError(`healthProvider.${method} must be a function`);
    }
  }

  function healthRoute(method, { unavailableWhenNotOk = false } = {}) {
    return (req, res, next) => {
      Promise.resolve()
        .then(() => processHealth[method]())
        .then(snapshot => {
          const status = unavailableWhenNotOk && snapshot?.ok !== true ? 503 : 200;
          return res.status(status).json(snapshot);
        })
        .catch(next);
    };
  }

  app.use(cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedCorsOrigins.includes(origin) || origin.startsWith('chrome-extension://')) {
        return callback(null, true);
      }
      return callback(new Error(`CORS origin not allowed: ${origin}`));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-auth-code', 'x-admin-token', 'x-tenant-id', 'x-session-token', 'x-capture-agent-token', 'x-llm-relay-agent-token', 'Authorization'],
  }));

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use((req, res, next) => {
    req.cookies = {};
    const cookieHeader = req.headers.cookie || '';
    cookieHeader.split(';').forEach(pair => {
      const [key, value] = pair.trim().split('=');
      if (key) req.cookies[key] = decodeURIComponent(value || '');
    });
    next();
  });

  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) {
      logger?.log?.(`[REQ] ${req.method} ${req.path} body-keys: ${Object.keys(req.body || {}).join(',')}`);
    }
    next();
  });

  app.use('/admin', express.static(join(__dirname, '..', 'web', 'admin', 'dist')));
  app.use('/dashboard', express.static(join(__dirname, '..', 'web', 'dashboard', 'dist')));
  app.use('/admin', express.static(join(__dirname, 'admin')));
  app.use('/dashboard', express.static(join(__dirname, 'dashboard')));
  app.use('/images', express.static(join(__dirname, '..', 'images')));
  app.use('/downloads', express.static(join(__dirname, '..', 'releases'), {
    maxAge: '1h',
    fallthrough: true,
  }));
  app.use('/media', express.static(MEDIA_DIR, { maxAge: '7d' }));

  app.get(['/about', '/contact', '/changelog', '/pricing'], (req, res) => {
    res.sendFile(join(__dirname, 'public', 'about.html'));
  });
  app.get(['/help', '/guide', '/faq', '/tutorial'], (req, res) => {
    res.sendFile(join(__dirname, 'public', 'help.html'));
  });

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
  app.use('/api/feedback', feedbackRouter);
  app.use('/api/custom-tags', customTagsRouter);
  app.use('/api/relevance/prefilter', relevancePrefilterRouter);
  app.use('/api/capture-cloud', captureCloudRouter);
  app.use('/api/capture-cloud', captureOrchestrationsRouter);
  app.use('/api/capture-cloud', negativePatrolRouter);
  app.use('/api/capture-cloud', officialCommentPatrolRouter);
  app.use('/api/capture-cloud', followedCreatorPatrolRouter);
  app.use('/api/opinion-analysis', opinionAnalysisRouter);
  app.use('/api/social-accounts', socialAccountsRouter);
  app.use('/api/llm-relay', llmRelayAgentRouter);
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

  app.get('/api/health', healthRoute('getLegacyHealth'));
  app.get('/api/health/live', healthRoute('getLiveness', { unavailableWhenNotOk: true }));
  app.get('/api/health/ready', healthRoute('getReadiness', { unavailableWhenNotOk: true }));

  app.get('/admin/*', (req, res) => {
    res.sendFile(join(__dirname, '..', 'web', 'admin', 'dist', 'index.html'));
  });
  app.get('/dashboard/*', (req, res) => {
    res.sendFile(join(__dirname, '..', 'web', 'dashboard', 'dist', 'index.html'));
  });

  app.get('/', (req, res) => { res.redirect('/admin'); });

  app.use((err, req, res, next) => {
    logger?.error?.('[Server] Unhandled error:', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: err.message });
  });

  return app;
}

export default createApp;
