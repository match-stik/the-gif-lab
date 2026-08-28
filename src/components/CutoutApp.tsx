// Copyright 2026 match-stik. Licensed under the Apache License 2.0.
// Cutout — single-image background removal, and a still exporter that respects
// a size budget without wrecking the picture.
//
// Deliberately not the GIF pipeline. A PNG with alpha has no palette limit, so
// none of GIF Lab's lossy ladder belongs here: fit the dimensions, save at full
// color, and only reduce colors if the file is genuinely over a cap.

import { type MouseEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Brush, Check, Crop, Download, Eraser, ImageUp, Loader2, Pipette, RotateCcw, TriangleAlert, Undo2, X } from 'lucide-react';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';
import { apiFetch } from '../lib/api';
import { saveHref } from '../lib/download';

interface CutoutAppProps {
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  active?: boolean;
}

interface ExportPreset {
  id: string;
  label: string;
  hint: string;
  maxSide: number;
  maxBytes: number;
  padSquare: boolean;
}

// Discord's actual limits, which are the reason this tab has presets at all.
const PRESETS: ExportPreset[] = [
  { id: 'emoji', label: 'Emoji', hint: '128 px · 256 KB', maxSide: 128, maxBytes: 262_144, padSquare: false },
  { id: 'sticker', label: 'Sticker', hint: '320×320 · 512 KB', maxSide: 320, maxBytes: 524_288, padSquare: true },
  { id: 'full', label: 'Full size', hint: 'untouched', maxSide: 0, maxBytes: 0, padSquare: false },
];

/** Diameter of the magnifier that follows the brush, in screen pixels. */
const LOUPE = 104;

interface Stroke {
  tool: 'restore' | 'erase';
  /** Brush width in the image's own pixels, so replay is resolution-independent. */
  width: number;
  points: Array<{ x: number; y: number }>;
}

// Where the cutout session is remembered between visits. The pictures themselves
// stay on the server; this is only the way back to them.
const CUTOUT_SESSION_KEY = 'gif-lab.cutout.session';

interface BatchItem {
  sessionId: string;
  filename: string;
  name: string;
  url: string;
  cut: boolean;
  error?: string;
}

interface ExportResult {
  url: string;
  filename: string;
  bytes?: number;
  width?: number;
  height?: number;
  colors?: number | null;
  withinBudget?: boolean;
}

