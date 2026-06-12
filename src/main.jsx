import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReactFlow, {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  addEdge,
  useEdgesState,
  useNodesState,
} from 'reactflow';
import { Download, Image as ImageIcon, KeyRound, Play, Plus, Save, Upload, Video } from 'lucide-react';
import { createClient } from '@supabase/supabase-js';
import 'reactflow/dist/style.css';
import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:4177';
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabaseClientReady = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
const supabase = supabaseClientReady ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
const passwordTokenKey = 'aig-password-token';

const initialNodes = [
  {
    id: 'prompt-1',
    type: 'prompt',
    position: { x: 80, y: 120 },
    data: { label: 'Prompt', prompt: '海边日落，海浪轻轻拍打沙滩，唯美治愈' },
  },
  {
    id: 'seedance-1',
    type: 'seedance',
    position: { x: 390, y: 90 },
    data: {
      label: 'Seedance Video',
      model: 'doubao-seedance-2.0',
      resolution: '720p',
      ratio: '16:9',
      duration: 5,
      generateAudio: false,
      watermark: false,
      firstFrame: '',
    },
  },
  {
    id: 'preview-1',
    type: 'preview',
    position: { x: 730, y: 130 },
    data: { label: 'Preview', videoUrl: '', downloaded: null },
  },
];

const initialEdges = [
  { id: 'e-prompt-seedance', source: 'prompt-1', target: 'seedance-1' },
  { id: 'e-seedance-preview', source: 'seedance-1', target: 'preview-1' },
];

function NodeShell({ title, children, tone = 'default' }) {
  return (
    <div className={`node-card ${tone}`}>
      <Handle type="target" position={Position.Left} />
      <div className="node-title">{title}</div>
      <div className="node-body">{children}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function PromptNode({ data }) {
  return (
    <NodeShell title="Prompt" tone="prompt">
      <p>{data.prompt || 'Empty prompt'}</p>
    </NodeShell>
  );
}

function SeedanceNode({ data }) {
  const refs = [data.imageRefLabel, data.videoRefLabel].filter(Boolean).join(' · ');
  return (
    <NodeShell title="Seedance Video" tone="video">
      <div className="node-grid">
        <span>Model</span><strong>{data.model?.replace('doubao-', '')}</strong>
        <span>Mode</span><strong>{data.effectiveMode || data.mode || 't2v'}</strong>
        <span>Size</span><strong>{data.resolution} · {data.ratio}</strong>
        <span>Duration</span><strong>{data.duration}s</strong>
        {refs && <><span>Refs</span><strong>{refs}</strong></>}
      </div>
    </NodeShell>
  );
}

function AssetBadge({ number }) {
  if (!number) return null;
  return <span className="asset-badge">#{number}</span>;
}

function AssetName({ data, fallback }) {
  const name = data.originalName || data.filename || data.displayName || fallback;
  return <span className="asset-name">{name}</span>;
}

function imageRoleLabel(role = 'reference') {
  if (role === 'firstFrame') return '首帧';
  if (role === 'lastFrame') return '尾帧';
  return '参考图';
}

function ImageInputNode({ data }) {
  return (
    <NodeShell title="Image Input" tone="image">
      {data.imageUrl ? (
        <div className="asset-preview">
          <AssetBadge number={data.assetNumber} />
          <span className="asset-role">{imageRoleLabel(data.seedanceRole)}</span>
          <img className="node-image" src={apiUrl(data.imageUrl)} alt="" />
          <AssetName data={data} fallback="Image reference" />
        </div>
      ) : <p>Upload an image or paste a URL.</p>}
    </NodeShell>
  );
}

function VideoInputNode({ data }) {
  return (
    <NodeShell title="Video Input" tone="video">
      {data.videoUrl ? (
        <div className="asset-preview">
          <AssetBadge number={data.assetNumber} />
          <video className="node-video" src={apiUrl(data.videoUrl)} muted controls />
          <AssetName data={data} fallback="Video reference" />
        </div>
      ) : <p>Upload a reference video or paste a URL.</p>}
    </NodeShell>
  );
}

function ImageTransformNode({ data }) {
  return (
    <NodeShell title="Image Transform" tone="image">
      <div className="node-grid">
        <span>Provider</span><strong>{data.providerId || 'unset'}</strong>
        <span>Path</span><strong>{data.path || '/'}</strong>
        <span>Output</span><strong>{data.outputPath || 'result'}</strong>
      </div>
    </NodeShell>
  );
}

function ApiNode({ data }) {
  return (
    <NodeShell title="API Request" tone="api">
      <div className="node-grid">
        <span>Provider</span><strong>{data.providerId || 'unset'}</strong>
        <span>Path</span><strong>{data.path || '/'}</strong>
      </div>
    </NodeShell>
  );
}

function PreviewNode({ data }) {
  const mediaType = data.mediaType || mediaTypeFromUrl(data.videoUrl);
  return (
    <NodeShell title="Preview" tone="preview">
      {data.videoUrl && mediaType === 'image' && <img className="node-image" src={data.videoUrl} alt="" />}
      {data.videoUrl && mediaType !== 'image' && <video src={data.videoUrl} muted controls />}
      {!data.videoUrl && <p>Run workflow to see output.</p>}
    </NodeShell>
  );
}

const nodeTypes = {
  prompt: PromptNode,
  imageInput: ImageInputNode,
  videoInput: VideoInputNode,
  imageTransform: ImageTransformNode,
  seedance: SeedanceNode,
  api: ApiNode,
  preview: PreviewNode,
};

function Field({ label, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function mediaTypeFromUrl(url = '') {
  if (/\.(png|jpe?g|webp|gif)(\?|$)/i.test(url)) return 'image';
  return 'video';
}

function apiUrl(url = '') {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/')) return `${API_BASE}${url}`;
  return url;
}

function formatBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function nameFromUrl(url = '') {
  try {
    const parsed = new URL(apiUrl(url));
    return decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || 'Remote asset');
  } catch {
    return url.split('/').filter(Boolean).pop() || 'Remote asset';
  }
}

function seedanceResolutionForMode(mode, resolution) {
  if ((mode === 'i2v_first' || mode === 'i2v_first_last' || mode === 'i2v_reference' || mode === 'multimodal_reference') && resolution === '1080p') return '720p';
  return resolution || '720p';
}

function normalizeSeedanceMode(mode) {
  return mode === 'i2v_reference' ? 'multimodal_reference' : mode;
}

async function readResponseJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 500) || response.statusText || 'Empty response from server.' };
  }
}

