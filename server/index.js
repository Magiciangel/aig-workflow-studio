import 'dotenv/config';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, 'data');
const providersPath = path.join(dataDir, 'providers.json');
const generatedDir = path.join(root, 'generated');
const logsDir = path.join(root, 'logs');
const appLogPath = path.join(logsDir, 'app.log');
const app = express();
const port = Number(process.env.PORT || 4177);
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const authEnabled = Boolean(supabaseUrl && supabaseServiceRoleKey);
const supabaseAdmin = authEnabled
  ? createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  : null;

function safeLogValue(value) {
  if (!value) return value;
  if (typeof value === 'string') return value.replace(/sk-[a-zA-Z0-9_-]+/g, 'sk-***');
  if (Array.isArray(value)) return value.map(safeLogValue);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      if (/key|token|authorization|secret/i.test(key)) return [key, '***'];
      return [key, safeLogValue(entry)];
    }));
  }
  return value;
}

async function writeLog(level, message, meta = {}) {
  await fs.mkdir(logsDir, { recursive: true });
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    meta: safeLogValue(meta),
  };
  await fs.appendFile(appLogPath, `${JSON.stringify(entry)}\n`);
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || /^https?:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

app.use(express.json({ limit: '20mb' }));
app.use('/files', express.static(generatedDir));

app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    writeLog('info', 'http_request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - started,
    }).catch(() => {});
  });
  next();
});

const builtInProviders = [
  {
    id: 'seedance',
    name: 'Seedance Video',
    baseUrl: 'https://vg-api.aig-ai.com',
    authType: 'bearer',
    configured: Boolean(process.env.SEEDANCE_API_KEY),
    lockedKey: Boolean(process.env.SEEDANCE_API_KEY),
  },
];

async function requireAuth(req, res, next) {
  if (!authEnabled) {
    req.user = { id: 'local', email: 'local@aig.local' };
    return next();
  }
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Login required.' });
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ error: 'Invalid session.' });
  req.user = data.user;
  return next();
}

function userId(req) {
  return req.user?.id || 'local';
}

function userGeneratedDir(req) {
  return path.join(generatedDir, userId(req));
}

function safeGeneratedPath(req, filename) {
  return path.join(userGeneratedDir(req), path.basename(filename));
}

app.use('/api', requireAuth);

async function ensureData() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(generatedDir, { recursive: true });
  await fs.mkdir(logsDir, { recursive: true });
  try {
    await fs.access(providersPath);
  } catch {
    await fs.writeFile(providersPath, JSON.stringify({ providers: [] }, null, 2));
  }
}

async function readProviders(ownerId = 'local') {
  await ensureData();
  const raw = await fs.readFile(providersPath, 'utf8');
  const data = JSON.parse(raw || '{"providers":[]}');
  const custom = (Array.isArray(data.providers) ? data.providers : [])
    .filter((provider) => (provider.ownerId || 'local') === ownerId);
  const merged = [
    ...builtInProviders,
    ...custom.map((provider) => ({
      ...provider,
      configured: Boolean(provider.apiKey),
      apiKey: undefined,
    })),
  ];
  return { merged, custom };
}

async function writeProviders(providers) {
  await ensureData();
  await fs.writeFile(providersPath, JSON.stringify({ providers }, null, 2));
}

async function resolveProvider(providerId, ownerId = 'local') {
  const { custom } = await readProviders(ownerId);
  if (providerId === 'seedance') {
    return {
      id: 'seedance',
      name: 'Seedance Video',
      baseUrl: 'https://vg-api.aig-ai.com',
      authType: 'bearer',
      apiKey: process.env.SEEDANCE_API_KEY,
    };
  }
  return custom.find((provider) => provider.id === providerId);
}

function authHeaders(provider) {
  const headers = {};
  if (!provider?.apiKey) return headers;
  if (provider.authType === 'header') {
    headers[provider.headerName || 'Authorization'] = provider.apiKey;
  } else {
    headers.Authorization = `Bearer ${provider.apiKey}`;
  }
  return headers;
}

