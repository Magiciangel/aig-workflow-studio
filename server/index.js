import 'dotenv/config';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, 'data');
const providersPath = path.join(dataDir, 'providers.json');
const generatedDir = path.join(root, 'generated');
const logsDir = path.join(root, 'logs');
const appLogPath = path.join(logsDir, 'app.log');
const distDir = path.join(root, 'dist');
const app = express();
const port = Number(process.env.PORT || 4177);
const host = process.env.HOST || '127.0.0.1';
const appPassword = process.env.APP_PASSWORD;
const appAuthSecret = process.env.APP_AUTH_SECRET || appPassword || 'local-dev-secret';
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const passwordAuthEnabled = Boolean(appPassword);
const supabaseAuthEnabled = !passwordAuthEnabled && Boolean(supabaseUrl && supabaseServiceRoleKey);
const authMode = passwordAuthEnabled ? 'password' : (supabaseAuthEnabled ? 'supabase' : 'local');
const supabaseAdmin = supabaseAuthEnabled
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

function signPasswordToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', appAuthSecret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyPasswordToken(token) {
  const [body, signature] = String(token || '').split('.');
  if (!body || !signature) return null;
  const expected = crypto.createHmac('sha256', appAuthSecret).update(body).digest('base64url');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload?.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

app.get('/api/auth/status', (_req, res) => {
  res.json({ mode: authMode });
});

app.post('/api/auth/password', (req, res) => {
  if (!passwordAuthEnabled) return res.status(404).json({ error: 'Password login is not enabled.' });
  const password = String(req.body?.password || '');
  const expectedBuffer = Buffer.from(appPassword);
  const actualBuffer = Buffer.from(password);
  const valid = actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
  if (!valid) return res.status(401).json({ error: '密码不对。' });
  const token = signPasswordToken({
    sub: 'shared-password-user',
    exp: Date.now() + 1000 * 60 * 60 * 24 * 30,
  });
  res.json({ token, user: { id: 'shared', email: 'password@aig.local' } });
});

async function requireAuth(req, res, next) {
  if (authMode === 'local') {
    req.user = { id: 'local', email: 'local@aig.local' };
    return next();
  }
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Login required.' });
  if (authMode === 'password') {
    const payload = verifyPasswordToken(token);
    if (!payload) return res.status(401).json({ error: 'Invalid session.' });
    req.user = { id: 'shared', email: 'password@aig.local' };
    return next();
  }
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
    const error = new Error(`${response.status} ${detail}`);
    error.status = response.status;
    error.response = json;
    throw error;
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

function seedanceResolutionForMode(model, _mode, resolution) {
  if (String(model || '').endsWith('-fast') && resolution === '1080p') return '720p';
  return resolution || '720p';
}

function seedanceNeedsUpscale(requestedResolution, actualResolution) {
  return requestedResolution === '1080p' && actualResolution !== '1080p';
}

function normalizeSeedanceMode(mode) {
  return mode || 't2v';
}

function shortText(value, limit = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
}

function shortUrl(value) {
  if (!value) return '';
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return shortText(value, 180);
  }
}

function seedancePayloadSummary(body = {}) {
  return {
    model: body.model,
    mode: body.mode,
    resolution: body.resolution,
    ratio: body.ratio,
    duration: body.duration,
    generateAudio: Boolean(body.generate_audio),
    watermark: Boolean(body.watermark),
    promptPreview: shortText(body.prompt, 160),
    promptChars: String(body.prompt || '').length,
    hasFirstFrame: Boolean(body.first_frame),
    hasLastFrame: Boolean(body.last_frame),
    firstFrame: shortUrl(body.first_frame),
    lastFrame: shortUrl(body.last_frame),
    referenceImageCount: body.reference_images?.length || 0,
    referenceVideoCount: body.reference_videos?.length || 0,
    referenceImages: (body.reference_images || []).map(shortUrl),
    referenceVideos: (body.reference_videos || []).map(shortUrl),
  };
}

