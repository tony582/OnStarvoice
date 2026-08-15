#!/usr/bin/env node
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { extractPublishLocation, stripPublishLocation } from '../utils/publish-location.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SERVER_DIR = resolve(__dirname, '..');
const DEFAULT_TENANT_ID = '457e5851-93eb-4446-84e5-eb6ddb871e65';

function usage() {
  return `
Usage:
  node scripts/import-extension-csv.js --source xiaohongshu=/path/a.csv --source douyin=/path/b.csv [--tenant-id <uuid>] [--commit]

Options:
  --source <platform=path>  CSV file exported from the extension. Platform: xiaohongshu or douyin.
  --tenant-id <uuid>       Target tenant id. Defaults to the known Anjixing tenant id.
  --auth-code <code>       Optional auth code to stamp on imported records.
  --env-file <path>        dotenv file to load before connecting. Defaults to server/.env.
  --limit <n>              Import/preview at most n rows across all sources.
  --skip-comments          Keep merged comment text only; do not create record_comments.
  --commit                 Actually write to the database. Omit for dry-run.
`;
}

function parseArgs(argv) {
  const out = {
    sources: [],
    tenantId: DEFAULT_TENANT_ID,
    authCode: '',
    envFile: join(SERVER_DIR, '.env'),
    limit: 0,
    commit: false,
    skipComments: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };

    if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else if (arg === '--commit') {
      out.commit = true;
    } else if (arg === '--dry-run') {
      out.commit = false;
    } else if (arg === '--skip-comments') {
      out.skipComments = true;
    } else if (arg === '--source') {
      out.sources.push(parseSource(next()));
    } else if (arg.startsWith('--source=')) {
      out.sources.push(parseSource(arg.slice('--source='.length)));
    } else if (arg === '--tenant-id') {
      out.tenantId = next();
    } else if (arg.startsWith('--tenant-id=')) {
      out.tenantId = arg.slice('--tenant-id='.length);
    } else if (arg === '--auth-code') {
      out.authCode = next();
    } else if (arg.startsWith('--auth-code=')) {
      out.authCode = arg.slice('--auth-code='.length);
    } else if (arg === '--env-file') {
      out.envFile = resolve(next());
    } else if (arg.startsWith('--env-file=')) {
      out.envFile = resolve(arg.slice('--env-file='.length));
    } else if (arg === '--limit') {
      out.limit = Number(next()) || 0;
    } else if (arg.startsWith('--limit=')) {
      out.limit = Number(arg.slice('--limit='.length)) || 0;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return out;
}

function parseSource(value) {
  const eq = value.indexOf('=');
  const sep = eq >= 0 ? eq : value.indexOf(':');
  if (sep <= 0) throw new Error(`Invalid --source value: ${value}`);
  const platform = value.slice(0, sep).trim();
  const path = value.slice(sep + 1).trim();
  if (!['xiaohongshu', 'douyin'].includes(platform)) {
    throw new Error(`Unsupported platform for --source: ${platform}`);
  }
  if (!path) throw new Error(`Missing file path in --source: ${value}`);
  return { platform, path: resolve(path) };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (ch === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }

  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function parseMetricNumber(value, fallback = 0) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
  const text = String(value).replace(/[,，\s]/g, '').trim();
  if (!text || text === '未采集') return fallback;
  const match = text.match(/(-?\d+(?:\.\d+)?)(亿|万|[wW]|[kK])?/);
  if (!match) return fallback;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return fallback;
  const unit = match[2] || '';
  if (unit === '亿') return Math.round(amount * 100000000);
  if (unit === '万' || /^[wW]$/.test(unit)) return Math.round(amount * 10000);
  if (/^[kK]$/.test(unit)) return Math.round(amount * 1000);
  return Math.round(amount);
}

function normalizeUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) {
      parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return raw;
  }
}