function joinUrl(baseUrl, routePath) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const route = String(routePath || '').replace(/^\/+/, '');
  return `${base}/${route}`;
}

async function requestJson(provider, routePath, options = {}) {
  const method = options.method || 'POST';
  const headers = {
    'Content-Type': 'application/json',
    ...authHeaders(provider),
    ...(options.headers || {}),
  };
  const url = joinUrl(provider.baseUrl, routePath);
  await writeLog('info', 'api_request_start', {
    providerId: provider.id,
    method,
    url,
    body: options.body,
  });
  const response = await fetch(url, {
    method,
    headers,
    body: method === 'GET' ? undefined : JSON.stringify(options.body || {}),
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!response.ok) {
    const detail = json?.error?.message || json?.message || text || response.statusText;
    await writeLog('error', 'api_request_failed', {
      providerId: provider.id,
      method,
      url,
      status: response.status,
      response: json,
    });
    throw new Error(`${response.status} ${detail}`);
  }
  await writeLog('info', 'api_request_ok', {
    providerId: provider.id,
    method,
    url,
    status: response.status,
    response: json,
  });
  return json;
}

function readPath(obj, selector) {
  if (!selector) return obj;
  return selector.split('.').reduce((current, key) => current?.[key], obj);
}

function extensionFromMime(mimeType) {
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'image/webp') return '.webp';
  if (mimeType === 'image/gif') return '.gif';
  if (mimeType === 'video/mp4') return '.mp4';
  if (mimeType === 'video/webm') return '.webm';
  if (mimeType === 'video/quicktime') return '.mov';
  return '.png';
}