function seedanceResponseSummary(value = {}) {
  if (value.raw) return { raw: shortText(value.raw, 500) };
  return {
    taskId: value.task_id || value.id,
    status: value.status,
    error: typeof value.error === 'string' ? value.error : value.error?.message,
    message: value.message,
    outputVideo: shortUrl(value?.output?.content?.video_url),
  };
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

function scaleFilterForRatio(ratio = '16:9') {
  const map = {
    '16:9': 'scale=1920:1080',
    '9:16': 'scale=1080:1920',
    '1:1': 'scale=1080:1080',
    '4:3': 'scale=1440:1080',
    '3:4': 'scale=1080:1440',
    '21:9': 'scale=2520:1080',
  };
  return map[ratio] || 'scale=-2:1080';
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}: ${stderr.slice(-800)}`));
    });
  });
}

function ffmpegCommand() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    return require('@ffmpeg-installer/ffmpeg').path;
  } catch {
    return 'ffmpeg';
  }
}

async function upscaleDownloadedVideo(req, downloaded, ratio) {
  const sourcePath = safeGeneratedPath(req, downloaded.filename);
  const stem = path.basename(downloaded.filename).replace(/\.[^.]+$/, '');
  const targetName = `${stem}-1080p.mp4`;
  const targetPath = safeGeneratedPath(req, targetName);
  try {
    await writeLog('info', 'video_upscale_start', { filename: downloaded.filename, targetName, ratio });
    await runCommand(ffmpegCommand(), [
      '-y',
      '-i', sourcePath,
      '-vf', scaleFilterForRatio(ratio),
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '18',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      targetPath,
    ]);
    const stats = await fs.stat(targetPath);
    await writeLog('info', 'video_upscale_ok', { source: downloaded.filename, filename: targetName, bytes: stats.size });
    return {
      filename: targetName,
      url: `/files/${userId(req)}/${targetName}`,
      upscaledFrom: downloaded,
      resolution: '1080p',
    };
  } catch (error) {
    await writeLog('error', 'video_upscale_failed', { filename: downloaded.filename, error: error.message });
    return { ...downloaded, upscaleError: error.message };
  }
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
  const trace = {
    id: crypto.randomBytes(4).toString('hex'),
    steps: [],
  };
  try {
    const provider = await resolveProvider('seedance', userId(req));
    if (!provider?.apiKey) return res.status(400).json({ error: 'Seedance API key is not configured.', debug: trace });
    const params = req.body || {};
    const model = params.model || 'doubao-seedance-2.0';
    const mode = normalizeSeedanceMode(params.mode || 't2v');
    const requestedResolution = params.resolution || '720p';
    const resolution = seedanceResolutionForMode(model, mode, requestedResolution);
    const payload = {
      model,
      mode,
      prompt: params.prompt || '',
      resolution,
      ratio: params.ratio || '16:9',
      duration: Number(params.duration || 5),
      generate_audio: Boolean(params.generateAudio),
      watermark: Boolean(params.watermark),
    };
    if (params.firstFrame) payload.first_frame = params.firstFrame;
    if (params.lastFrame) payload.last_frame = params.lastFrame;
    if (params.referenceImages) {
      const referenceImages = Array.isArray(params.referenceImages)
        ? params.referenceImages
        : String(params.referenceImages).split('\n').map((item) => item.trim()).filter(Boolean);
      if (referenceImages.length) payload.reference_images = referenceImages;
    }
    if (params.referenceVideos) {
      const referenceVideos = Array.isArray(params.referenceVideos)
        ? params.referenceVideos
        : String(params.referenceVideos).split('\n').map((item) => item.trim()).filter(Boolean);
      if (referenceVideos.length) payload.reference_videos = referenceVideos;
    }
    trace.request = {
      model,
      requestedMode: params.mode || 't2v',
      normalizedMode: mode,
      requestedResolution,
      submitResolution: resolution,
      ratio: payload.ratio,
      duration: payload.duration,
      providerBaseUrl: provider.baseUrl,
      payload: seedancePayloadSummary(payload),
    };
    await writeLog('info', 'seedance_trace_start', { traceId: trace.id, request: trace.request });
    const submitSeedance = async (body, fallbackReason = '') => {
      const url = joinUrl(provider.baseUrl, `/v1/${model}`);
      const step = {
        stage: 'submit',
        method: 'POST',
        url,
        fallbackReason,
        payload: seedancePayloadSummary(body),
      };
      trace.steps.push(step);
      await writeLog('info', 'seedance_submit', {
        traceId: trace.id,
        model,
        mode: body.mode,
        prompt: body.prompt,
        resolution: body.resolution,
        requestedResolution,
        fallbackReason,
        ratio: body.ratio,
        duration: body.duration,
        hasFirstFrame: Boolean(body.first_frame),
        hasLastFrame: Boolean(body.last_frame),
        referenceImageCount: body.reference_images?.length || 0,
        referenceVideoCount: body.reference_videos?.length || 0,
      });
      try {
        const result = await requestJson(provider, `/v1/${model}`, { method: 'POST', body });
        step.status = 'ok';
        step.response = seedanceResponseSummary(result);
        await writeLog('info', 'seedance_trace_submit_ok', { traceId: trace.id, step });
        return result;
      } catch (error) {
        step.status = 'error';
        step.httpStatus = error.status;
        step.error = error.message;
        step.response = seedanceResponseSummary(error.response);
        await writeLog('error', 'seedance_trace_submit_error', { traceId: trace.id, step });
        throw error;
      }
    };
    let submitResolution = payload.resolution;
    let initial;
    try {
      initial = await submitSeedance(payload);
    } catch (error) {
      const canFallbackTo720 = error.status === 405 && requestedResolution === '1080p' && payload.resolution === '1080p';
      if (!canFallbackTo720) throw error;
      await writeLog('info', 'seedance_submit_retry_720p', { model, mode, reason: error.message });
      trace.steps.push({
        stage: 'fallback',
        fromResolution: payload.resolution,
        toResolution: '720p',
        reason: error.message,
      });
      payload.resolution = '720p';
      submitResolution = '720p';
      initial = await submitSeedance(payload, '1080p rejected with 405');
    }
    const taskId = initial.task_id || initial.id;
    if (!taskId) throw new Error('API did not return a task id.');
    trace.taskId = taskId;
    await writeLog('info', 'seedance_task_created', { taskId, initial });
    if (initial.status === 'failed') {
      await writeLog('error', 'seedance_failed', { taskId, result: initial });
      trace.steps.push({ stage: 'initial_status', status: initial.status, response: seedanceResponseSummary(initial) });
      return res.status(502).json({ taskId, status: initial.status, result: initial, error: initial.error || 'Task failed.', debug: trace });
    }

    let result = initial;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      result = await requestJson(provider, `/v1/query/${model}/${taskId}`, { method: 'POST' });
      await writeLog('info', 'seedance_poll', { taskId, attempt: attempt + 1, status: result.status });
      if (attempt === 0 || result.status === 'completed' || result.status === 'succeeded' || result.status === 'failed' || (attempt + 1) % 10 === 0) {
        trace.steps.push({ stage: 'poll', attempt: attempt + 1, status: result.status, response: seedanceResponseSummary(result) });
      }
      if (result.status === 'completed' || result.status === 'succeeded') {
        const videoUrl = result?.output?.content?.video_url;
        let downloaded = videoUrl ? await downloadRemote(req, videoUrl) : null;
        if (downloaded && seedanceNeedsUpscale(requestedResolution, submitResolution)) {
          downloaded = await upscaleDownloadedVideo(req, downloaded, payload.ratio);
        }
        trace.steps.push({
          stage: 'completed',
          videoUrl: shortUrl(videoUrl),
          downloaded,
          upscaled: seedanceNeedsUpscale(requestedResolution, submitResolution),
        });
        await writeLog('info', 'seedance_completed', { taskId, videoUrl, downloaded });
        return res.json({ taskId, status: result.status, result, videoUrl, downloaded, debug: trace });
      }
      if (result.status === 'failed') {
        await writeLog('error', 'seedance_failed', { taskId, result });
        return res.status(502).json({ taskId, status: result.status, result, error: result.error || 'Task failed.', debug: trace });
      }
    }
    await writeLog('error', 'seedance_timeout', { taskId, result });
    trace.steps.push({ stage: 'timeout', response: seedanceResponseSummary(result) });
    res.status(504).json({ taskId, status: 'timeout', result, error: 'Polling timed out.', debug: trace });
  } catch (error) {
    await writeLog('error', 'seedance_error', { traceId: trace.id, error: error.message, debug: trace });
    res.status(500).json({ error: error.message, debug: trace });
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

app.use(express.static(distDir));
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api') || req.path.startsWith('/files')) return next();
  return res.sendFile(path.join(distDir, 'index.html'));
});

app.listen(port, host, () => {
  console.log(`Workflow API listening on http://${host}:${port}`);
  writeLog('info', 'server_started', { host, port }).catch(() => {});
});