function readableSize(bytes?: number): string {
  if (!bytes) return '';
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(2)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

export function CutoutApp({ themeConfig, themeMode, active = true }: CutoutAppProps) {
  const colors = themeConfig[themeMode];
  const fileInput = useRef<HTMLInputElement>(null);

  const [engine, setEngine] = useState<{ ready: boolean; model: string | null; reason: string | null } | null>(null);
  const [sessionId, setSessionId] = useState('');
  const [filename, setFilename] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [cut, setCut] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const [mode, setMode] = useState<'subject' | 'color'>('color');
  const [feather, setFeather] = useState(1);
  const [hardEdge, setHardEdge] = useState(false);
  const [keyColour, setKeyColour] = useState('#00FF00');
  const [tolerance, setTolerance] = useState(0.3);
  const [softness, setSoftness] = useState(0.1);
  const [greenScreen, setGreenScreen] = useState(false);
  const [picking, setPicking] = useState(false);
  // Painting. Strokes are kept as data rather than baked into a canvas, so undo
  // is exact and the same strokes can be replayed at full resolution on apply.
  const [painting, setPainting] = useState(false);
  const [tool, setTool] = useState<'restore' | 'erase'>('restore');
  const [brush, setBrush] = useState(28);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const strokeRef = useRef<Stroke | null>(null);
  const paintCanvas = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  // Zoom and pan are a pure view transform on the wrapper. Everything that maps
  // between screen and image pixels reads the live bounding rect, which is
  // already post-transform, so none of the stroke maths changes with zoom.
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  // A finger covers the thing it is painting, so mirror the spot under it into
  // a loupe pinned to the opposite corner.
  const [loupe, setLoupe] = useState<{ x: number; y: number; scale: number; side: 'left' | 'right' } | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ dist: number; zoom: number; cx: number; cy: number; pan: { x: number; y: number } } | null>(null);

  const [preset, setPreset] = useState('sticker');
  const [format, setFormat] = useState<'png' | 'webp'>('png');
  const [result, setResult] = useState<ExportResult | null>(null);

  // BATCH. Her ask: pick a set that share a background, key them all in one pass,
  // get the individual cutouts back underneath. Everything after the first file is
  // queued here; the first one loads into the editor above so she can sample the
  // color on a real picture, then one button keys the rest with that same color.
  // Sample once rather than per image — a batch normally comes out of a single
  // generation — and any one that comes out wrong can be re-keyed on its own.
  const [batch, setBatch] = useState<BatchItem[]>([]);
  const [batchBusy, setBatchBusy] = useState('');

  // CROP. The endpoint has existed since the GIF Lab and cuts with ffmpeg; the only
  // missing half was the part you touch. It crops EVERY frame in the session with one
  // box, which is right for a matched set out of the same generator and wrong to hide,
  // so the button says so when there is a batch. Box is held in the image's own pixels,
  // never in screen pixels, so zoom and pan cannot drift it.
  const [cropping, setCropping] = useState(false);
  const [crop, setCrop] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const cropDrag = useRef<'new' | 'nw' | 'ne' | 'sw' | 'se' | null>(null);
  const cropAnchor = useRef<{ x: number; y: number } | null>(null);
  const [restored, setRestored] = useState(false);

  // Ask once whether the local model is installed; the answer carries its own
  // setup instructions so an install without it says why rather than failing.
  useEffect(() => {
    if (!active || engine) return;
    (async () => {
      try {
        const res = await apiFetch('/api/gif/cutout/status');
        const data = res.ok ? await res.json().catch(() => null) : null;
        setEngine(data && typeof data.ready === 'boolean'
          ? data
          : { ready: false, model: null, reason: 'Background removal is unavailable on this server.' });
      } catch {
        setEngine({ ready: false, model: null, reason: 'Could not reach the server.' });
      }
    })();
  }, [active, engine]);

  // Returns where the file landed, so the batch can carry it as its own first tile
  // rather than uploading the same picture twice.
  const pickImage = useCallback(async (file: File): Promise<{ sessionId: string; filename: string; url: string } | null> => {
    setError('');
    setResult(null);
    setCut(false);
    setBusy('Uploading…');
    try {
      const body = new FormData();
      body.append('file', file);
      const res = await apiFetch('/api/gif/upload-frame', { method: 'POST', body });
      const data = res.ok ? await res.json().catch(() => null) : null;
      if (!data?.frame?.filename) throw new Error('Upload failed');
      setSessionId(data.sessionId);
      setFilename(data.frame.filename);
      setImageUrl(`${data.frame.url}?t=${Date.now()}`);
      return { sessionId: data.sessionId as string, filename: data.frame.filename as string, url: data.frame.url as string };
    } catch (err: any) {
      setError(err?.message || 'Upload failed');
      return null;
    } finally {
      setBusy('');
    }
  }, []);

  const removeBackground = useCallback(async () => {
    if (!sessionId || !filename) return;
    setError('');
    setResult(null);
    setBusy('Finding the subject…');
    try {
      const res = await apiFetch(`/api/gif/cutout/${sessionId}/${filename}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 0.15, not 0.5: the point of the toggle is to keep everything the
        // model saw at all, including fabric it was only half sure about.
        body: JSON.stringify({ feather, threshold: hardEdge ? 0.15 : undefined }),
      });
      const data = res.ok ? await res.json().catch(() => null) : await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Background removal failed');
      setImageUrl(data.url);
      setCut(true);
    } catch (err: any) {
      setError(err?.message || 'Background removal failed');
    } finally {
      setBusy('');
    }
  }, [sessionId, filename, feather, hardEdge]);

  const revert = useCallback(async () => {
    if (!sessionId || !filename) return;
    setBusy('Putting it back…');
    try {
      const res = await apiFetch(`/api/gif/cutout/${sessionId}/${filename}/revert`, { method: 'POST' });
      const data = res.ok ? await res.json().catch(() => null) : null;
      if (data?.url) {
        setImageUrl(data.url);
        setCut(false);
        setResult(null);
        // The editor's picture IS the first tile in the grid — same session, same
        // file. Reverting put the background back on disk, and the tile went on
        // showing the cutout, so tapping it downloaded a green image that nothing on
        // screen said had come back. What it shows and what it hands over must be
        // the same thing.
        setBatch((current) => current.map((b) =>
          b.sessionId === sessionId && b.filename === filename
            ? { ...b, url: `${data.url}${data.url.includes('?') ? '&' : '?'}t=${Date.now()}`, cut: false, error: undefined }
            : b));
      }
    } finally {
      setBusy('');
    }
  }, [sessionId, filename]);

  const keyColourOut = useCallback(async () => {
    if (!sessionId || !filename) return;
    setError('');
    setResult(null);
    setBusy('Keying the color…');
    try {
      const res = await apiFetch(`/api/gif/chroma-key/${sessionId}/${filename}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          color: keyColour,
          tolerance,
          blend: softness,
          mode: greenScreen ? 'chroma' : 'color',
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Color key failed');
      const keyed = data?.url || `/api/gif/frame/${sessionId}/${filename}?t=${Date.now()}`;
      setImageUrl(keyed);
      setCut(true);
      // The picture in the editor is also the first tile in the grid, so finishing it
      // here finishes it there — she should never have to key the same one twice.
      setBatch((current) => current.map((b) =>
        b.sessionId === sessionId && b.filename === filename
          ? { ...b, url: `${keyed}${keyed.includes('?') ? '&' : '?'}t=${Date.now()}`, cut: true, error: undefined }
          : b));
    } catch (err: any) {
      setError(err?.message || 'Color key failed');
    } finally {
      setBusy('');
    }
  }, [sessionId, filename, keyColour, tolerance, softness, greenScreen]);

  /** Upload everything after the first file into the SAME session — upload-frame
   *  takes an optional sessionId and numbers the frames itself, so a batch is one
   *  session with N frames rather than N sessions to keep track of. */
  // SURVIVES LEAVING THE APP, the way the GIF Lab does. The GIF Lab needs IndexedDB
  // because it holds actual frames; every picture here lives on the server under its
  // session id, so all this has to remember is the pointers and the color settings —
  // small enough for localStorage and far simpler than a database.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(CUTOUT_SESSION_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved?.sessionId && saved?.filename) {
          setSessionId(saved.sessionId);
          setFilename(saved.filename);
          setImageUrl(saved.imageUrl || '');
          setCut(!!saved.cut);
          setBatch(Array.isArray(saved.batch) ? saved.batch : []);
          if (saved.keyColour) setKeyColour(saved.keyColour);
          if (typeof saved.tolerance === 'number') setTolerance(saved.tolerance);
          if (typeof saved.softness === 'number') setSoftness(saved.softness);
          if (typeof saved.greenScreen === 'boolean') setGreenScreen(saved.greenScreen);
          if (saved.mode) setMode(saved.mode);
        }
      }
    } catch {
      // A private webview can refuse storage; the app still works, it just forgets.
    }
    setRestored(true);
  }, []);

  useEffect(() => {
    // Not before the restore has run, or an empty first render wipes what was saved.
    if (!restored) return;
    try {
      if (!sessionId) {
        window.localStorage.removeItem(CUTOUT_SESSION_KEY);
        return;
      }
      window.localStorage.setItem(CUTOUT_SESSION_KEY, JSON.stringify({
        sessionId, filename, imageUrl, cut, batch,
        keyColour, tolerance, softness, greenScreen, mode,
      }));
    } catch {
      // Same again — losing the memory is not worth losing the session over.
    }
  }, [restored, sessionId, filename, imageUrl, cut, batch, keyColour, tolerance, softness, greenScreen, mode]);

  const queueBatch = useCallback(async (
    files: File[],
    first: { sessionId: string; filename: string; url: string },
  ) => {
    // files[0] is already uploaded — it is the one in the editor. It still belongs in
    // the grid so the count matches what she picked; it just must not upload twice.
    const queued: BatchItem[] = [{
      sessionId: first.sessionId,
      filename: first.filename,
      name: files[0].name,
      url: `${first.url}?t=${Date.now()}`,
      cut: false,
    }];
    setBatch(queued);
    if (files.length === 1) return;
    setBatchBusy(`Uploading ${files.length - 1}…`);
    try {
      for (const file of files.slice(1)) {
        const body = new FormData();
        body.append('file', file);
        body.append('sessionId', first.sessionId);
        const res = await apiFetch('/api/gif/upload-frame', { method: 'POST', body });
        const data = res.ok ? await res.json().catch(() => null) : null;
        if (!data?.frame?.filename) continue;
        queued.push({
          sessionId: data.sessionId,
          filename: data.frame.filename,
          name: file.name,
          url: `${data.frame.url}?t=${Date.now()}`,
          cut: false,
        });
      }
      setBatch(queued);
    } finally {
      setBatchBusy('');
    }
  }, []);

  /** Put every tile back to the picture that came in. Without this a batch keyed with
   *  the wrong color is unrecoverable without re-picking all of them — reverting the
   *  editor only ever touched its own frame. */
  const revertBatch = useCallback(async () => {
    if (!batch.length) return;
    setError('');
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      setBatchBusy(`Putting back ${i + 1} of ${batch.length}…`);
      try {
        const res = await apiFetch(`/api/gif/cutout/${item.sessionId}/${item.filename}/revert`, { method: 'POST' });
        const data = res.ok ? await res.json().catch(() => null) : null;
        const url = data?.url || `/api/gif/frame/${item.sessionId}/${item.filename}?t=${Date.now()}`;
        setBatch((current) => current.map((b, idx) =>
          idx === i ? { ...b, url: `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, cut: false, error: undefined } : b));
        // Keep the editor in step if this is the picture it is holding.
        if (item.sessionId === sessionId && item.filename === filename) {
          setImageUrl(url);
          setCut(false);
          setResult(null);
        }
      } catch {
        // A frame that will not revert is not worth stopping the rest for.
      }
    }
    setBatchBusy('');
  }, [batch, sessionId, filename]);

  /** Key every queued image with the color she has already proved on the first one.
   *  Sequential rather than parallel: this shells out to Python per image, and a
   *  phone firing twenty at once at her own box helps nobody. */
  const keyBatch = useCallback(async () => {
    if (!batch.length) return;
    setError('');
    const todo = batch.map((b, i) => ({ b, i })).filter(({ b }) => !b.cut);
    for (let n = 0; n < todo.length; n++) {
      const { b: item, i } = todo[n];
      setBatchBusy(`Keying ${n + 1} of ${todo.length}…`);
      try {
        const res = await apiFetch(`/api/gif/chroma-key/${item.sessionId}/${item.filename}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            color: keyColour,
            tolerance,
            blend: softness,
            mode: greenScreen ? 'chroma' : 'color',
          }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error || 'Color key failed');
        const url = data?.url || `/api/gif/frame/${item.sessionId}/${item.filename}?t=${Date.now()}`;
        // One at a time, so the grid fills in as it goes rather than all at the end.
        setBatch((current) => current.map((b, idx) =>
          idx === i ? { ...b, url: `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, cut: true, error: undefined } : b));
      } catch (err: any) {
        setBatch((current) => current.map((b, idx) =>
          idx === i ? { ...b, error: err?.message || 'Color key failed' } : b));
      }
    }
    setBatchBusy('');
  }, [batch, keyColour, tolerance, softness, greenScreen]);

  // Tap the picture to take the color from it. Typing hex codes to remove a
  // background you are looking at is the kind of small friction that stops a
  // tool getting used.
  const pickFromImage = useCallback((event: MouseEvent<HTMLImageElement>) => {
    if (!picking) return;
    const img = event.currentTarget;
    const rect = img.getBoundingClientRect();

    // object-contain can letterbox the image inside its element, so scale
    // through the drawn area rather than the element box.
    const scale = Math.min(rect.width / img.naturalWidth, rect.height / img.naturalHeight);
    const offsetX = (rect.width - img.naturalWidth * scale) / 2;
    const offsetY = (rect.height - img.naturalHeight * scale) / 2;
    const x = Math.round((event.clientX - rect.left - offsetX) / scale);
    const y = Math.round((event.clientY - rect.top - offsetY) / scale);
    if (x < 0 || y < 0 || x >= img.naturalWidth || y >= img.naturalHeight) return;

    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    try {
      ctx.drawImage(img, 0, 0);
      const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
      setKeyColour(`#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`);
      setPicking(false);
    } catch {
      setError("Couldn't read that pixel — use the color box instead.");
      setPicking(false);
    }
  }, [picking]);

  // Map a pointer event to the image's own pixel space, accounting for the
  // letterboxing object-contain introduces.
  const toImagePoint = useCallback((clientX: number, clientY: number) => {
    const img = imageRef.current;
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    const scale = Math.min(rect.width / img.naturalWidth, rect.height / img.naturalHeight);
    if (!scale) return null;
    const offsetX = (rect.width - img.naturalWidth * scale) / 2;
    const offsetY = (rect.height - img.naturalHeight * scale) / 2;
    return {
      x: (clientX - rect.left - offsetX) / scale,
      y: (clientY - rect.top - offsetY) / scale,
      scale,
    };
  }, []);

  const drawStrokes = useCallback((list: Stroke[]) => {
    const canvas = paintCanvas.current;
    const img = imageRef.current;
    if (!canvas || !img) return;
    const rect = img.getBoundingClientRect();
    // Match the canvas to the element box so the overlay lines up exactly.
    if (canvas.width !== Math.round(rect.width) || canvas.height !== Math.round(rect.height)) {
      canvas.width = Math.round(rect.width);
      canvas.height = Math.round(rect.height);
    }
    const scale = Math.min(rect.width / img.naturalWidth, rect.height / img.naturalHeight);
    const offsetX = (rect.width - img.naturalWidth * scale) / 2;
    const offsetY = (rect.height - img.naturalHeight * scale) / 2;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const stroke of list) {
      ctx.strokeStyle = stroke.tool === 'restore' ? 'rgba(80,220,140,0.55)' : 'rgba(255,90,90,0.55)';
      ctx.lineWidth = Math.max(1, stroke.width * scale);
      ctx.beginPath();
      stroke.points.forEach((point, i) => {
        const x = point.x * scale + offsetX;
        const y = point.y * scale + offsetY;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      // A single tap is a dot, not a zero-length line.
      if (stroke.points.length === 1) ctx.lineTo(stroke.points[0].x * scale + offsetX + 0.1, stroke.points[0].y * scale + offsetY);
      ctx.stroke();
    }
  }, []);

  // The canvas backing store is sized from the post-transform rect, so a zoom
  // change has to redraw or the overlay lands at the old scale.
  useEffect(() => { drawStrokes(strokes); }, [strokes, drawStrokes, imageUrl, painting, zoom, pan]);

  /** Mirror the point under the finger into the loupe, in the corner away from it. */
  const updateLoupe = useCallback((clientX: number, clientY: number) => {
    const point = toImagePoint(clientX, clientY);
    const box = viewportRef.current?.getBoundingClientRect();
    if (!point || !box || !point.scale) return;
    setLoupe({
      x: point.x,
      y: point.y,
      // Always three times the unzoomed view, so the loupe stays useful at any zoom.
      scale: (point.scale / zoom) * 3,
      side: clientX - box.left < box.width / 2 ? 'right' : 'left',
    });
  }, [toImagePoint, zoom]);

  const startStroke = useCallback((e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!painting || pointers.current.size > 1) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const point = toImagePoint(e.clientX, e.clientY);
    if (!point) return;
    strokeRef.current = { tool, width: brush, points: [{ x: point.x, y: point.y }] };
    setStrokes((prev) => [...prev, strokeRef.current as Stroke]);
    updateLoupe(e.clientX, e.clientY);
  }, [painting, tool, brush, toImagePoint, updateLoupe]);

  const extendStroke = useCallback((e: ReactPointerEvent<HTMLCanvasElement>) => {
    const active = strokeRef.current;
    if (!painting || !active) return;
    const point = toImagePoint(e.clientX, e.clientY);
    if (!point) return;
    active.points.push({ x: point.x, y: point.y });
    setStrokes((prev) => [...prev.slice(0, -1), { ...active, points: [...active.points] }]);
    updateLoupe(e.clientX, e.clientY);
  }, [painting, toImagePoint, updateLoupe]);

  const endStroke = useCallback(() => { strokeRef.current = null; setLoupe(null); }, []);

  /** Drop the in-progress stroke — a second finger means zoom, not paint. */
  const cancelStroke = useCallback(() => {
    if (!strokeRef.current) return;
    strokeRef.current = null;
    setLoupe(null);
    setStrokes((prev) => prev.slice(0, -1));
  }, []);

  // One finger paints or picks, exactly as before. Two fingers zoom and pan, so
  // the two gestures can never be mistaken for one another.
  const gestureDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size !== 2) return;
    cancelStroke();
    const [a, b] = [...pointers.current.values()];
    gesture.current = {
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      zoom,
      pan: { ...pan },
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
    };
  }, [cancelStroke, zoom, pan]);

  const gestureMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g || pointers.current.size < 2) return;
    const [a, b] = [...pointers.current.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const next = Math.min(6, Math.max(1, g.zoom * (dist / g.dist)));
    setZoom(next);
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    setPan(next <= 1.001 ? { x: 0, y: 0 } : { x: g.pan.x + (cx - g.cx), y: g.pan.y + (cy - g.cy) });
  }, []);

  const gestureUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current = null;
  }, []);

  const resetView = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, []);

  const cropDown = useCallback((e: React.PointerEvent) => {
    const p = toImagePoint(e.clientX, e.clientY);
    if (!p || !natural.w) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    // A corner is grabbed by being near it rather than by hitting a small square —
    // fingertips are wider than handles.
    const grab = Math.max(natural.w, natural.h) * 0.07;
    if (crop) {
      const near = (cx: number, cy: number) => Math.abs(p.x - cx) < grab && Math.abs(p.y - cy) < grab;
      if (near(crop.x, crop.y)) { cropDrag.current = 'nw'; return; }
      if (near(crop.x + crop.w, crop.y)) { cropDrag.current = 'ne'; return; }
      if (near(crop.x, crop.y + crop.h)) { cropDrag.current = 'sw'; return; }
      if (near(crop.x + crop.w, crop.y + crop.h)) { cropDrag.current = 'se'; return; }
    }
    cropDrag.current = 'new';
    cropAnchor.current = { x: p.x, y: p.y };
    setCrop({ x: p.x, y: p.y, w: 0, h: 0 });
  }, [crop, natural, toImagePoint]);

  const cropMove = useCallback((e: React.PointerEvent) => {
    const mode = cropDrag.current;
    if (!mode) return;
    const p = toImagePoint(e.clientX, e.clientY);
    if (!p) return;
    const cx = Math.max(0, Math.min(p.x, natural.w));
    const cy = Math.max(0, Math.min(p.y, natural.h));
    setCrop((c) => {
      if (mode === 'new') {
        const a = cropAnchor.current;
        if (!a) return c;
        return { x: Math.min(a.x, cx), y: Math.min(a.y, cy), w: Math.abs(cx - a.x), h: Math.abs(cy - a.y) };
      }
      if (!c) return c;
      let { x, y, w, h } = c;
      const right = x + w;
      const bottom = y + h;
      if (mode === 'nw' || mode === 'sw') { x = Math.min(cx, right); w = right - x; }
      if (mode === 'ne' || mode === 'se') { w = Math.max(0, cx - x); }
      if (mode === 'nw' || mode === 'ne') { y = Math.min(cy, bottom); h = bottom - y; }
      if (mode === 'sw' || mode === 'se') { h = Math.max(0, cy - y); }
      return { x, y, w, h };
    });
  }, [natural, toImagePoint]);

  const cropUp = useCallback(() => { cropDrag.current = null; cropAnchor.current = null; }, []);

  /** Tap a tile and it becomes the picture in the viewer. Everything up there already
   *  works on whichever {sessionId, filename} is loaded — color, subject, brush, revert
   *  — so the editor being welded to the first file you picked was the only thing
   *  stopping the batch being worked one at a time. */
  const openInEditor = useCallback((item: BatchItem) => {
    setSessionId(item.sessionId);
    setFilename(item.filename);
    setImageUrl(item.url);
    setCut(!!item.cut);
    setResult(null);
    setError('');
    setStrokes([]);
    setCrop(null);
    resetView();
  }, [resetView]);

  /** Largest centered square — a sticker is square, and dragging one by hand never is. */
  const squareCrop = useCallback(() => {
    if (!natural.w || !natural.h) return;
    const side = Math.min(natural.w, natural.h);
    setCrop({ x: (natural.w - side) / 2, y: (natural.h - side) / 2, w: side, h: side });
  }, [natural]);

  const applyCrop = useCallback(async (all = false) => {
    if (!sessionId || !filename || !crop || crop.w < 2 || crop.h < 2) return;
    const x = Math.max(0, Math.round(crop.x));
    const y = Math.max(0, Math.round(crop.y));
    const width = Math.max(1, Math.round(Math.min(crop.w, natural.w - x)));
    const height = Math.max(1, Math.round(Math.min(crop.h, natural.h - y)));
    setError('');
    setBusy('Cropping…');
    try {
      const res = await apiFetch(`/api/gif/crop/${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // No filename means the whole session, which is the matched-set path.
        body: JSON.stringify({ x, y, width, height, ...(all ? {} : { filename }) }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Crop failed');
      // The route answers ok with a count, and a count of zero is also ok — it means
      // it matched no frames and quietly did nothing. Success that cannot fail is not
      // success, so read the number rather than the status.
      if (!data?.croppedFrames) throw new Error('Nothing was cropped — the session had no frames to cut.');
      // Same paths, different pixels. Nothing on screen reloads unless it is told to.
      const stamp = Date.now();
      const bust = (u: string) => `${u.split('?')[0]}?t=${stamp}`;
      setImageUrl((u) => (u ? bust(u) : u));
      setBatch((current) => current.map((b) =>
        all || (b.sessionId === sessionId && b.filename === filename)
          ? { ...b, url: bust(b.url) }
          : b));
      // Strokes were painted against the old frame, so their coordinates are now lies.
      setStrokes([]);
      setCrop(null);
      setCropping(false);
      resetView();
    } catch (err: any) {
      setError(err?.message || 'Crop failed');
    } finally {
      setBusy('');
    }
  }, [sessionId, filename, crop, natural, resetView]);

  /** Replay strokes of one tool at full image resolution, as a mask blob. */
  const strokeMask = useCallback((which: 'restore' | 'erase'): Promise<Blob | null> => {
    const img = imageRef.current;
    const mine = strokes.filter((stroke) => stroke.tool === which);
    if (!img || mine.length === 0) return Promise.resolve(null);

    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return Promise.resolve(null);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#fff';
    for (const stroke of mine) {
      ctx.lineWidth = Math.max(1, stroke.width);
      ctx.beginPath();
      stroke.points.forEach((point, i) => (i === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)));
      if (stroke.points.length === 1) ctx.lineTo(stroke.points[0].x + 0.1, stroke.points[0].y);
      ctx.stroke();
    }
    return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
  }, [strokes]);

  const applyPaint = useCallback(async () => {
    if (!sessionId || !filename || strokes.length === 0) return;
    setError('');
    setBusy('Painting…');
    try {
      const [restoreMask, eraseMask] = await Promise.all([strokeMask('restore'), strokeMask('erase')]);
      const body = new FormData();
      if (restoreMask) body.append('restore', restoreMask, 'restore.png');
      if (eraseMask) body.append('erase', eraseMask, 'erase.png');

      const res = await apiFetch(`/api/gif/mask-paint/${sessionId}/${filename}`, { method: 'POST', body });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Painting failed');
      setImageUrl(data.url);
      setStrokes([]);
      setCut(true);
      setResult(null);
    } catch (err: any) {
      setError(err?.message || 'Painting failed');
    } finally {
      setBusy('');
    }
  }, [sessionId, filename, strokes, strokeMask]);

  const exportStill = useCallback(async () => {
    if (!sessionId || !filename) return;
    const chosen = PRESETS.find((p) => p.id === preset) ?? PRESETS[2];
    setError('');
    setBusy('Exporting…');
    try {
      const res = await apiFetch(`/api/gif/still-export/${sessionId}/${filename}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          format,
          maxSide: chosen.maxSide,
          maxBytes: chosen.maxBytes,
          padSquare: chosen.padSquare,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Export failed');
      setResult(data);
    } catch (err: any) {
      setError(err?.message || 'Export failed');
    } finally {
      setBusy('');
    }
  }, [sessionId, filename, preset, format]);

  const panel = cn('rounded-2xl border p-3 backdrop-blur-md', colors.panelBg, colors.panelBorder);
  const label = cn('text-[11px] font-semibold uppercase tracking-wider', colors.textMuted);

  return (
    <div className="flex flex-col gap-3">
      {engine && !engine.ready && (
        <div className={cn(panel, 'flex items-start gap-2')}>
          <TriangleAlert size={15} className="mt-0.5 shrink-0" style={{ color: colors.accent }} />
          <div>
            <div className={cn('text-xs font-semibold', colors.textMain)}>Background removal isn't set up</div>
            <div className={cn('mt-1 text-[11px] leading-relaxed', colors.textMuted)}>{engine.reason}</div>
            <div className={cn('mt-1 text-[11px] leading-relaxed', colors.textMuted)}>
              The exporter below still works — it just won't cut anything out.
            </div>
          </div>
        </div>
      )}

      <div className={panel}>
        <div className={label}>Image</div>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            const picked = Array.from(e.target.files || []);
            e.target.value = '';
            if (!picked.length) return;
            setBatch([]);
            // The first goes into the editor so she can sample the color on a real
            // picture; the rest wait for that same color.
            // queueBatch takes the WHOLE list, not the tail: it treats files[0] as the
            // one already uploaded into the editor and turns it into the first tile.
            // Slicing here too dropped picked[1] on the floor and named the first tile
            // after it — the count and the grid both agreed, and both were short.
            void pickImage(picked[0]).then((session) => {
              if (picked.length > 1 && session) void queueBatch(picked, session);
            });
          }}
        />
        <button
          onClick={() => fileInput.current?.click()}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold"
          style={{ backgroundColor: colors.accent, color: themeMode === 'dark' ? '#0b0b0d' : '#fff' }}
        >
          <ImageUp size={15} /> {imageUrl ? 'Choose another' : 'Choose an image'}
        </button>

        {imageUrl && (
          // Checkerboard, so transparency reads as transparency rather than as
          // whatever color the panel happens to be.
          <div
            className="mt-3 flex items-center justify-center rounded-xl p-2"
            style={{
              backgroundImage:
                'linear-gradient(45deg, rgba(128,128,128,.28) 25%, transparent 25%, transparent 75%, rgba(128,128,128,.28) 75%),'
                + 'linear-gradient(45deg, rgba(128,128,128,.28) 25%, transparent 25%, transparent 75%, rgba(128,128,128,.28) 75%)',
              backgroundSize: '16px 16px',
              backgroundPosition: '0 0, 8px 8px',
            }}
          >
            {/* The viewport clips; the layer inside it is what zooms. Every
                screen-to-image mapping reads the live bounding rect, which is
                already post-transform, so zoom needs no maths of its own. */}
            <div
              ref={viewportRef}
              onPointerDown={gestureDown}
              onPointerMove={gestureMove}
              onPointerUp={gestureUp}
              onPointerCancel={gestureUp}
              className={cn('relative overflow-hidden', (painting || zoom > 1) && 'touch-none')}
            >
              <div
                className="relative"
                style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: 'center center' }}
              >
                <img
                  ref={imageRef}
                  src={imageUrl}
                  alt=""
                  crossOrigin="anonymous"
                  onClick={pickFromImage}
                  onLoad={(e) => {
                    setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight });
                    drawStrokes(strokes);
                  }}
                  className={cn('max-h-[46vh] w-auto object-contain', picking && 'cursor-crosshair')}
                />
                {/* The paint surface sits exactly over the image and only takes
                    pointer events while painting, so tapping to pick a color and
                    painting never fight for the same gesture. */}
                <canvas
                  ref={paintCanvas}
                  onPointerDown={startStroke}
                  onPointerMove={extendStroke}
                  onPointerUp={endStroke}
                  onPointerCancel={endStroke}
                  className={cn('absolute inset-0 h-full w-full', painting ? 'touch-none' : 'pointer-events-none')}
                />
                {/* THE CROP BOX. The img is w-auto against a max height, so its element
                    box already carries the picture's own aspect — which means the box can
                    be laid out in plain percentages of the natural size and stays true at
                    any zoom, with no second copy of the mapping maths to drift. */}
                {cropping && natural.w > 0 && (
                  <div
                    onPointerDown={cropDown}
                    onPointerMove={cropMove}
                    onPointerUp={cropUp}
                    onPointerCancel={cropUp}
                    className="absolute inset-0 touch-none cursor-crosshair"
                  >
                    {crop && crop.w > 0 && crop.h > 0 && (() => {
                      const l = (crop.x / natural.w) * 100;
                      const t = (crop.y / natural.h) * 100;
                      const w = (crop.w / natural.w) * 100;
                      const h = (crop.h / natural.h) * 100;
                      // Four panels around the keep-box rather than one clip-path hole:
                      // obviously correct, and it degrades to nothing if the box is empty.
                      return (
                        <>
                          <div className="pointer-events-none absolute left-0 right-0 bg-black/55" style={{ top: 0, height: `${t}%` }} />
                          <div className="pointer-events-none absolute left-0 right-0 bg-black/55" style={{ top: `${t + h}%`, bottom: 0 }} />
                          <div className="pointer-events-none absolute bg-black/55" style={{ left: 0, width: `${l}%`, top: `${t}%`, height: `${h}%` }} />
                          <div className="pointer-events-none absolute bg-black/55" style={{ left: `${l + w}%`, right: 0, top: `${t}%`, height: `${h}%` }} />
                          <div
                            className="pointer-events-none absolute border-2"
                            style={{ left: `${l}%`, top: `${t}%`, width: `${w}%`, height: `${h}%`, borderColor: colors.accent }}
                          />
                          {[[l, t], [l + w, t], [l, t + h], [l + w, t + h]].map(([hx, hy], i) => (
                            <div
                              key={i}
                              className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white"
                              style={{ left: `${hx}%`, top: `${hy}%`, background: colors.accent }}
                            />
                          ))}
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>

              {/* Your hand covers the spot you are painting, so the spot appears
                  up here instead — always in the corner you are not reaching into. */}
              {painting && loupe && natural.w > 0 && (
                <div
                  className="pointer-events-none absolute top-1.5 z-20 overflow-hidden rounded-full border-2 shadow-lg"
                  style={{
                    left: loupe.side === 'left' ? 6 : undefined,
                    right: loupe.side === 'right' ? 6 : undefined,
                    width: LOUPE,
                    height: LOUPE,
                    borderColor: colors.accent,
                    backgroundImage:
                      'linear-gradient(45deg, rgba(128,128,128,.3) 25%, transparent 25%, transparent 75%, rgba(128,128,128,.3) 75%),'
                      + 'linear-gradient(45deg, rgba(128,128,128,.3) 25%, transparent 25%, transparent 75%, rgba(128,128,128,.3) 75%)',
                    backgroundSize: '10px 10px',
                    backgroundPosition: '0 0, 5px 5px',
                  }}
                >
                  <div
                    className="absolute inset-0"
                    style={{
                      backgroundImage: `url(${imageUrl})`,
                      backgroundRepeat: 'no-repeat',
                      backgroundSize: `${natural.w * loupe.scale}px ${natural.h * loupe.scale}px`,
                      backgroundPosition:
                        `${LOUPE / 2 - loupe.x * loupe.scale}px ${LOUPE / 2 - loupe.y * loupe.scale}px`,
                    }}
                  />
                  {/* Where the brush actually lands, at its actual size. */}
                  <div
                    className="absolute rounded-full border"
                    style={{
                      left: LOUPE / 2 - (brush * loupe.scale) / 2,
                      top: LOUPE / 2 - (brush * loupe.scale) / 2,
                      width: Math.max(4, brush * loupe.scale),
                      height: Math.max(4, brush * loupe.scale),
                      borderColor: tool === 'restore' ? 'rgba(80,220,140,0.95)' : 'rgba(255,90,90,0.95)',
                    }}
                  />
                  <div
                    className="absolute h-[3px] w-[3px] rounded-full bg-white"
                    style={{ left: LOUPE / 2 - 1.5, top: LOUPE / 2 - 1.5 }}
                  />
                </div>
              )}
            </div>
          </div>
        )}

        {imageUrl && (
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className={cn('w-16 text-[11px]', colors.textMuted)}>Zoom</span>
            <input
              type="range" min={100} max={600} step={10} value={Math.round(zoom * 100)}
              onChange={(e) => {
                const next = Number(e.target.value) / 100;
                setZoom(next);
                if (next <= 1.001) setPan({ x: 0, y: 0 });
              }}
              className="flex-1" style={{ accentColor: colors.accent }}
            />
            <span className={cn('w-9 text-right text-[11px]', colors.textMuted)}>{zoom.toFixed(1)}×</span>
            <button
              onClick={resetView}
              disabled={zoom === 1 && pan.x === 0 && pan.y === 0}
              className={cn('rounded-lg border px-2 py-1 text-[11px] disabled:opacity-40', colors.panelBorder, colors.textMuted)}
            >
              Fit
            </button>
          </div>
        )}

        {imageUrl && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              onClick={() => { setCropping((v) => !v); setCrop(null); }}
              className={cn(
                'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold',
                colors.panelBorder,
                cropping ? 'text-white' : colors.textMuted,
              )}
              style={cropping ? { background: colors.accent, borderColor: colors.accent } : undefined}
            >
              <Crop size={13} /> Crop
            </button>
            {cropping && (
              <>
                <button
                  onClick={squareCrop}
                  className={cn('rounded-lg border px-2 py-1.5 text-[11px]', colors.panelBorder, colors.textMuted)}
                >
                  Square
                </button>
                <button
                  onClick={() => setCrop(null)}
                  disabled={!crop}
                  className={cn('rounded-lg border px-2 py-1.5 text-[11px] disabled:opacity-40', colors.panelBorder, colors.textMuted)}
                >
                  Clear
                </button>
                <button
                  onClick={() => applyCrop(false)}
                  disabled={!!busy || !crop || crop.w < 2 || crop.h < 2}
                  className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold text-white disabled:opacity-40"
                  style={{ background: colors.accent }}
                >
                  <Check size={13} /> Cut this one
                </button>
                {batch.length > 1 && (
                  <button
                    onClick={() => applyCrop(true)}
                    disabled={!!busy || !crop || crop.w < 2 || crop.h < 2}
                    className={cn('rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold disabled:opacity-40', colors.panelBorder, colors.textMuted)}
                  >
                    Cut all {batch.length}
                  </button>
                )}
                <p className={cn('w-full text-[10px] leading-tight', colors.textMuted)}>
                  {crop && crop.w > 1
                    ? `${Math.round(crop.w)} × ${Math.round(crop.h)}`
                    : 'Drag a box on the picture. Drag a corner to adjust it.'}
                  {batch.length > 1 && ' — Cut all uses the same box on every picture in the batch.'}
                </p>
              </>
            )}
          </div>
        )}
      </div>

      {/* THE BATCH. Everything picked after the first file. She proves the color on
          the image above, then keys the whole set with it in one press and the individual
          cutouts come back here — upload a set that share a background, remove them all at
          once, get the images back below. Each is its own download; a failure marks only
          itself rather than stopping the run. */}
      {batch.length > 0 && (
        <div className={panel}>
          <div className={label}>Batch · {batch.length} image{batch.length === 1 ? '' : 's'}</div>
          <p className={cn('mt-1 text-[11px]', colors.textMuted)}>
            {batch.every((b) => b.cut)
              ? 'Keyed. Tap any one to save it.'
              : 'Set the color on the picture above, then key the rest with it.'}
          </p>
          <button
            onClick={() => void keyBatch()}
            disabled={!!batchBusy || !cut || batch.every((b) => b.cut)}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold disabled:opacity-50"
            style={{ backgroundColor: colors.accent, color: themeMode === 'dark' ? '#0b0b0d' : '#fff' }}
          >
            {batchBusy ? <Loader2 size={15} className="animate-spin" /> : <Pipette size={15} />}
            {batchBusy || (batch.every((b) => b.cut)
              ? 'All keyed'
              : `Key the other ${batch.filter((b) => !b.cut).length} with this color`)}
          </button>
          {/* A batch keyed with the wrong color was unrecoverable without picking all
              of them again — Original only ever put back the editor's own frame. */}
          {batch.some((b) => b.cut) && (
            <button
              onClick={() => void revertBatch()}
              disabled={!!batchBusy}
              className={cn('mt-2 flex w-full items-center justify-center gap-2 rounded-xl border py-2.5 text-xs font-semibold disabled:opacity-50', colors.panelBorder, colors.textMain)}
            >
              <RotateCcw size={13} /> Put them all back
            </button>
          )}
          <div className="mt-3 grid grid-cols-3 gap-2">
            {batch.map((item) => {
              // The one currently up in the viewer, so the grid says which picture the
              // color picker and the crop box are actually about to act on.
              const isOpen = item.sessionId === sessionId && item.filename === filename;
              return (
                <button
                  key={item.filename}
                  type="button"
                  onClick={() => openInEditor(item)}
                  className={cn(
                    'relative flex aspect-square items-center justify-center overflow-hidden rounded-xl border active:scale-[0.98]',
                    colors.panelBorder,
                  )}
                  style={{
                    ...(isOpen ? { borderColor: colors.accent, boxShadow: `0 0 0 2px ${colors.accent}55` } : null),
                    backgroundImage:
                      'linear-gradient(45deg, rgba(127,127,127,0.16) 25%, transparent 25%, transparent 75%, rgba(127,127,127,0.16) 75%),' +
                      'linear-gradient(45deg, rgba(127,127,127,0.16) 25%, transparent 25%, transparent 75%, rgba(127,127,127,0.16) 75%)',
                    backgroundSize: '14px 14px',
                    backgroundPosition: '0 0, 7px 7px',
                  }}
                >
                  <img src={item.url} alt={item.name} className="h-full w-full object-contain" loading="lazy" />
                  {/* Downloading is its own target now that tapping opens the picture —
                      a tap that could mean two things would have to guess which. */}
                  {item.cut && (
                    <a
                      href={saveHref(item.url)}
                      download={item.name.replace(/\.[^.]+$/, '') + '-cutout.png'}
                      onClick={(e) => e.stopPropagation()}
                      className="absolute bottom-1 right-1 rounded-full bg-black/55 p-1 text-white backdrop-blur"
                    >
                      <Download size={11} />
                    </a>
                  )}
                  {item.error && (
                    <span className="absolute inset-x-1 bottom-1 rounded bg-red-950/85 px-1 py-0.5 text-[9px] text-red-100">{item.error}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {imageUrl && (
        <div className={panel}>
          <div className={label}>Remove background</div>

          {/* Color first: a flat backdrop keys exactly, and that is what most
              emoji come from. Subject detection is the guess, not the default. */}
          <div className="mt-2 flex gap-1.5">
            {([['color', 'By color'], ['subject', 'Find subject']] as const).map(([id, text]) => (
              <button
                key={id}
                onClick={() => setMode(id)}
                className={cn('flex-1 rounded-xl border px-2 py-1.5 text-xs', colors.panelBorder, colors.textMain)}
                style={mode === id ? { borderColor: colors.accent } : undefined}
              >
                {text}
              </button>
            ))}
          </div>

          {mode === 'color' ? (
            <>
              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={() => setPicking((p) => !p)}
                  className={cn('flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs', colors.panelBorder, colors.textMain)}
                  style={picking ? { borderColor: colors.accent } : undefined}
                >
                  <Pipette size={14} /> {picking ? 'Tap the image…' : 'Pick from image'}
                </button>
                <input
                  type="color"
                  value={keyColour}
                  onChange={(e) => setKeyColour(e.target.value.toUpperCase())}
                  className="h-9 w-12 rounded-lg border-0 bg-transparent p-0"
                />
                <span className={cn('font-mono text-[11px]', colors.textMuted)}>{keyColour}</span>
              </div>

              <div className="mt-3 flex items-center justify-between gap-3">
                <span className={cn('w-20 text-[11px]', colors.textMuted)}>Tolerance</span>
                <input
                  type="range" min={0.05} max={0.8} step={0.05} value={tolerance}
                  onChange={(e) => setTolerance(Number(e.target.value))}
                  className="flex-1" style={{ accentColor: colors.accent }}
                />
                <span className={cn('w-9 text-right text-[11px]', colors.textMuted)}>{tolerance.toFixed(2)}</span>
              </div>
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className={cn('w-20 text-[11px]', colors.textMuted)}>Edge blend</span>
                <input
                  type="range" min={0} max={0.5} step={0.05} value={softness}
                  onChange={(e) => setSoftness(Number(e.target.value))}
                  className="flex-1" style={{ accentColor: colors.accent }}
                />
                <span className={cn('w-9 text-right text-[11px]', colors.textMuted)}>{softness.toFixed(2)}</span>
              </div>
              <label className={cn('mt-2 flex items-center gap-2 text-[11px]', colors.textMuted)}>
                <input type="checkbox" checked={greenScreen} onChange={(e) => setGreenScreen(e.target.checked)} />
                Green-screen mode — for an actual green screen, not a flat backdrop
              </label>
            </>
          ) : (
            <>
              <div className="mt-3 flex items-center justify-between gap-3">
                <span className={cn('w-20 text-[11px]', colors.textMuted)}>Edge softness</span>
                <input
                  type="range" min={0} max={4} step={0.5} value={feather}
                  onChange={(e) => setFeather(Number(e.target.value))}
                  className="flex-1" style={{ accentColor: colors.accent }}
                />
                <span className={cn('w-9 text-right text-[11px]', colors.textMuted)}>{feather}px</span>
              </div>
              <label className={cn('mt-2 flex items-center gap-2 text-[11px]', colors.textMuted)}>
                <input type="checkbox" checked={hardEdge} onChange={(e) => setHardEdge(e.target.checked)} />
                Solid subject — keep anything it recognised at all, no half-transparent fabric
              </label>
              {engine?.model && (
                <div className={cn('mt-1 text-[10px]', colors.textMuted)}>Model: {engine.model}</div>
              )}
            </>
          )}

          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={() => void (mode === 'color' ? keyColourOut() : removeBackground())}
              disabled={!!busy || (mode === 'subject' && !engine?.ready)}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-semibold disabled:opacity-40"
              style={{ backgroundColor: colors.accent, color: themeMode === 'dark' ? '#0b0b0d' : '#fff' }}
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Eraser size={15} />}
              {cut ? 'Try again' : mode === 'color' ? 'Key this color' : 'Find the subject'}
            </button>
            {cut && (
              <button
                onClick={() => void revert()}
                disabled={!!busy}
                className={cn('flex items-center gap-1.5 rounded-xl border px-3 py-2.5 text-xs disabled:opacity-40', colors.panelBorder, colors.textMuted)}
              >
                <RotateCcw size={14} /> Original
              </button>
            )}
          </div>
          {cut && (
            <div className={cn('mt-2 text-[10px] leading-relaxed', colors.textMuted)}>
              Try again re-keys from the original, so the sliders never stack on an already-cut image.
            </div>
          )}
        </div>
      )}

      {imageUrl && (
        <div className={panel}>
          <div className="flex items-center justify-between">
            <div className={label}>Fix by hand</div>
            <button
              onClick={() => { setPainting((p) => !p); setPicking(false); }}
              className={cn('flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px]', colors.panelBorder, colors.textMain)}
              style={painting ? { borderColor: colors.accent } : undefined}
            >
              {painting ? <><X size={12} /> Done</> : <><Brush size={12} /> Paint</>}
            </button>
          </div>

          {painting ? (
            <>
              <div className={cn('mt-2 text-[11px] leading-relaxed', colors.textMuted)}>
                No model gets every picture right. Paint over what it got wrong — green brings
                it back, red takes it away. Only the transparency changes; the picture underneath
                is never touched.
                <br />
                Pinch with two fingers to zoom in, drag with two to move around — one finger always
                paints, so the gestures never collide. While you paint, a magnifier shows the spot
                under your hand in the opposite corner.
              </div>
              <div className="mt-2 flex gap-1.5">
                {([['restore', 'Bring back'], ['erase', 'Take away']] as const).map(([id, text]) => (
                  <button
                    key={id}
                    onClick={() => setTool(id)}
                    className={cn('flex-1 rounded-xl border px-2 py-1.5 text-xs', colors.panelBorder, colors.textMain)}
                    style={tool === id ? { borderColor: id === 'restore' ? '#50dc8c' : '#ff5a5a' } : undefined}
                  >
                    {text}
                  </button>
                ))}
              </div>
              <div className="mt-3 flex items-center justify-between gap-3">
                <span className={cn('w-16 text-[11px]', colors.textMuted)}>Brush</span>
                <input
                  type="range" min={6} max={120} step={2} value={brush}
                  onChange={(e) => setBrush(Number(e.target.value))}
                  className="flex-1" style={{ accentColor: colors.accent }}
                />
                <span className={cn('w-10 text-right text-[11px]', colors.textMuted)}>{brush}px</span>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={() => void applyPaint()}
                  disabled={!!busy || strokes.length === 0}
                  className="flex flex-1 items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-semibold disabled:opacity-40"
                  style={{ backgroundColor: colors.accent, color: themeMode === 'dark' ? '#0b0b0d' : '#fff' }}
                >
                  {busy === 'Painting…' ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
                  Apply {strokes.length > 0 ? `(${strokes.length})` : ''}
                </button>
                <button
                  onClick={() => setStrokes((prev) => prev.slice(0, -1))}
                  disabled={strokes.length === 0}
                  className={cn('flex items-center gap-1.5 rounded-xl border px-3 py-2.5 text-xs disabled:opacity-40', colors.panelBorder, colors.textMuted)}
                >
                  <Undo2 size={14} /> Undo
                </button>
              </div>
            </>
          ) : (
            <div className={cn('mt-1 text-[11px]', colors.textMuted)}>
              Paint the transparency yourself when the model misses an arm.
            </div>
          )}
        </div>
      )}

      {imageUrl && (
        <div className={panel}>
          <div className={label}>Save as</div>
          <div className="mt-2 grid grid-cols-3 gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                onClick={() => setPreset(p.id)}
                className={cn('rounded-xl border px-2 py-2 text-left', colors.panelBorder)}
                style={preset === p.id ? { borderColor: colors.accent } : undefined}
              >
                <div className={cn('text-xs font-semibold', colors.textMain)}>{p.label}</div>
                <div className={cn('text-[10px]', colors.textMuted)}>{p.hint}</div>
              </button>
            ))}
          </div>

          <div className="mt-2 flex gap-1.5">
            {(['png', 'webp'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFormat(f)}
                className={cn('flex-1 rounded-xl border px-2 py-1.5 text-xs', colors.panelBorder, colors.textMain)}
                style={format === f ? { borderColor: colors.accent } : undefined}
              >
                {f === 'png' ? 'PNG (Discord)' : 'WebP (smaller)'}
              </button>
            ))}
          </div>

          <button
            onClick={() => void exportStill()}
            disabled={!!busy}
            className={cn('mt-2 flex w-full items-center justify-center gap-2 rounded-xl border py-2.5 text-sm font-medium disabled:opacity-40', colors.panelBorder, colors.textMain)}
          >
            {busy === 'Exporting…' ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} Export
          </button>

          {result && (
            /* The finished still is a download link, but it used to read as a
               receipt — a filename and some numbers with nothing saying it
               could be tapped. Arrow first, then the words, so the row says
               what it is before it says what it made. */
            <a
              href={saveHref(result.url)}
              download={result.filename}
              className={cn(
                'mt-2 flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-xs active:scale-[0.99]',
                colors.panelBorder,
                colors.textMain,
              )}
            >
              <Download size={16} className="shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">Tap to save</span>
                <span className={cn('block truncate text-[11px]', colors.textMuted)}>
                  {result.filename} · {result.width}×{result.height} · {readableSize(result.bytes)}
                  {result.colors ? ` · ${result.colors} colors` : ''}
                </span>
              </span>
            </a>
          )}
          {result && result.withinBudget === false && (
            <div className={cn('mt-1 text-[11px]', colors.textMuted)}>
              Still over the cap even at 32 colors — try a smaller preset.
            </div>
          )}
        </div>
      )}

      {busy && <div className={cn('text-center text-[11px]', colors.textMuted)}>{busy}</div>}
      {error && <div className="text-center text-[11px] text-red-400">{error}</div>}
    </div>
  );
}