function publicFileUrl(req, localUrl) {
  if (/^https?:\/\//i.test(localUrl)) return localUrl;
  return `${req.protocol}://${req.get('host')}${localUrl}`;
}

function fileKind(filename) {
  if (/\.(png|jpe?g|webp|gif)$/i.test(filename)) return 'image';
  if (/\.(mp4|webm|mov)$/i.test(filename)) return 'video';
  return 'file';
}

async function downloadRemote(req, url) {
  await writeLog('info', 'download_start', { url });
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  const extFromUrl = path.extname(new URL(url).pathname) || '.mp4';
  const filename = `${Date.now()}-${Math.random().toString(16).slice(2)}${extFromUrl}`;
  const targetDir = userGeneratedDir(req);
  await fs.mkdir(targetDir, { recursive: true });
  const filePath = path.join(targetDir, filename);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(filePath, buffer);
  await writeLog('info', 'download_ok', { url, filename, bytes: buffer.length });
  return { filename, url: `/files/${userId(req)}/${filename}` };
}

app.get('/api/providers', async (req, res) => {
  const { merged } = await readProviders(userId(req));
  res.json({ providers: merged });
});

app.get('/api/logs', async (req, res) => {
  try {
    await ensureData();
    const limit = Math.min(Number(req.query.limit || 200), 1000);
    const raw = await fs.readFile(appLogPath, 'utf8').catch(() => '');
    const logs = raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((line) => JSON.parse(line));
    res.json({ logs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/files', async (req, res) => {
  try {
    await ensureData();
    const dir = userGeneratedDir(req);
    await fs.mkdir(dir, { recursive: true });
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = await Promise.all(entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const stats = await fs.stat(path.join(dir, entry.name));
        const url = `/files/${encodeURIComponent(userId(req))}/${encodeURIComponent(entry.name)}`;
        return {
          name: entry.name,
          url,
          absoluteUrl: publicFileUrl(req, url),
          kind: fileKind(entry.name),
          size: stats.size,
          modifiedAt: stats.mtime.toISOString(),
        };
      }));
    files.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
    res.json({ files });
  } catch (error) {
    await writeLog('error', 'files_list_error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/logs', async (_req, res) => {
  try {
    await ensureData();
    await fs.writeFile(appLogPath, '');
    await writeLog('info', 'logs_cleared');
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/providers', async (req, res) => {
  const provider = req.body || {};
  if (!provider.name || !provider.baseUrl) {
    return res.status(400).json({ error: 'Provider name and base URL are required.' });
  }
  const { custom } = await readProviders(userId(req));
  const id = provider.id || provider.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const next = {
    id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    authType: provider.authType || 'bearer',
    headerName: provider.headerName || 'Authorization',
    apiKey: provider.apiKey || '',
    ownerId: userId(req),
  };
  await ensureData();
  const raw = await fs.readFile(providersPath, 'utf8');
  const data = JSON.parse(raw || '{"providers":[]}');
  const allCustom = Array.isArray(data.providers) ? data.providers : [];
  const filtered = allCustom.filter((item) => !((item.ownerId || 'local') === userId(req) && item.id === id));
  await writeProviders([...filtered, next]);
  res.json({ provider: { ...next, apiKey: undefined, configured: Boolean(next.apiKey) } });
});

app.post('/api/uploads/image', async (req, res) => {
  try {
    await ensureData();
    const { dataUrl, filename = 'image' } = req.body || {};
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/i.exec(dataUrl || '');
    if (!match) return res.status(400).json({ error: 'A PNG, JPG, WebP, or GIF data URL is required.' });

    const [, mimeType, base64] = match;
    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length) return res.status(400).json({ error: 'Image file is empty.' });

    const safeBase = path.basename(filename).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-|-$/g, '') || 'image';
    const ext = path.extname(safeBase) || extensionFromMime(mimeType.toLowerCase());
    const stem = safeBase.replace(/\.[^.]+$/, '');
    const savedName = `${Date.now()}-${Math.random().toString(16).slice(2)}-${stem}${ext}`;
    const targetDir = userGeneratedDir(req);
    await fs.mkdir(targetDir, { recursive: true });
    const filePath = path.join(targetDir, savedName);
    await fs.writeFile(filePath, buffer);
    const localUrl = `/files/${userId(req)}/${savedName}`;
    await writeLog('info', 'image_upload_ok', { filename: savedName, bytes: buffer.length, mimeType });
    res.json({ filename: savedName, url: localUrl, absoluteUrl: publicFileUrl(req, localUrl), mimeType, bytes: buffer.length });
  } catch (error) {
    await writeLog('error', 'image_upload_error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/uploads/video', async (req, res) => {
  try {
    await ensureData();
    const { dataUrl, filename = 'video' } = req.body || {};
    const match = /^data:(video\/(?:mp4|webm|quicktime));base64,(.+)$/i.exec(dataUrl || '');
    if (!match) return res.status(400).json({ error: 'An MP4, WebM, or MOV data URL is required.' });

    const [, mimeType, base64] = match;
    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length) return res.status(400).json({ error: 'Video file is empty.' });

    const safeBase = path.basename(filename).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-|-$/g, '') || 'video';
    const ext = path.extname(safeBase) || extensionFromMime(mimeType.toLowerCase());
    const stem = safeBase.replace(/\.[^.]+$/, '');
    const savedName = `${Date.now()}-${Math.random().toString(16).slice(2)}-${stem}${ext}`;
    const targetDir = userGeneratedDir(req);
    await fs.mkdir(targetDir, { recursive: true });
    const filePath = path.join(targetDir, savedName);
    await fs.writeFile(filePath, buffer);
    const localUrl = `/files/${userId(req)}/${savedName}`;
    await writeLog('info', 'video_upload_ok', { filename: savedName, bytes: buffer.length, mimeType });
    res.json({ filename: savedName, url: localUrl, absoluteUrl: publicFileUrl(req, localUrl), mimeType, bytes: buffer.length });
  } catch (error) {
    await writeLog('error', 'video_upload_error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/execute/seedance', async (req, res) => {
  try {
    const provider = await resolveProvider('seedance', userId(req));
    if (!provider?.apiKey) return res.status(400).json({ error: 'Seedance API key is not configured.' });
    const params = req.body || {};
    const model = params.model || 'doubao-seedance-2.0';
    const payload = {
      model,
      mode: params.mode || 't2v',
      prompt: params.prompt || '',
      resolution: params.resolution || '720p',
      ratio: params.ratio || '16:9',
      duration: Number(params.duration || 5),
      generate_audio: Boolean(params.generateAudio),
      watermark: Boolean(params.watermark),
    };
    if (params.firstFrame) payload.first_frame = params.firstFrame;
    if (params.lastFrame) payload.last_frame = params.lastFrame;
    if (params.referenceImages) {
      payload.reference_images = Array.isArray(params.referenceImages)
        ? params.referenceImages
        : String(params.referenceImages).split('\n').map((item) => item.trim()).filter(Boolean);
    }
    if (params.referenceVideos) {
      payload.reference_videos = Array.isArray(params.referenceVideos)
        ? params.referenceVideos
        : String(params.referenceVideos).split('\n').map((item) => item.trim()).filter(Boolean);
    }
    await writeLog('info', 'seedance_submit', {
      model,
      mode: payload.mode,
      prompt: payload.prompt,
      resolution: payload.resolution,
      ratio: payload.ratio,
      duration: payload.duration,
      hasFirstFrame: Boolean(params.firstFrame),
      hasLastFrame: Boolean(params.lastFrame),
      referenceImageCount: payload.reference_images?.length || 0,
      referenceVideoCount: payload.reference_videos?.length || 0,
    });
    const initial = await requestJson(provider, `/v1/${model}`, { method: 'POST', body: payload });
    const taskId = initial.task_id || initial.id;
    if (!taskId) throw new Error('API did not return a task id.');
    await writeLog('info', 'seedance_task_created', { taskId, initial });

    let result = initial;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      result = await requestJson(provider, `/v1/query/${model}/${taskId}`, { method: 'POST' });
      await writeLog('info', 'seedance_poll', { taskId, attempt: attempt + 1, status: result.status });
      if (result.status === 'completed' || result.status === 'succeeded') {
        const videoUrl = result?.output?.content?.video_url;
        const downloaded = videoUrl ? await downloadRemote(req, videoUrl) : null;
        await writeLog('info', 'seedance_completed', { taskId, videoUrl, downloaded });
        return res.json({ taskId, status: result.status, result, videoUrl, downloaded });
      }
      if (result.status === 'failed') {
        await writeLog('error', 'seedance_failed', { taskId, result });
        return res.status(502).json({ taskId, status: result.status, result, error: result.error || 'Task failed.' });
      }
    }
    await writeLog('error', 'seedance_timeout', { taskId, result });
    res.status(504).json({ taskId, status: 'timeout', result, error: 'Polling timed out.' });
  } catch (error) {
    await writeLog('error', 'seedance_error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/execute/request', async (req, res) => {
  try {
    const { providerId, method, path: routePath, body, outputPath } = req.body || {};
    const provider = await resolveProvider(providerId, userId(req));
    if (!provider) return res.status(404).json({ error: 'Provider not found.' });
    const result = await requestJson(provider, routePath, { method: method || 'POST', body: body || {} });
    const output = readPath(result, outputPath);
    res.json({ result, output });
  } catch (error) {
    await writeLog('error', 'generic_api_error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/download', async (req, res) => {
  try {
    const downloaded = await downloadRemote(req, req.body.url);
    res.json(downloaded);
  } catch (error) {
    await writeLog('error', 'download_error', { error: error.message, url: req.body?.url });
    res.status(500).json({ error: error.message });
  }
});

await ensureData();
app.listen(port, '127.0.0.1', () => {
  console.log(`Workflow API listening on http://127.0.0.1:${port}`);
  writeLog('info', 'server_started', { port }).catch(() => {});
});