function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [selectedId, setSelectedId] = useState('seedance-1');
  const [reactFlowInstance, setReactFlowInstance] = useState(null);
  const [providers, setProviders] = useState([]);
  const [runLog, setRunLog] = useState([]);
  const [serverLogs, setServerLogs] = useState([]);
  const [generatedFiles, setGeneratedFiles] = useState([]);
  const [running, setRunning] = useState(false);
  const [draggingImage, setDraggingImage] = useState(false);
  const [authMode, setAuthMode] = useState('checking');
  const [session, setSession] = useState(null);
  const [passwordToken, setPasswordToken] = useState(() => localStorage.getItem(passwordTokenKey) || '');
  const [authReady, setAuthReady] = useState(false);
  const [authForm, setAuthForm] = useState({ email: '', password: '', mode: 'signin' });
  const [authMessage, setAuthMessage] = useState('');
  const [providerForm, setProviderForm] = useState({
    name: '',
    baseUrl: '',
    authType: 'bearer',
    headerName: 'Authorization',
    apiKey: '',
  });

  const selectedNode = useMemo(() => nodes.find((node) => node.id === selectedId), [nodes, selectedId]);
  const isAuthenticated = authMode === 'local'
    || (authMode === 'password' && Boolean(passwordToken))
    || (authMode === 'supabase' && Boolean(session));

  useEffect(() => {
    fetch(`${API_BASE}/api/auth/status`)
      .then((response) => response.json())
      .then((data) => {
        setAuthMode(data.mode || 'local');
        if (data.mode !== 'supabase') setAuthReady(true);
      })
      .catch(() => {
        setAuthMode('local');
        setAuthReady(true);
      });
  }, []);

  useEffect(() => {
    if (authMode !== 'supabase') return undefined;
    if (!supabase) {
      setAuthMessage('前端没有配置 Supabase 登录参数。');
      setAuthReady(true);
      return undefined;
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    });
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setAuthReady(true);
    });
    return () => subscription.subscription.unsubscribe();
  }, [authMode]);

  const apiFetch = useCallback((path, options = {}) => {
    const headers = {
      ...(options.headers || {}),
    };
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
    if (authMode === 'password' && passwordToken) headers.Authorization = `Bearer ${passwordToken}`;
    return fetch(`${API_BASE}${path}`, { ...options, headers });
  }, [authMode, passwordToken, session]);

  const loadProviders = useCallback(async () => {
    const response = await apiFetch('/api/providers');
    const data = await readResponseJson(response);
    setProviders(data.providers || []);
  }, [apiFetch]);

  const loadServerLogs = useCallback(async () => {
    const response = await apiFetch('/api/logs?limit=120');
    const data = await readResponseJson(response);
    setServerLogs(data.logs || []);
  }, [apiFetch]);

  const loadGeneratedFiles = useCallback(async () => {
    const response = await apiFetch('/api/files');
    const data = await readResponseJson(response);
    setGeneratedFiles(data.files || []);
  }, [apiFetch]);

  useEffect(() => {
    if (!authReady || !isAuthenticated) return;
    loadProviders().catch(() => setRunLog((log) => [...log, 'Provider list failed to load.']));
    loadServerLogs().catch(() => {});
    loadGeneratedFiles().catch(() => {});
  }, [authReady, isAuthenticated, loadProviders, loadServerLogs, loadGeneratedFiles]);

  async function submitAuth(event) {
    event.preventDefault();
    setAuthMessage('');
    if (authMode === 'password') {
      const response = await fetch(`${API_BASE}/api/auth/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: authForm.password }),
      });
      const data = await readResponseJson(response);
      if (!response.ok) {
        setAuthMessage(data.error || '登录失败。');
        return;
      }
      localStorage.setItem(passwordTokenKey, data.token);
      setPasswordToken(data.token);
      setAuthForm((current) => ({ ...current, password: '' }));
      setAuthMessage('登录成功。');
      return;
    }
    const payload = { email: authForm.email, password: authForm.password };
    const result = authForm.mode === 'signup'
      ? await supabase.auth.signUp(payload)
      : await supabase.auth.signInWithPassword(payload);
    if (result.error) {
      setAuthMessage(result.error.message);
      return;
    }
    setAuthMessage(authForm.mode === 'signup' ? '注册成功，请按 Supabase 邮件设置完成确认。' : '登录成功。');
  }

  async function signOut() {
    if (authMode === 'password') {
      localStorage.removeItem(passwordTokenKey);
      setPasswordToken('');
      return;
    }
    await supabase?.auth.signOut();
    setSession(null);
  }

  const onConnect = useCallback((params) => setEdges((eds) => addEdge(params, eds)), [setEdges]);
  const refSignature = useMemo(() => JSON.stringify({
    edges: edges.map((edge) => `${edge.source}->${edge.target}`),
    assets: nodes
      .filter((node) => node.type === 'imageInput' || node.type === 'videoInput' || node.type === 'seedance')
      .map((node) => `${node.id}:${node.data.assetNumber || ''}:${node.data.mode || ''}`),
  }), [edges, nodes]);

  useEffect(() => {
    refreshSeedanceRefLabels();
  }, [refSignature]);

  function patchNode(id, patch) {
    setNodes((items) => items.map((node) => (
      node.id === id ? { ...node, data: { ...node.data, ...patch } } : node
    )));
  }

  function nextAssetNumber() {
    return nodes.reduce((max, node) => Math.max(max, Number(node.data?.assetNumber || 0)), 0) + 1;
  }

  function assetNumberFor(nodeId) {
    const existing = nodes.find((node) => node.id === nodeId)?.data?.assetNumber;
    return existing || nextAssetNumber();
  }

  function addNode(type) {
    const id = `${type}-${Date.now()}`;
    const base = {
      prompt: { label: 'Prompt', prompt: '' },
      imageInput: { label: 'Image Input', imageUrl: '', absoluteUrl: '', filename: '', seedanceRole: 'reference' },
      videoInput: { label: 'Video Input', videoUrl: '', absoluteUrl: '', filename: '' },
      seedance: { label: 'Seedance Video', model: 'doubao-seedance-2.0-fast', mode: 't2v', resolution: '720p', ratio: '16:9', duration: 5, generateAudio: false, watermark: false, firstFrame: '', lastFrame: '', referenceImages: '', referenceVideos: '' },
      imageTransform: {
        label: 'Image Transform',
        providerId: 'seedance',
        method: 'POST',
        path: '/v1/images/edit',
        body: '{\n  "prompt": "{{prompt}}",\n  "image": "{{image}}"\n}',
        outputPath: 'data.0.url',
      },
      api: { label: 'API Request', providerId: 'seedance', method: 'POST', path: '/v1/doubao-seedance-2.0', body: '{\n  "prompt": "{{prompt}}"\n}', outputPath: '' },
      preview: { label: 'Preview', videoUrl: '', downloaded: null },
    };
    setNodes((items) => [...items, { id, type, position: { x: 120 + items.length * 40, y: 120 + items.length * 30 }, data: base[type] }]);
    setSelectedId(id);
  }

  function incomingNodes(targetId) {
    return edges
      .filter((item) => item.target === targetId)
      .map((edge) => nodes.find((node) => node.id === edge.source))
      .filter(Boolean);
  }

  function workflowOrder() {
    const nodeIds = new Set(nodes.map((node) => node.id));
    const indegree = new Map(nodes.map((node) => [node.id, 0]));
    const outgoing = new Map(nodes.map((node) => [node.id, []]));

    for (const edge of edges) {
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
      indegree.set(edge.target, (indegree.get(edge.target) || 0) + 1);
      outgoing.get(edge.source)?.push(edge.target);
    }

    const queue = nodes.filter((node) => (indegree.get(node.id) || 0) === 0).map((node) => node.id);
    const orderedIds = [];
    while (queue.length) {
      const id = queue.shift();
      orderedIds.push(id);
      for (const targetId of outgoing.get(id) || []) {
        indegree.set(targetId, (indegree.get(targetId) || 0) - 1);
        if ((indegree.get(targetId) || 0) === 0) queue.push(targetId);
      }
    }

    if (orderedIds.length !== nodes.length) {
      throw new Error('Workflow has a cycle. Remove the loop before running.');
    }
    return orderedIds.map((id) => nodes.find((node) => node.id === id)).filter(Boolean);
  }

  function runtimeNode(node, runtimeData) {
    return runtimeData.get(node.id) || node;
  }

  function incomingRuntimeNodes(targetId, runtimeData) {
    return edges
      .filter((item) => item.target === targetId)
      .map((edge) => nodes.find((node) => node.id === edge.source))
      .filter(Boolean)
      .map((node) => runtimeNode(node, runtimeData));
  }

  function imageUrlFromNode(node) {
    if (!node) return '';
    if (node.type === 'imageInput') return node.data.absoluteUrl || apiUrl(node.data.imageUrl) || '';
    if (node.type === 'preview' && (node.data.mediaType === 'image' || mediaTypeFromUrl(node.data.videoUrl) === 'image')) {
      return node.data.absoluteUrl || apiUrl(node.data.videoUrl) || '';
    }
    if (node.type === 'imageTransform') return node.data.output || '';
    return '';
  }

  function orderedImageSources(targetId, runtimeData = null) {
    const sources = runtimeData ? incomingRuntimeNodes(targetId, runtimeData) : incomingNodes(targetId);
    return sources
      .map((node, index) => ({ node, index, url: imageUrlFromNode(node), role: node.data?.seedanceRole || 'reference' }))
      .filter((item) => item.url)
      .sort((a, b) => {
        const aNumber = Number(a.node.data?.assetNumber || 0);
        const bNumber = Number(b.node.data?.assetNumber || 0);
        if (aNumber && bNumber && aNumber !== bNumber) return aNumber - bNumber;
        if (aNumber && !bNumber) return -1;
        if (!aNumber && bNumber) return 1;
        return a.index - b.index;
      });
  }

  function seedanceAutoMode(baseMode, imageCount, videoCount, firstFrameCount = 0, lastFrameCount = 0) {
    const normalizedBaseMode = normalizeSeedanceMode(baseMode);
    if (normalizedBaseMode !== 't2v') return normalizedBaseMode;
    if (videoCount) return 'multimodal_reference';
    if (firstFrameCount && lastFrameCount) return 'i2v_first_last';
    if (firstFrameCount) return 'i2v_first';
    if (imageCount) return 'multimodal_reference';
    return 't2v';
  }

  function incomingPrompt(targetId) {
    const source = incomingNodes(targetId).find((node) => node.type === 'prompt' && node.data.prompt);
    return source?.data?.prompt || '';
  }

  function incomingValue(targetId) {
    const source = incomingNodes(targetId).find((node) => node.type !== 'prompt');
    if (!source) return '';
    if (source.type === 'prompt') return source.data.prompt || '';
    if (source.type === 'imageInput') return source.data.absoluteUrl || source.data.imageUrl || '';
    if (source.type === 'videoInput') return source.data.absoluteUrl || apiUrl(source.data.videoUrl) || '';
    if (source.type === 'preview') return apiUrl(source.data.videoUrl) || '';
    return source.data.output ?? apiUrl(source.data.videoUrl) ?? '';
  }

  function incomingImage(targetId) {
    return orderedImageSources(targetId)[0]?.url || '';
  }

  function incomingVideo(targetId) {
    const sources = incomingNodes(targetId);
    const source = sources.find((node) => node.type === 'videoInput')
      || sources.find((node) => node.type === 'preview' && (node.data.mediaType === 'video' || mediaTypeFromUrl(node.data.videoUrl) === 'video'));
    if (!source) return '';
    if (source.type === 'videoInput') return source.data.absoluteUrl || apiUrl(source.data.videoUrl) || '';
    if (source.type === 'preview') return apiUrl(source.data.videoUrl) || '';
    return '';
  }

  function refreshSeedanceRefLabels() {
    setNodes((items) => items.map((node) => {
      if (node.type !== 'seedance') return node;
      const sourceNodes = edges
        .filter((edge) => edge.target === node.id)
        .map((edge) => items.find((source) => source.id === edge.source))
        .filter(Boolean);
      const images = sourceNodes
        .filter((source) => source.type === 'imageInput')
        .sort((a, b) => Number(a.data?.assetNumber || 0) - Number(b.data?.assetNumber || 0));
      const video = sourceNodes.find((source) => source.type === 'videoInput');
      const firstFrame = images.find((image) => image.data.seedanceRole === 'firstFrame');
      const lastFrame = images.find((image) => image.data.seedanceRole === 'lastFrame');
      const references = images.filter((image) => (image.data.seedanceRole || 'reference') === 'reference');
      const imageLabels = [
        ...references.map((image) => `参考图 #${image.data.assetNumber || '?'}`),
        firstFrame ? `首帧 #${firstFrame.data.assetNumber || '?'}` : '',
        lastFrame ? `尾帧 #${lastFrame.data.assetNumber || '?'}` : '',
      ].filter(Boolean);
      const imageRefLabel = imageLabels.join(' · ');
      const videoRefLabel = video?.data?.assetNumber ? `Video #${video.data.assetNumber}` : '';
      const effectiveMode = seedanceAutoMode(node.data.mode || 't2v', images.length, video ? 1 : 0, firstFrame ? 1 : 0, lastFrame ? 1 : 0);
      if (
        node.data.imageRefLabel === imageRefLabel
        && node.data.videoRefLabel === videoRefLabel
        && node.data.effectiveMode === effectiveMode
      ) return node;
      return {
        ...node,
        data: {
          ...node.data,
          imageRefLabel,
          videoRefLabel,
          effectiveMode,
        },
      };
    }));
  }

  function previewTargets(sourceId) {
    return edges
      .filter((edge) => edge.source === sourceId)
      .map((edge) => nodes.find((node) => node.id === edge.target))
      .filter((node) => node?.type === 'preview');
  }

  function renderTemplate(value, vars) {
    return String(value || '').replace(/\{\{\s*(prompt|input|image|video)\s*\}\}/g, (_, key) => vars[key] ?? '');
  }

  async function setPreviewOutput(sourceId, output, onPreviewPatch = patchNode) {
    let videoUrl = typeof output === 'string' ? output : output?.url || output?.video_url || '';
    let mediaType = mediaTypeFromUrl(videoUrl);
    let downloaded = null;
    if (/^https?:\/\//i.test(videoUrl)) {
      const response = await apiFetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: videoUrl }),
      });
      const data = await readResponseJson(response);
      if (response.ok) {
        downloaded = data;
        videoUrl = apiUrl(data.url);
        mediaType = mediaTypeFromUrl(videoUrl);
        loadGeneratedFiles().catch(() => {});
      }
    }
    videoUrl = apiUrl(videoUrl);
    if (!videoUrl) return;
    for (const preview of previewTargets(sourceId)) {
      onPreviewPatch(preview.id, { videoUrl, downloaded, mediaType });
    }
  }

  async function uploadImage(file, nodeId, assetNumber) {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const response = await apiFetch('/api/uploads/image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl, filename: file.name }),
    });
    const data = await readResponseJson(response);
    if (!response.ok) throw new Error(data.error || 'Image upload failed.');
    patchNode(nodeId, {
      imageUrl: data.url,
      absoluteUrl: data.absoluteUrl,
      filename: data.filename,
      originalName: file.name,
      assetNumber: assetNumber || assetNumberFor(nodeId),
      mediaType: 'image',
      output: data.absoluteUrl,
    });
    setRunLog((log) => [...log, `Image uploaded: ${data.filename}`]);
    loadGeneratedFiles().catch(() => {});
  }

  function hasDraggedImages(event) {
    return Array.from(event.dataTransfer?.items || []).some((item) => item.kind === 'file' && item.type.startsWith('image/'));
  }

  function flowPositionFromDrop(event, index = 0) {
    const fallback = { x: event.clientX - 120 + index * 28, y: event.clientY - 80 + index * 28 };
    if (!reactFlowInstance) return fallback;
    const point = { x: event.clientX + index * 28, y: event.clientY + index * 28 };
    if (typeof reactFlowInstance.screenToFlowPosition === 'function') {
      return reactFlowInstance.screenToFlowPosition(point);
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const canvasPoint = {
      x: point.x - bounds.left,
      y: point.y - bounds.top,
    };
    if (typeof reactFlowInstance.project === 'function') {
      return reactFlowInstance.project(canvasPoint);
    }
    return canvasPoint;
  }

  async function dropImagesOnCanvas(event) {
    event.preventDefault();
    setDraggingImage(false);
    const imageFiles = Array.from(event.dataTransfer?.files || []).filter((file) => file.type.startsWith('image/'));
    if (!imageFiles.length) return;
    const firstAssetNumber = nextAssetNumber();
    const createdNodes = imageFiles.map((file, index) => {
      const id = `imageInput-${Date.now()}-${index}`;
      return {
        id,
        type: 'imageInput',
        position: flowPositionFromDrop(event, index),
        data: {
          label: 'Image Input',
          imageUrl: '',
          absoluteUrl: '',
          filename: '',
          originalName: file.name,
          assetNumber: firstAssetNumber + index,
          seedanceRole: 'reference',
        },
        file,
      };
    });
    setNodes((items) => [...items, ...createdNodes.map(({ file: _file, ...node }) => node)]);
    setSelectedId(createdNodes[createdNodes.length - 1].id);
    for (const node of createdNodes) {
      try {
        await uploadImage(node.file, node.id, node.data.assetNumber);
      } catch (error) {
        setRunLog((log) => [...log, `Error: ${error.message}`]);
      }
    }
  }

  async function uploadVideo(file, nodeId) {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const response = await apiFetch('/api/uploads/video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl, filename: file.name }),
    });
    const data = await readResponseJson(response);
    if (!response.ok) throw new Error(data.error || 'Video upload failed.');
    patchNode(nodeId, {
      videoUrl: apiUrl(data.url),
      absoluteUrl: data.absoluteUrl,
      filename: data.filename,
      originalName: file.name,
      assetNumber: assetNumberFor(nodeId),
      mediaType: 'video',
      output: data.absoluteUrl,
    });
    setRunLog((log) => [...log, `Video uploaded: ${data.filename}`]);
    loadGeneratedFiles().catch(() => {});
  }

  async function runWorkflow() {
    setRunning(true);
    setRunLog(['Starting workflow...']);
    try {
      const runtimeData = new Map(nodes.map((node) => [node.id, node]));
      const runNodes = workflowOrder();
      const promptFor = (targetId) => {
        const source = incomingRuntimeNodes(targetId, runtimeData).find((item) => item.type === 'prompt' && item.data.prompt);
        return source?.data?.prompt || '';
      };
      const imageFor = (targetId) => {
        return orderedImageSources(targetId, runtimeData)[0]?.url || '';
      };
      const videoFor = (targetId) => {
        const sources = incomingRuntimeNodes(targetId, runtimeData);
        const source = sources.find((item) => item.type === 'videoInput')
          || sources.find((item) => item.type === 'preview' && (item.data.mediaType === 'video' || mediaTypeFromUrl(item.data.videoUrl) === 'video'));
        if (!source) return '';
        if (source.type === 'videoInput') return source.data.absoluteUrl || apiUrl(source.data.videoUrl) || '';
        return apiUrl(source.data.videoUrl) || '';
      };
      const valueFor = (targetId) => {
        const source = incomingRuntimeNodes(targetId, runtimeData).find((item) => item.type !== 'prompt');
        if (!source) return '';
        if (source.type === 'imageInput') return source.data.absoluteUrl || apiUrl(source.data.imageUrl) || '';
        if (source.type === 'videoInput') return source.data.absoluteUrl || apiUrl(source.data.videoUrl) || '';
        if (source.type === 'preview') return apiUrl(source.data.videoUrl) || '';
        return source.data.output ?? apiUrl(source.data.videoUrl) ?? '';
      };
      const patchRuntimeNode = (id, patch) => {
        const current = runtimeData.get(id) || nodes.find((item) => item.id === id);
        if (!current) return;
        runtimeData.set(id, { ...current, data: { ...current.data, ...patch } });
        patchNode(id, patch);
      };
      const patchPreviewOutputs = (sourceId, patch) => {
        for (const preview of previewTargets(sourceId)) {
          patchRuntimeNode(preview.id, patch);
        }
      };

      for (const node of runNodes) {
        if (node.type === 'seedance') {
          const prompt = promptFor(node.id) || node.data.prompt;
          if (!prompt?.trim()) throw new Error('Seedance node needs a prompt input.');
          const upstreamImageItems = orderedImageSources(node.id, runtimeData);
          const upstreamReferenceImages = upstreamImageItems.filter((item) => item.role === 'reference').map((item) => item.url);
          const upstreamFirstFrame = upstreamImageItems.find((item) => item.role === 'firstFrame')?.url || '';
          const upstreamLastFrame = upstreamImageItems.find((item) => item.role === 'lastFrame')?.url || '';
          const upstreamVideo = videoFor(node.id);
          const manualReferenceImages = String(node.data.referenceImages || '').split('\n').map((item) => item.trim()).filter(Boolean);
          const referenceVideos = [
            ...String(node.data.referenceVideos || '').split('\n').map((item) => item.trim()).filter(Boolean),
            ...(upstreamVideo ? [upstreamVideo] : []),
          ];
          const mode = seedanceAutoMode(node.data.mode || 't2v', upstreamImageItems.length, referenceVideos.length, upstreamFirstFrame ? 1 : 0, upstreamLastFrame ? 1 : 0);
          const resolution = seedanceResolutionForMode(mode, node.data.resolution);
          if (resolution !== node.data.resolution || mode !== node.data.mode) {
            patchRuntimeNode(node.id, { resolution, effectiveMode: mode });
          }
          if (resolution !== node.data.resolution) {
            setRunLog((log) => [...log, `${mode} does not support ${node.data.resolution}; using ${resolution}.`]);
          }
          const referenceImages = (mode === 'i2v_reference' || mode === 'multimodal_reference')
            ? [...manualReferenceImages, ...upstreamReferenceImages]
            : manualReferenceImages;
          const firstFrame = (mode === 'i2v_first' || mode === 'i2v_first_last') ? (node.data.firstFrame || upstreamFirstFrame) : node.data.firstFrame;
          const lastFrame = mode === 'i2v_first_last' ? (node.data.lastFrame || upstreamLastFrame) : node.data.lastFrame;
          if (mode === 'i2v_reference' && referenceImages.length === 0) {
            throw new Error('i2v_reference needs at least one reference image.');
          }
          if (mode === 'i2v_first' && !firstFrame) {
            throw new Error('i2v_first needs one image marked as first frame.');
          }
          if (mode === 'i2v_first_last' && (!firstFrame || !lastFrame)) {
            throw new Error('i2v_first_last needs one image marked as first frame and one image marked as last frame.');
          }
          setRunLog((log) => [...log, `Submitting Seedance task from ${node.id}...`]);
          const response = await apiFetch('/api/execute/seedance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...node.data, prompt, mode, resolution, firstFrame, lastFrame, referenceImages, referenceVideos }),
          });
          const data = await readResponseJson(response);
          if (!response.ok) throw new Error(data.error || 'Seedance request failed.');
          setRunLog((log) => [...log, `Video completed: ${data.taskId}`]);
          patchPreviewOutputs(node.id, { videoUrl: apiUrl(data.downloaded?.url || data.videoUrl), downloaded: data.downloaded, mediaType: 'video' });
        }
        if (node.type === 'api' || node.type === 'imageTransform') {
          setRunLog((log) => [...log, `Calling ${node.type === 'imageTransform' ? 'image' : 'API'} node ${node.id}...`]);
          const input = valueFor(node.id);
          const prompt = promptFor(node.id) || input;
          const image = imageFor(node.id) || input;
          const video = videoFor(node.id) || input;
          const bodyText = renderTemplate(node.data.body || '{}', { input, prompt, image, video });
          let body = {};
          try { body = JSON.parse(bodyText || '{}'); } catch { throw new Error('API node body is not valid JSON.'); }
          const response = await apiFetch('/api/execute/request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...node.data, body }),
          });
          const data = await readResponseJson(response);
          if (!response.ok) throw new Error(data.error || 'API request failed.');
          setRunLog((log) => [...log, `API output: ${JSON.stringify(data.output ?? data.result).slice(0, 180)}`]);
          patchRuntimeNode(node.id, { output: data.output ?? data.result });
          await setPreviewOutput(node.id, data.output ?? data.result, patchRuntimeNode);
        }
      }
    } catch (error) {
      setRunLog((log) => [...log, `Error: ${error.message}`]);
    } finally {
      setRunning(false);
      loadServerLogs().catch(() => {});
      loadGeneratedFiles().catch(() => {});
    }
  }

  async function saveProvider() {
    const response = await apiFetch('/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(providerForm),
    });
    if (response.ok) {
      setProviderForm({ name: '', baseUrl: '', authType: 'bearer', headerName: 'Authorization', apiKey: '' });
      await loadProviders();
      setRunLog((log) => [...log, 'Provider saved.']);
    }
  }

  async function clearServerLogs() {
    await apiFetch('/api/logs', { method: 'DELETE' });
    await loadServerLogs();
  }

  function saveWorkflow() {
    const blob = new Blob([JSON.stringify({ nodes, edges }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'workflow.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function loadWorkflow(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const data = JSON.parse(reader.result);
      setNodes(data.nodes || []);
      setEdges(data.edges || []);
      setSelectedId(data.nodes?.[0]?.id || '');
    };
    reader.readAsText(file);
  }

  if (!authReady) {
    return <div className="auth-page"><div className="auth-card"><p>正在检查登录状态...</p></div></div>;
  }

  if (authMode === 'password' && !passwordToken) {
    return (
      <div className="auth-page">
        <form className="auth-card" onSubmit={submitAuth}>
          <div className="brand"><Video size={22} /> Workflow Studio</div>
          <h1>输入访问密码</h1>
          <Field label="Password">
            <input type="password" value={authForm.password} onChange={(e) => setAuthForm({ ...authForm, password: e.target.value })} required autoFocus />
          </Field>
          {authMessage && <p className="auth-message">{authMessage}</p>}
          <button type="submit">进入工作台</button>
        </form>
      </div>
    );
  }

  if (authMode === 'supabase' && !session) {
    return (
      <div className="auth-page">
        <form className="auth-card" onSubmit={submitAuth}>
          <div className="brand"><Video size={22} /> Workflow Studio</div>
          <h1>{authForm.mode === 'signup' ? '注册账号' : '登录账号'}</h1>
          <Field label="Email">
            <input type="email" value={authForm.email} onChange={(e) => setAuthForm({ ...authForm, email: e.target.value })} required />
          </Field>
          <Field label="Password">
            <input type="password" minLength="6" value={authForm.password} onChange={(e) => setAuthForm({ ...authForm, password: e.target.value })} required />
          </Field>
          {authMessage && <p className="auth-message">{authMessage}</p>}
          <button type="submit">{authForm.mode === 'signup' ? '注册' : '登录'}</button>
          <button type="button" onClick={() => setAuthForm({ ...authForm, mode: authForm.mode === 'signup' ? 'signin' : 'signup' })}>
            {authForm.mode === 'signup' ? '已有账号，去登录' : '没有账号，去注册'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="app">
      <aside className="sidebar left">
        <div className="brand"><Video size={22} /> Workflow Studio</div>
        <div className="account-box">
          <strong>{authMode === 'password' ? 'Password mode' : (session?.user?.email || 'Local mode')}</strong>
          {authMode === 'password' && <button onClick={signOut}>退出登录</button>}
          {authMode === 'supabase' && <button onClick={signOut}>退出登录</button>}
          {authMode === 'local' && <span>本地模式，未开启登录。</span>}
        </div>
        <button onClick={() => addNode('prompt')}><Plus size={16} /> Prompt</button>
        <button onClick={() => addNode('imageInput')}><Plus size={16} /> Image Input</button>
        <button onClick={() => addNode('videoInput')}><Plus size={16} /> Video Input</button>
        <button onClick={() => addNode('imageTransform')}><Plus size={16} /> Image Transform</button>
        <button onClick={() => addNode('seedance')}><Plus size={16} /> Seedance Video</button>
        <button onClick={() => addNode('api')}><Plus size={16} /> API Request</button>
        <button onClick={() => addNode('preview')}><Plus size={16} /> Preview</button>
        <div className="divider" />
        <button onClick={runWorkflow} disabled={running}><Play size={16} /> {running ? 'Running...' : 'Run'}</button>
        <button onClick={saveWorkflow}><Save size={16} /> Save Workflow</button>
        <label className="file-button"><Upload size={16} /> Load Workflow<input type="file" accept="application/json" onChange={(e) => e.target.files?.[0] && loadWorkflow(e.target.files[0])} /></label>
        <div className="providers">
          <h3><KeyRound size={16} /> Providers</h3>
          {providers.map((provider) => (
            <div className="provider" key={provider.id}>
              <strong>{provider.name}</strong>
              <span>{provider.configured ? 'configured' : 'missing key'}</span>
            </div>
          ))}
        </div>
      </aside>

      <main
        className={`canvas ${draggingImage ? 'dragging-image' : ''}`}
        onDragEnter={(event) => {
          if (!hasDraggedImages(event)) return;
          event.preventDefault();
          setDraggingImage(true);
        }}
        onDragOver={(event) => {
          if (!hasDraggedImages(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          setDraggingImage(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget)) return;
          setDraggingImage(false);
        }}
        onDrop={dropImagesOnCanvas}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={(_, node) => setSelectedId(node.id)}
          onInit={setReactFlowInstance}
          fitView
        >
          <Background gap={22} size={1} />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
        {draggingImage && <div className="drop-overlay">松开鼠标上传图片</div>}
      </main>

      <aside className="sidebar right">
        <section>
          <h2>Node</h2>
          {!selectedNode && <p>Select a node.</p>}
          {selectedNode?.type === 'prompt' && (
            <Field label="Prompt">
              <textarea value={selectedNode.data.prompt} onChange={(e) => patchNode(selectedNode.id, { prompt: e.target.value })} />
            </Field>
          )}
          {selectedNode?.type === 'imageInput' && (
            <>
              <label className="file-button"><ImageIcon size={16} /> Upload Image<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => e.target.files?.[0] && uploadImage(e.target.files[0], selectedNode.id).catch((error) => setRunLog((log) => [...log, `Error: ${error.message}`]))} /></label>
              <Field label="Seedance 用途">
                <select value={selectedNode.data.seedanceRole || 'reference'} onChange={(e) => patchNode(selectedNode.id, { seedanceRole: e.target.value })}>
                  <option value="reference">参考图</option>
                  <option value="firstFrame">首帧</option>
                  <option value="lastFrame">尾帧</option>
                </select>
              </Field>
              <Field label="Image URL">
                <input value={selectedNode.data.absoluteUrl || selectedNode.data.imageUrl || ''} onChange={(e) => patchNode(selectedNode.id, { imageUrl: e.target.value, absoluteUrl: e.target.value, output: e.target.value, displayName: nameFromUrl(e.target.value), assetNumber: selectedNode.data.assetNumber || nextAssetNumber(), seedanceRole: selectedNode.data.seedanceRole || 'reference' })} placeholder="https://..." />
              </Field>
              {(selectedNode.data.imageUrl || selectedNode.data.absoluteUrl) && (
                <div className="panel-asset">
                  <AssetBadge number={selectedNode.data.assetNumber} />
                  <span className="asset-role">{imageRoleLabel(selectedNode.data.seedanceRole)}</span>
                  <img className="panel-preview" src={apiUrl(selectedNode.data.imageUrl || selectedNode.data.absoluteUrl)} alt="" />
                  <AssetName data={selectedNode.data} fallback="Image reference" />
                </div>
              )}
            </>
          )}
          {selectedNode?.type === 'videoInput' && (
            <>
              <label className="file-button"><Video size={16} /> Upload Video<input type="file" accept="video/mp4,video/webm,video/quicktime" onChange={(e) => e.target.files?.[0] && uploadVideo(e.target.files[0], selectedNode.id).catch((error) => setRunLog((log) => [...log, `Error: ${error.message}`]))} /></label>
              <Field label="Video URL">
                <input value={selectedNode.data.absoluteUrl || selectedNode.data.videoUrl || ''} onChange={(e) => patchNode(selectedNode.id, { videoUrl: e.target.value, absoluteUrl: e.target.value, output: e.target.value, mediaType: 'video', displayName: nameFromUrl(e.target.value), assetNumber: selectedNode.data.assetNumber || nextAssetNumber() })} placeholder="https://..." />
              </Field>
              <p className="hint">Seedance needs a public video URL. Local uploads are saved for preview and workflow wiring.</p>
              {(selectedNode.data.videoUrl || selectedNode.data.absoluteUrl) && (
                <div className="panel-asset">
                  <AssetBadge number={selectedNode.data.assetNumber} />
                  <video className="panel-preview" src={apiUrl(selectedNode.data.videoUrl || selectedNode.data.absoluteUrl)} muted controls />
                  <AssetName data={selectedNode.data} fallback="Video reference" />
                </div>
              )}
            </>
          )}
          {selectedNode?.type === 'seedance' && (
            <>
              <Field label="Model">
                <select value={selectedNode.data.model} onChange={(e) => patchNode(selectedNode.id, { model: e.target.value })}>
                  <option value="doubao-seedance-2.0">doubao-seedance-2.0</option>
                  <option value="doubao-seedance-2.0-fast">doubao-seedance-2.0-fast</option>
                </select>
              </Field>
              <Field label="Mode">
                <select value={normalizeSeedanceMode(selectedNode.data.mode || 't2v')} onChange={(e) => {
                  const mode = normalizeSeedanceMode(e.target.value);
                  patchNode(selectedNode.id, {
                    mode,
                    resolution: seedanceResolutionForMode(mode, selectedNode.data.resolution),
                  });
                }}>
                  <option value="t2v">t2v</option>
                  <option value="i2v_first">i2v_first</option>
                  <option value="i2v_first_last">i2v_first_last</option>
                  <option value="multimodal_reference">multimodal_reference</option>
                </select>
              </Field>
              <Field label="First frame URL">
                <input value={selectedNode.data.firstFrame || ''} onChange={(e) => patchNode(selectedNode.id, { firstFrame: e.target.value })} placeholder="optional image URL or upstream Image Input" />
              </Field>
              <Field label="Last frame URL"><input value={selectedNode.data.lastFrame || ''} onChange={(e) => patchNode(selectedNode.id, { lastFrame: e.target.value })} placeholder="for i2v_first_last" /></Field>
              <Field label="Reference images"><textarea value={selectedNode.data.referenceImages || ''} onChange={(e) => patchNode(selectedNode.id, { referenceImages: e.target.value })} placeholder="one image URL per line" /></Field>
              <Field label="Reference videos"><textarea value={selectedNode.data.referenceVideos || ''} onChange={(e) => patchNode(selectedNode.id, { referenceVideos: e.target.value })} placeholder="one public video URL per line, or connect Video Input" /></Field>
              <div className="two">
                <Field label="Resolution"><select value={seedanceResolutionForMode(normalizeSeedanceMode(selectedNode.data.mode), selectedNode.data.resolution)} onChange={(e) => patchNode(selectedNode.id, { resolution: seedanceResolutionForMode(normalizeSeedanceMode(selectedNode.data.mode), e.target.value) })}><option>480p</option><option>720p</option>{!['i2v_first', 'i2v_first_last', 'i2v_reference', 'multimodal_reference'].includes(normalizeSeedanceMode(selectedNode.data.mode)) && <option>1080p</option>}</select></Field>
                <Field label="Ratio"><select value={selectedNode.data.ratio} onChange={(e) => patchNode(selectedNode.id, { ratio: e.target.value })}><option>16:9</option><option>9:16</option><option>1:1</option><option>4:3</option><option>3:4</option><option>21:9</option><option>adaptive</option></select></Field>
              </div>
              <Field label="Duration"><input type="number" min="4" max="15" value={selectedNode.data.duration} onChange={(e) => patchNode(selectedNode.id, { duration: Number(e.target.value) })} /></Field>
              <label className="check"><input type="checkbox" checked={selectedNode.data.generateAudio} onChange={(e) => patchNode(selectedNode.id, { generateAudio: e.target.checked })} /> Generate audio</label>
              <label className="check"><input type="checkbox" checked={selectedNode.data.watermark} onChange={(e) => patchNode(selectedNode.id, { watermark: e.target.checked })} /> Watermark</label>
            </>
          )}
          {selectedNode?.type === 'imageTransform' && (
            <>
              <Field label="Provider">
                <select value={selectedNode.data.providerId} onChange={(e) => patchNode(selectedNode.id, { providerId: e.target.value })}>
                  {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
                </select>
              </Field>
              <Field label="Method"><select value={selectedNode.data.method} onChange={(e) => patchNode(selectedNode.id, { method: e.target.value })}><option>POST</option><option>GET</option><option>PATCH</option></select></Field>
              <Field label="Path"><input value={selectedNode.data.path} onChange={(e) => patchNode(selectedNode.id, { path: e.target.value })} /></Field>
              <Field label="Body JSON"><textarea value={selectedNode.data.body} onChange={(e) => patchNode(selectedNode.id, { body: e.target.value })} /></Field>
              <p className="hint">Use {'{{prompt}}'}, {'{{input}}'}, {'{{image}}'}, or {'{{video}}'}.</p>
              <Field label="Output path"><input value={selectedNode.data.outputPath} onChange={(e) => patchNode(selectedNode.id, { outputPath: e.target.value })} placeholder="data.0.url" /></Field>
            </>
          )}
          {selectedNode?.type === 'api' && (
            <>
              <Field label="Provider">
                <select value={selectedNode.data.providerId} onChange={(e) => patchNode(selectedNode.id, { providerId: e.target.value })}>
                  {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
                </select>
              </Field>
              <Field label="Method"><select value={selectedNode.data.method} onChange={(e) => patchNode(selectedNode.id, { method: e.target.value })}><option>POST</option><option>GET</option><option>PATCH</option></select></Field>
              <Field label="Path"><input value={selectedNode.data.path} onChange={(e) => patchNode(selectedNode.id, { path: e.target.value })} /></Field>
              <Field label="Body JSON"><textarea value={selectedNode.data.body} onChange={(e) => patchNode(selectedNode.id, { body: e.target.value })} /></Field>
              <p className="hint">Use {'{{prompt}}'}, {'{{input}}'}, {'{{image}}'}, or {'{{video}}'} for upstream values.</p>
              <Field label="Output path"><input value={selectedNode.data.outputPath} onChange={(e) => patchNode(selectedNode.id, { outputPath: e.target.value })} placeholder="output.content.video_url" /></Field>
            </>
          )}
          {selectedNode?.type === 'preview' && selectedNode.data.videoUrl && (
            <a className="download" href={selectedNode.data.videoUrl} download><Download size={16} /> Download result</a>
          )}
        </section>

        <section>
          <h2>Add Provider</h2>
          <Field label="Name"><input value={providerForm.name} onChange={(e) => setProviderForm({ ...providerForm, name: e.target.value })} /></Field>
          <Field label="Base URL"><input value={providerForm.baseUrl} onChange={(e) => setProviderForm({ ...providerForm, baseUrl: e.target.value })} /></Field>
          <Field label="API Key"><input type="password" value={providerForm.apiKey} onChange={(e) => setProviderForm({ ...providerForm, apiKey: e.target.value })} /></Field>
          <button className="wide" onClick={saveProvider}>Save Provider</button>
        </section>

        <section>
          <h2>Generated Files</h2>
          <button onClick={loadGeneratedFiles}>Refresh Files</button>
          <div className="file-list">
            {generatedFiles.length === 0 && <p className="empty">No generated files yet.</p>}
            {generatedFiles.map((file) => (
              <div className="file-row" key={file.name}>
                <div>
                  <strong>{file.name}</strong>
                  <span>{file.kind} · {formatBytes(file.size)} · {new Date(file.modifiedAt).toLocaleString()}</span>
                </div>
                <a className="file-link" href={apiUrl(file.url)} download={file.name}><Download size={14} /> Download</a>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2>Run Log</h2>
          <div className="log">{runLog.map((line, index) => <p key={`${line}-${index}`}>{line}</p>)}</div>
        </section>

        <section>
          <h2>Server Log</h2>
          <div className="toolbar-row">
            <button onClick={loadServerLogs}>Refresh Logs</button>
            <button onClick={clearServerLogs}>Clear Logs</button>
          </div>
          <div className="log server-log">
            {serverLogs.map((entry, index) => (
              <p key={`${entry.ts}-${entry.message}-${index}`}>
                <span className={`level ${entry.level}`}>{entry.level}</span>
                {' '}
                <span>{new Date(entry.ts).toLocaleTimeString()}</span>
                {' '}
                <strong>{entry.message}</strong>
                {' '}
                <span>{JSON.stringify(entry.meta)}</span>
              </p>
            ))}
          </div>
        </section>
      </aside>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