function extractExternalId(platform, url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (platform === 'xiaohongshu') {
    return raw.match(/\/explore\/([^?/#]+)/)?.[1]
      || raw.match(/\/discovery\/item\/([^?/#]+)/)?.[1]
      || raw.match(/xhslink\.com\/([^?\s/#]+)/)?.[1]
      || '';
  }
  return raw.match(/\/video\/([^?/#]+)/)?.[1]
    || raw.match(/[?&](?:modal_id|note_id|aweme_id)=([^&#]+)/)?.[1]
    || '';
}

function fallbackExternalId(platform, url, row) {
  const extracted = extractExternalId(platform, url);
  if (extracted) return extracted;
  const normalized = normalizeUrl(url);
  if (normalized) return `url:${normalized}`;
  const hash = createHash('sha256')
    .update([
      platform,
      row.title || '',
      row.content || '',
      row.authorName || '',
      row.captureTimestamp || '',
    ].join('\n'))
    .digest('hex')
    .slice(0, 24);
  return `hash:${hash}`;
}

function splitTags(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  const hashTags = text.match(/#[^#,\s，、]+/g);
  if (hashTags?.length) return [...new Set(hashTags.map(tag => tag.replace(/^#/, '').trim()).filter(Boolean))];
  return [...new Set(text.split(/[,，、\n]/).map(item => item.replace(/^#/, '').trim()).filter(Boolean))];
}

function splitUrls(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  return [...new Set(text.split(/[\n,，]\s*/).map(item => item.trim()).filter(item => /^https?:\/\//i.test(item)))];
}

function cleanAuthorName(value) {
  return String(value || '').trim().replace(/作者$/u, '').trim();
}

function parseCommentLine(raw, index) {
  let text = String(raw || '').trim();
  if (!text) return null;

  const prefix = text.match(/^(\d+)[、.：:]\s*([\s\S]*)$/u);
  const floorIndex = prefix ? Number(prefix[1]) : index + 1;
  if (prefix) text = prefix[2].trim();

  let likes = 0;
  const likeMatch = text.match(/（\s*([\d.,]+(?:亿|万|[wW]|[kK])?)\s*个赞\s*）\s*$/u);
  if (likeMatch) {
    likes = parseMetricNumber(likeMatch[1], 0);
    text = text.slice(0, likeMatch.index).trim();
  }

  let authorName = '';
  let ipLocation = '';
  let content = text;
  const authorMatch = text.match(/^(.+?)（([^（）\n]{0,20})）：([\s\S]*)$/u);
  if (authorMatch) {
    authorName = cleanAuthorName(authorMatch[1]);
    ipLocation = authorMatch[2].trim();
    content = authorMatch[3].trim();
  }

  if (!content) return null;
  return {
    authorName,
    ipLocation,
    content,
    likes,
    floorIndex,
    payload: {
      source: 'extension_csv_import',
      raw,
    },
  };
}

function parseComments(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  return text
    .split(/\n(?=\d+[、.：:]\s*)/u)
    .map((chunk, index) => parseCommentLine(chunk, index))
    .filter(Boolean);
}

function normalizeNoteType(value) {
  const text = String(value || '').trim();
  if (text === '视频') return 'video';
  if (text === '图文') return 'image';
  return text;
}

function rowObject(header, row) {
  const object = {};
  for (let i = 0; i < header.length; i += 1) {
    object[header[i]] = row[i] ?? '';
  }
  return object;
}

function mapRow(platform, rawRow) {
  const noteUrl = String(rawRow['笔记链接'] || '').trim();
  const authorName = String(rawRow['博主'] || '').trim();
  const content = String(rawRow['正文'] || '').trim();
  const title = String(rawRow['标题'] || '').trim();
  const commentsText = String(rawRow['评论内容'] || '').trim();
  const tags = splitTags(rawRow['话题标签']);
  const imageUrls = splitUrls(rawRow['图片链接']);
  const commentItems = parseComments(commentsText);
  const rawPublishDate = String(rawRow['笔记最近编辑时间'] || '').trim();
  const publishLocation = String(
    rawRow['发布位置'] ||
    rawRow['发布属地'] ||
    rawRow['IP属地'] ||
    rawRow['IP 属地'] ||
    extractPublishLocation(rawPublishDate)
  ).trim();
  const publishDateRaw = stripPublishLocation(rawPublishDate) || rawPublishDate;
  const captureTimestamp = String(rawRow['采集时间'] || '').trim();
  const rowForId = { title, content, authorName, captureTimestamp };
  const externalId = fallbackExternalId(platform, noteUrl, rowForId);
  const noteType = normalizeNoteType(rawRow['笔记类型']);
  const coverUrl = String(rawRow['封面链接'] || '').trim();
  const videoUrl = String(rawRow['视频链接'] || '').trim();
  const audioUrl = String(rawRow['音频链接'] || '').trim();
  const commentsCaptureStatus = String(rawRow['评论采集状态'] || '').trim();
  const commentsTotalCaptured = parseMetricNumber(rawRow['评论采集条数'], commentItems.length || 0);

  const payload = {
    source: 'extension_csv_import',
    csvPlatformLabel: String(rawRow['采集平台'] || '').trim(),
    platform,
    noteId: externalId,
    externalId,
    author: authorName,
    bloggerProfileUrl: String(rawRow['博主主页'] || '').trim(),
    coverImageUrl: coverUrl,
    title,
    noteTitle: title,
    url: noteUrl,
    noteUrl,
    content,
    noteContent: content,
    tags,
    imageUrls,
    commentsMergedText: commentsText,
    commentsCleanedItems: commentItems,
    noteType,
    type: noteType,
    captureTimestamp,
    publishDateRaw,
    publishTime: publishDateRaw,
    publishLocation,
    likes: parseMetricNumber(rawRow['点赞数']),
    collects: parseMetricNumber(rawRow['收藏数']),
    comments: parseMetricNumber(rawRow['评论数']),
    shares: parseMetricNumber(rawRow['转发数']),
    bloggerFollowersCount: parseMetricNumber(rawRow['粉丝数']),
    bloggerLikedAndCollectedCount: parseMetricNumber(rawRow['点赞与收藏数']),
    bloggerAccountType: String(rawRow['账号属性'] || '').trim(),
    videoUrl,
    audioUrl,
    videoDuration: String(rawRow['视频时长'] || '').trim(),
    commentsCaptureStatus,
    commentsTotalCaptured,
  };

  return {
    external_id: externalId,
    platform,
    record_type: 'single_note',
    title,
    content,
    author_name: authorName,
    author_id: '',
    author_avatar: '',
    author_fans: payload.bloggerFollowersCount,
    url: noteUrl,
    cover_url: coverUrl,
    note_type: noteType,
    source_type: '',
    likes: payload.likes,
    comments_count: payload.comments,
    collects: payload.collects,
    shares: payload.shares,
    publish_time: publishDateRaw,
    publish_location: publishLocation,
    tags: JSON.stringify(tags),
    blogger_profile_url: payload.bloggerProfileUrl,
    author_account_no: '',
    image_urls: JSON.stringify(imageUrls),
    comments_text: commentsText,
    comments_cleaned_items: JSON.stringify(commentItems),
    official_reply_detected: false,
    official_reply_items: JSON.stringify([]),
    skip_official_accounts: true,
    blogger_liked_collected: payload.bloggerLikedAndCollectedCount,
    blogger_account_type: payload.bloggerAccountType,
    video_url: videoUrl,
    audio_url: audioUrl,
    video_duration: payload.videoDuration,
    comments_capture_status: commentsCaptureStatus,
    comments_total_captured: commentsTotalCaptured,
    capture_timestamp: captureTimestamp,
    keyword: '',
    rank_position: null,
    payload: JSON.stringify(payload),
    _commentItems: commentItems,
  };
}

function loadSource({ platform, path }) {
  const text = fs.readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  const rows = parseCsv(text);
  const header = rows[0] || [];
  const data = rows.slice(1).filter(row => row.some(value => String(value || '').trim()));
  const badFieldRows = data.filter(row => row.length !== header.length).length;
  const mapped = data.map(row => mapRow(platform, rowObject(header, row)));
  return { platform, path, header, rows: mapped, badFieldRows };
}

function summarizeSource(source) {
  const ids = source.rows.map(row => row.external_id).filter(Boolean);
  const uniqueIds = new Set(ids);
  const comments = source.rows.reduce((sum, row) => sum + row._commentItems.length, 0);
  const rowsWithComments = source.rows.filter(row => row._commentItems.length > 0).length;
  const rowsWithCover = source.rows.filter(row => row.cover_url).length;
  return {
    platform: source.platform,
    file: source.path,
    rows: source.rows.length,
    badFieldRows: source.badFieldRows,
    uniqueExternalIds: uniqueIds.size,
    duplicateExternalIds: ids.length - uniqueIds.size,
    rowsWithComments,
    parsedComments: comments,
    rowsWithCover,
  };
}

function printSummary(sources, options) {
  const summaries = sources.map(summarizeSource);
  console.log(JSON.stringify({
    mode: options.commit ? 'commit' : 'dry-run',
    tenantId: options.tenantId,
    skipComments: options.skipComments,
    limit: options.limit || null,
    sources: summaries,
    totals: summaries.reduce((acc, item) => ({
      rows: acc.rows + item.rows,
      badFieldRows: acc.badFieldRows + item.badFieldRows,
      duplicateExternalIds: acc.duplicateExternalIds + item.duplicateExternalIds,
      rowsWithComments: acc.rowsWithComments + item.rowsWithComments,
      parsedComments: acc.parsedComments + item.parsedComments,
      rowsWithCover: acc.rowsWithCover + item.rowsWithCover,
    }), { rows: 0, badFieldRows: 0, duplicateExternalIds: 0, rowsWithComments: 0, parsedComments: 0, rowsWithCover: 0 }),
  }, null, 2));
}

export async function closeCsvImportResources({
  closeDatabase,
  executionLock,
  primaryError = null,
} = {}) {
  try {
    await closeDatabase();
  } catch (closeError) {
    // The role locks are the last execution fence. Retain their PostgreSQL
    // session until the top-level handler exits the process when pool closure
    // cannot be confirmed.
    if (primaryError) {
      throw new AggregateError(
        [primaryError, closeError],
        `CSV import failed (${primaryError?.message || primaryError}); database close also failed (${closeError?.message || closeError})`,
      );
    }
    throw closeError;
  }

  try {
    await executionLock.release();
  } catch (releaseError) {
    if (primaryError) {
      throw new AggregateError(
        [primaryError, releaseError],
        `CSV import failed (${primaryError?.message || primaryError}); execution-lock release also failed (${releaseError?.message || releaseError})`,
      );
    }
    throw releaseError;
  }
}

async function importRows(sources, options) {
  dotenv.config({ path: options.envFile, override: true });
  const { resolveEntrypointProcessRole } = await import('../config/process-role.js');
  const { assertProductionDatabaseUrl } = await import('../maintenance/cli.js');
  const { acquireProcessRoleLocks } = await import('../runtime/process-role-locks.js');

  resolveEntrypointProcessRole({
    env: process.env,
    expectedRole: 'maintenance',
    entrypoint: 'server/scripts/import-extension-csv.js',
  });
  assertProductionDatabaseUrl(process.env);
  if (process.env.MAINTENANCE_OFFLINE_CONFIRMED !== '1') {
    const error = new Error('CSV commit import requires MAINTENANCE_OFFLINE_CONFIRMED=1.');
    error.code = 'MAINTENANCE_OFFLINE_CONFIRMATION_REQUIRED';
    throw error;
  }

  const executionLock = await acquireProcessRoleLocks({
    role: 'all',
    databaseUrl: process.env.DATABASE_URL,
    applicationName: `onstarvoice:maintenance-csv-import:${process.pid}`,
    connectionTimeoutMillis: process.env.PG_CONNECT_TIMEOUT_MS,
    logger: console,
    onLockLost(details) {
      console.error(
        `[ImportCSV] lost offline execution authority (${details?.event || 'unknown'}); exiting.`,
      );
      process.exit(1);
    },
  });
  const { connectRuntimeDb, queryOne, closeDb } = await import('../db/init.js');
  let primaryError = null;

  try {
    await connectRuntimeDb();
    const { upsertCapturedRecord } = await import('../services/record-store.js');
    const { upsertRecordComments } = await import('../services/comment-workflow.js');

    const tenant = await queryOne('SELECT id, name FROM tenants WHERE id = $1 AND status <> $2', [options.tenantId, 'deleted']);
    if (!tenant) throw new Error(`Target tenant not found or deleted: ${options.tenantId}`);

    const before = {
      records: Number((await queryOne('SELECT COUNT(*) AS n FROM records WHERE tenant_id = $1', [options.tenantId]))?.n || 0),
      comments: Number((await queryOne('SELECT COUNT(*) AS n FROM record_comments WHERE tenant_id = $1', [options.tenantId]))?.n || 0),
    };

    const stats = {
      tenant,
      before,
      total: 0,
      inserted: 0,
      updated: 0,
      commentInserted: 0,
      commentUpdated: 0,
      commentNegative: 0,
      officialResponses: 0,
      failed: 0,
      failures: [],
    };

    outer:
    for (const source of sources) {
      for (const record of source.rows) {
        if (options.limit && stats.total >= options.limit) break outer;
        stats.total += 1;
        try {
          const result = await upsertCapturedRecord(record, {
            tenantId: options.tenantId,
            authCode: options.authCode,
            monitorExecutionId: null,
            localizeMedia: false,
          });
          if (result.action === 'inserted') stats.inserted += 1;
          else if (result.action === 'updated') stats.updated += 1;

          if (!options.skipComments && record._commentItems.length > 0) {
            const commentStats = await upsertRecordComments(result.id, record, {
              tenantId: options.tenantId,
              authCode: options.authCode,
            });
            stats.commentInserted += Number(commentStats.inserted || 0);
            stats.commentUpdated += Number(commentStats.updated || 0);
            stats.commentNegative += Number(commentStats.negative || 0);
            stats.officialResponses += Number(commentStats.officialResponses || 0);
          }
        } catch (err) {
          stats.failed += 1;
          stats.failures.push({
            platform: record.platform,
            externalId: record.external_id,
            url: record.url,
            message: err?.message || String(err),
          });
          console.error(`[ImportCSV] failed ${record.platform} ${record.external_id}: ${err?.message || err}`);
        }

        if (stats.total % 100 === 0) {
          console.log(`[ImportCSV] processed=${stats.total} inserted=${stats.inserted} updated=${stats.updated} failed=${stats.failed}`);
        }
      }
    }

    const after = {
      records: Number((await queryOne('SELECT COUNT(*) AS n FROM records WHERE tenant_id = $1', [options.tenantId]))?.n || 0),
      comments: Number((await queryOne('SELECT COUNT(*) AS n FROM record_comments WHERE tenant_id = $1', [options.tenantId]))?.n || 0),
    };
    stats.after = after;
    return stats;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await closeCsvImportResources({
      closeDatabase: closeDb,
      executionLock,
      primaryError,
    });
  }
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.sources.length) throw new Error(`At least one --source is required.\n${usage()}`);

  const sources = options.sources.map(loadSource);
  printSummary(sources, options);

  if (!options.commit) {
    console.log('[ImportCSV] Dry-run only. Re-run with --commit to write to the database.');
    return;
  }

  const stats = await importRows(sources, options);
  console.log(JSON.stringify(stats, null, 2));
  if (stats.failed > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main().catch(err => {
    console.error(`[ImportCSV] ${err?.stack || err?.message || err}`);
    process.exit(1);
  });
}
