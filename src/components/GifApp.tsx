import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { motion } from 'motion/react';
import {
  ChevronLeft, Upload, Trash2, Download, Play, Pause,
  Scissors, Wand2, Loader2, AlertTriangle, Check, Pipette,
  ZoomIn, RotateCcw, Crop, ChevronDown, ChevronRight, Brush, Eraser, Undo2,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { usePaint, LOUPE } from '../lib/paint';
import { apiFetch } from '../lib/api';
import type { ThemeConfig } from '../lib/theme';
import { SegmentedControl } from '../ui';
import { saveHref } from '../lib/download';

type ThemeMode = 'light' | 'dark';

interface Frame {
  filename: string;
  url: string;
  processed?: boolean;
  chromaKeyed?: boolean;
}

interface GifSession {
  sessionId: string;
  frames: Frame[];
  fps: number;
  outputWidth?: number;
  outputHeight?: number;
  /**
   * Optional fields keep records written by the original GIF Lab readable.
   * The object store itself does not need a schema/version bump: older rows
   * simply restore the frame-only defaults below.
   */
  updatedAt?: number;
  selectedFrames?: number[];
  output?: {
    url?: string | null;
    size?: { kb: number; ok: boolean; limitKb?: number } | null;
    optimizeStats?: { savedPercent: number; framesDropped: number; beforeKb: number } | null;
  };
  settings?: Partial<GifPersistedSettings>;
}

interface GifPersistedSettings {
  preserveColorPreset: boolean;
  speedValue: number;
  chromaMode: boolean;
  chromaColor: string;
  chromaTolerance: number;
  chromaBlend: number;
  greenScreen: boolean;
  lossyLevel: number;
  colorCount: number;
  showAdvancedOpt: boolean;
  dither: boolean;
  ditherMethod: string;
  colorMethod: string;
  optimizeLevel: number;
  dropDuplicates: boolean;
  removeFrames: number;
  stripMetadata: boolean;
  optimizeScale: number;
  unoptimize: boolean;
  interlace: boolean;
  showTextPanel: boolean;
  overlayText: string;
  textPosition: 'top' | 'center' | 'bottom';
  /** Hand-placed position as a fraction of the frame; null means use the preset. */
  textAnchor: { x: number; y: number } | null;
  textSize: number;
  textFillColor: string;
  textBorderColor: string;
  textFont: string;
}

interface GifAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: ThemeMode;
  /** Render just the lab body when something else supplies the surrounding shell. */
  embedded?: boolean;
  /** A hidden embedded lab keeps its work but pauses visual preview timers. */
  active?: boolean;
}

const DEFAULT_GIF_SETTINGS: GifPersistedSettings = {
  preserveColorPreset: false,
  speedValue: 1,
  chromaMode: false,
  chromaColor: '#00FF00',
  chromaTolerance: 0.3,
  // The server has always defaulted the edge blend to 0.1 and this panel
  // never sent one, so that default was the only value anyone could get.
  chromaBlend: 0.1,
  greenScreen: false,
  lossyLevel: 80,
  colorCount: 128,
  showAdvancedOpt: false,
  dither: false,
  ditherMethod: 'default',
  colorMethod: 'diversity',
  optimizeLevel: 3,
  dropDuplicates: false,
  removeFrames: 0,
  stripMetadata: true,
  optimizeScale: 100,
  unoptimize: false,
  interlace: false,
  showTextPanel: false,
  overlayText: '',
  textPosition: 'bottom',
  textAnchor: null,
  textSize: 24,
  textFillColor: '#ffffff',
  textBorderColor: '#000000',
  textFont: 'DejaVu Sans',
};

/**
 * The fonts the text tool draws with are installed on the server, not in the
 * browser — so a picker that only lists their names shows nothing about what
 * you're choosing. Each one is loaded under its own namespaced family so the
 * label can be drawn in the typeface it names.
 */
const gifFontFamily = (family: string) => `GifLab ${family.replace(/["\\]/g, '')}`;

const DB_NAME = 'gif-lab';
const STORE_NAME = 'sessions';

async function getDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: 'sessionId' });
    };
  });
}

async function saveSession(session: GifSession): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(session);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadLastSession(): Promise<GifSession | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => {
      const sessions = request.result as GifSession[];
      // UUID key order is not creation order. New rows carry updatedAt; if all
      // rows predate that field, retain the old "last result" behavior.
      const latest = sessions.reduce<GifSession | null>((current, session) => {
        if (!current) return session;
        return (session.updatedAt ?? 0) >= (current.updatedAt ?? 0) ? session : current;
      }, null);
      resolve(latest);
    };
    request.onerror = () => reject(request.error);
  });
}

async function clearSessions(): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function GifApp({ onClose, themeConfig, themeMode, embedded = false, active = true }: GifAppProps) {
  const colors = themeConfig[themeMode];
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionRestored, setSessionRestored] = useState(false);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [selectedFrames, setSelectedFrames] = useState<Set<number>>(new Set());
  const [fps, setFps] = useState(10);
  // How long each frame is held, in ms. 0 means 'use the frame rate'.
  const [delayMs, setDelayMs] = useState(0);
  const [loading, setLoading] = useState(false);
  const [removingBg, setRemovingBg] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [outputSize, setOutputSize] = useState<{ kb: number; ok: boolean; limitKb?: number } | null>(null);
  const [preserveColorPreset, setPreserveColorPreset] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [previewFrame, setPreviewFrame] = useState(0);
  // The placement pad is a drawing board, not a screen. Playback drives
  // previewFrame, and the pad was reading the same value — so hitting play set
  // the surface you're trying to position a caption on running. It follows the
  // preview while paused and holds whatever frame it was on while playing.
  const [padFrame, setPadFrame] = useState(0);
  const previewTimerRef = useRef<number | null>(null);
  const [bgProgress, setBgProgress] = useState<string | null>(null);

  // Chroma key state
  const [chromaMode, setChromaMode] = useState(false);
  const [chromaColor, setChromaColor] = useState('#00FF00');
  const [chromaTolerance, setChromaTolerance] = useState(0.3);
  const [chromaBlend, setChromaBlend] = useState(0.1);
  // Cutout has always sent a mode and this tab never did, so it fell to the
  // route's default of chromakey — which works in YUV and deliberately ignores
  // luminance, so on a red backdrop it treats pink as the same colour and takes
  // the cheeks with it. colorkey compares RGB and does not. Measured on a pink
  // cheek against a red fill: chromakey starts eating it at 0.10 and has
  // destroyed it by 0.20; colorkey still has it at 0.30.
  const [greenScreen, setGreenScreen] = useState(false);
  const [paintOpen, setPaintOpen] = useState(false);
  const paintImageRef = useRef<HTMLImageElement>(null);
  const paintBoxRef = useRef<HTMLDivElement>(null);
  // The same surface Cutout uses. Two copies of the stroke maths would be the
  // bug, not the plan: the mask has to land on the pixels the overlay drew on.
  const paint = usePaint({ imageRef: paintImageRef, viewportRef: paintBoxRef });
  const [pickingColor, setPickingColor] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const textPadRef = useRef<HTMLDivElement | null>(null);
  const colorPickCanvasRef = useRef<HTMLCanvasElement>(null);

  // Output size options
  const [outputWidth, setOutputWidth] = useState<number | undefined>(undefined);
  const [outputHeight, setOutputHeight] = useState<number | undefined>(undefined);
  // The frame's own pixel size, read off the preview image. With no size chosen,
  // ffmpeg adds no scale filter at all and renders at exactly this.
  const [frameNatural, setFrameNatural] = useState<{ w: number; h: number } | null>(null);
  // Every frame's own pixel size, keyed by filename so it survives reordering and
  // deletion. The export pads every picture onto one canvas — the largest width
  // and the largest height in the set — so the preview cannot be honest while it
  // only knows about one frame. This is what lets it draw the same canvas.
  const [frameSizes, setFrameSizes] = useState<Record<string, { w: number; h: number }>>({});

  // Crop state
  const [showCrop, setShowCrop] = useState(false);
  const [cropX, setCropX] = useState(0);
  const [cropY, setCropY] = useState(0);
  const [cropW, setCropW] = useState(100);
  const [cropH, setCropH] = useState(100);
  const [cropping, setCropping] = useState(false);
  // Square lock — stickers and avatars are square far more often than not.
  const [cropSquare, setCropSquare] = useState(false);
  // Crop the one you are looking at, or the whole set. Hand-picked pictures need
  // per-frame framing; extracted video frames want all of them at once.
  const [cropAllFrames, setCropAllFrames] = useState(true);
  const [originalDimensions, setOriginalDimensions] = useState<{ w: number; h: number } | null>(null);
  const cropPreviewRef = useRef<HTMLDivElement>(null);

  // Optimization state
  const [lossyLevel, setLossyLevel] = useState(80);
  const [colorCount, setColorCount] = useState(128);
  const [optimizing, setOptimizing] = useState(false);
  // Advanced optimizer options (mirrors what gifsicle exposes)
  const [showAdvancedOpt, setShowAdvancedOpt] = useState(false);
  const [dither, setDither] = useState(false);
  const [ditherMethod, setDitherMethod] = useState('default');
  const [colorMethod, setColorMethod] = useState('diversity');
  const [optimizeLevel, setOptimizeLevel] = useState(3);
  const [dropDuplicates, setDropDuplicates] = useState(false);
  const [removeFrames, setRemoveFrames] = useState(0); // 0 = keep every frame
  const [stripMetadata, setStripMetadata] = useState(true);
  const [optimizeScale, setOptimizeScale] = useState(100); // percent
  const [unoptimize, setUnoptimize] = useState(false);
  const [interlace, setInterlace] = useState(false);
  const [optimizeStats, setOptimizeStats] = useState<{ savedPercent: number; framesDropped: number; beforeKb: number } | null>(null);

  // Speed and text state
  const [speedValue, setSpeedValue] = useState(1);
  const [changingSpeed, setChangingSpeed] = useState(false);
  const [showTextPanel, setShowTextPanel] = useState(false);
  const [overlayText, setOverlayText] = useState('');
  const [textPosition, setTextPosition] = useState<'top' | 'center' | 'bottom'>('bottom');
  // Set by dragging the caption around the preview; a preset button clears it.
  const [textAnchor, setTextAnchor] = useState<{ x: number; y: number } | null>(null);
  const [textSize, setTextSize] = useState(24);
  // What's literally in the size box while she's typing. Without this the field
  // is pinned to a number, so clearing it snaps straight back to a default and
  // there's no way to type a fresh value — you can only edit around the old one.
  const [textSizeDraft, setTextSizeDraft] = useState<string | null>(null);
  const [textFillColor, setTextFillColor] = useState('#ffffff');
  const [textBorderColor, setTextBorderColor] = useState('#000000');
  const [textFont, setTextFont] = useState('DejaVu Sans');
  const [availableFonts, setAvailableFonts] = useState<string[]>(['DejaVu Sans', 'DejaVu Sans Mono', 'DejaVu Serif']);
  const [addingText, setAddingText] = useState(false);

  // Persist the working state, not just the extracted frames. A host that swaps
  // tabs by unmounting them takes the output and the control values with it, so
  // they need to be able to make that short round trip through IndexedDB too.
  useEffect(() => {
    if (!sessionRestored || !sessionId || frames.length === 0) return;

    saveSession({
      sessionId,
      frames,
      fps,
      outputWidth,
      outputHeight,
      updatedAt: Date.now(),
      selectedFrames: Array.from(selectedFrames),
      output: {
        url: outputUrl,
        size: outputSize,
        optimizeStats,
      },
      settings: {
        preserveColorPreset,
        speedValue,
        chromaMode,
        chromaColor,
        chromaTolerance,
        chromaBlend,
        greenScreen,
        lossyLevel,
        colorCount,
        showAdvancedOpt,
        dither,
        ditherMethod,
        colorMethod,
        optimizeLevel,
        dropDuplicates,
        removeFrames,
        stripMetadata,
        optimizeScale,
        unoptimize,
        interlace,
        showTextPanel,
        overlayText,
        textPosition,
        textAnchor,
        textSize,
        textFillColor,
        textBorderColor,
        textFont,
      },
    }).catch(console.error);
  }, [
    sessionRestored, sessionId, frames, selectedFrames, fps, outputWidth, outputHeight,
    outputUrl, outputSize, optimizeStats, preserveColorPreset, speedValue, chromaMode, chromaColor,
    chromaTolerance, chromaBlend, greenScreen, lossyLevel, colorCount, showAdvancedOpt, dither, ditherMethod,
    colorMethod, optimizeLevel, dropDuplicates, removeFrames, stripMetadata,
    optimizeScale, unoptimize, interlace, showTextPanel, overlayText, textPosition, textAnchor,
    textSize, textFillColor, textBorderColor, textFont,
  ]);

  // Restore session on mount
  useEffect(() => {
    let canceled = false;

    loadLastSession().then(session => {
      if (canceled) return;
      if (session) {
        const settings = { ...DEFAULT_GIF_SETTINGS, ...session.settings };
        const selected = Array.isArray(session.selectedFrames)
          ? session.selectedFrames.filter(index => Number.isInteger(index) && index >= 0 && index < session.frames.length)
          : session.frames.map((_, index) => index);

        setSessionId(session.sessionId);
        setFrames(session.frames);
        setFps(session.fps);
        setOutputWidth(session.outputWidth);
        setOutputHeight(session.outputHeight);
        setSelectedFrames(new Set(selected));
        setOutputUrl(session.output?.url ?? null);
        setOutputSize(session.output?.size ?? null);
        setOptimizeStats(session.output?.optimizeStats ?? null);
        setPreserveColorPreset(settings.preserveColorPreset);

        setSpeedValue(settings.speedValue);
        setChromaMode(settings.chromaMode);
        setChromaColor(settings.chromaColor);
        setChromaTolerance(settings.chromaTolerance);
        // Older saved rows predate this field; the server's own default stands in.
        setChromaBlend(settings.chromaBlend ?? 0.1);
        setGreenScreen(settings.greenScreen ?? false);
        setLossyLevel(settings.lossyLevel);
        setColorCount(settings.colorCount);
        setShowAdvancedOpt(settings.showAdvancedOpt);
        setDither(settings.dither);
        setDitherMethod(settings.ditherMethod);
        setColorMethod(settings.colorMethod);
        setOptimizeLevel(settings.optimizeLevel);
        setDropDuplicates(settings.dropDuplicates);
        setRemoveFrames(settings.removeFrames);
        setStripMetadata(settings.stripMetadata);
        setOptimizeScale(settings.optimizeScale);
        setUnoptimize(settings.unoptimize);
        setInterlace(settings.interlace);
        setShowTextPanel(settings.showTextPanel);
        setOverlayText(settings.overlayText);
        setTextPosition(settings.textPosition);
        setTextAnchor(settings.textAnchor ?? null);
        setTextSize(settings.textSize);
        setTextFillColor(settings.textFillColor);
        setTextBorderColor(settings.textBorderColor);
        setTextFont(settings.textFont);
      }
    }).catch(console.error).finally(() => {
      if (!canceled) setSessionRestored(true);
    });

    // Fetch available fonts. An older backend hands back fontconfig's raw
    // lines, where one face lists every alias it answers to on one line
    // ("Bebas Neue,Bebas Neue Bold") — only the first is a real family.
    apiFetch('/api/gif/fonts').then(res => res.json()).then(data => {
      if (canceled || !Array.isArray(data.fonts) || !data.fonts.length) return;
      const families = [...new Set(
        data.fonts.map((f: string) => String(f).split(',')[0].trim()).filter(Boolean)
      )] as string[];
      if (families.length) setAvailableFonts(families.sort((a, b) => a.localeCompare(b)));
    }).catch(() => {});

    return () => {
      canceled = true;
    };
  }, []);

  // Hand the browser each installed font file so the picker draws in them.
  useEffect(() => {
    if (!availableFonts.length) return;
    const style = document.createElement('style');
    style.textContent = availableFonts.map(f =>
      `@font-face{font-family:"${gifFontFamily(f)}";`
      + `src:url("/api/gif/font-file/${encodeURIComponent(f)}");font-display:swap;}`
    ).join('\n');
    document.head.appendChild(style);
    return () => { style.remove(); };
  }, [availableFonts]);

  // A host that unmounts this on a tab switch would otherwise leave the preview
  // clock ticking behind whatever it swapped to.
  useEffect(() => () => {
    if (previewTimerRef.current !== null) {
      window.clearInterval(previewTimerRef.current);
      previewTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (active) return;
    if (previewTimerRef.current !== null) {
      window.clearInterval(previewTimerRef.current);
      previewTimerRef.current = null;
    }
    setPlaying(false);
  }, [active]);

  // Clear session and start fresh
  const startFresh = useCallback(async () => {
    if (sessionId) {
      await apiFetch(`/api/gif/session/${sessionId}`, { method: 'DELETE' }).catch(() => {});
    }
    await clearSessions();
    setSessionId(null);
    setFrames([]);
    setSelectedFrames(new Set());
    setOutputUrl(null);
    setOutputSize(null);
    setOptimizeStats(null);
    setOutputWidth(undefined);
    setOutputHeight(undefined);
    setPlaying(false);
  }, [sessionId]);

  // Import video/gif
  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    setLoading(true);
    setError(null);
    setOutputUrl(null);
    setOutputSize(null);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await apiFetch(`/api/gif/extract-frames?fps=${fps}`, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to extract frames');
      }

      const data = await res.json();
      setSessionId(data.sessionId);
      setFrames(data.frames);
      setSelectedFrames(new Set(data.frames.map((_: Frame, i: number) => i)));
    } catch (err: any) {
      setError(err.message || 'Import failed');
    } finally {
      setLoading(false);
    }
  }, [fps]);

  // Upload individual images
  const handleImageUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    // Materialise the list BEFORE clearing the input. e.target.files is a LIVE
    // FileList: resetting value empties it in place, so a reference taken
    // first ends up with nothing in it and the loop below runs zero times —
    // no files, no error, no clue. The twin button next to this one has
    // always worked because it pulls the File object out first.
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    e.target.value = '';

    setLoading(true);
    setError(null);

    try {
      let currentSessionId = sessionId;

      for (const file of files) {
        const formData = new FormData();
        formData.append('file', file);
        if (currentSessionId) {
          formData.append('sessionId', currentSessionId);
        }

        const res = await apiFetch('/api/gif/upload-frame', {
          method: 'POST',
          body: formData,
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Upload failed');
        }

        const data = await res.json();
        currentSessionId = data.sessionId;
        setSessionId(currentSessionId);
        setFrames(prev => [...prev, data.frame]);
        setSelectedFrames(prev => new Set([...prev, frames.length + files.indexOf(file)]));
      }
    } catch (err: any) {
      setError(err.message || 'Upload failed');
    } finally {
      setLoading(false);
    }
  }, [sessionId, frames.length]);

  // Toggle frame selection
  const toggleFrame = useCallback((index: number) => {
    setSelectedFrames(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  // Delete selected frames
  const deleteSelected = useCallback(() => {
    setFrames(prev => prev.filter((_, i) => !selectedFrames.has(i)));
    setSelectedFrames(new Set());
  }, [selectedFrames]);

  // Remove background, on the server. This used to load a model into the browser
  // from a package that was declared but never installed, so the button could only
  // ever fail. The Cutout tab's engine already does this locally on the server, so
  // point at that instead: no model download per use, and the same masks the
  // still-image tab produces.
  const removeBg = useCallback(async () => {
    if (selectedFrames.size === 0) return;

    setRemovingBg(true);
    setError(null);

    try {
      const framesToProcess = Array.from(selectedFrames).sort((a, b) => a - b);

      for (let i = 0; i < framesToProcess.length; i++) {
        const idx = framesToProcess[i];
        const frame = frames[idx];
        if (!frame) continue;

        setBgProgress(`Cutting frame ${i + 1}/${framesToProcess.length}…`);

        const res = await apiFetch(`/api/gif/cutout/${sessionId}/${frame.filename}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ feather: 1 }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(data?.error || 'Background removal failed');
        }

        setFrames(prev => prev.map((f, j) => j === idx ? { ...f, processed: true, url: `${f.url.split('?')[0]}?t=${Date.now()}` } : f));
      }
      setBgProgress(null);
    } catch (err: any) {
      console.error('[GifApp] Background removal error:', err);
      setError(err.message || 'Background removal failed');
      setBgProgress(null);
    } finally {
      setRemovingBg(false);
    }
  }, [sessionId, frames, selectedFrames]);

  // Pick a color off the preview itself.
  //
  // This used to hang off the padded panel around the preview and read a canvas
  // that had been pre-loaded from whichever frame was selected first — so the
  // coordinates were measured against the wrong box, the pixels could come from
  // a frame that wasn't the one on screen, and tapping a frame thumbnail (which
  // is what the button told you to do) only toggled its selection. Now the
  // handler is on the displayed image and samples exactly what was tapped.
  // Drag the caption around the placement pad. The anchor is stored as a
  // fraction of the frame rather than a pixel count, because ffmpeg places it
  // with the same fraction against the real output size — so a caption placed
  // on a 320px sticker lands in the same spot on a 128px emoji.
  const beginTextDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const pad = textPadRef.current;
    if (!pad) return;
    const label = pad.querySelector('span');
    if (!label) return;

    const padRect = pad.getBoundingClientRect();
    const labelRect = label.getBoundingClientRect();
    // ffmpeg's x=(w-text_w)*fx means the fraction runs over the space the text
    // leaves behind, not the frame — so the travel is the frame minus the text.
    const travelX = Math.max(1, padRect.width - labelRect.width);
    const travelY = Math.max(1, padRect.height - labelRect.height);
    // Grabbing the caption keeps the point under her finger. Tapping the frame
    // somewhere else means "put it here", so the text centres on the tap.
    const onLabel = e.clientX >= labelRect.left && e.clientX <= labelRect.right
      && e.clientY >= labelRect.top && e.clientY <= labelRect.bottom;
    const grabX = onLabel ? e.clientX - labelRect.left : labelRect.width / 2;
    const grabY = onLabel ? e.clientY - labelRect.top : labelRect.height / 2;

    const move = (ev: PointerEvent) => {
      const x = (ev.clientX - padRect.left - grabX) / travelX;
      const y = (ev.clientY - padRect.top - grabY) / travelY;
      setTextAnchor({
        x: Math.min(1, Math.max(0, x)),
        y: Math.min(1, Math.max(0, y)),
      });
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    move(e.nativeEvent);
  }, []);

  // Measure every frame once. Cheap — the browser has these decoded already for
  // the strip — and it is the only way the preview can know the canvas without
  // asking the server for a size list it would then have to keep in step.
  useEffect(() => {
    let canceled = false;
    for (const frame of frames) {
      if (frameSizes[frame.filename]) continue;
      const img = new Image();
      img.onload = () => {
        if (canceled || !img.naturalWidth || !img.naturalHeight) return;
        setFrameSizes(prev => prev[frame.filename]
          ? prev
          : { ...prev, [frame.filename]: { w: img.naturalWidth, h: img.naturalHeight } });
      };
      img.src = frame.url;
    }
    return () => { canceled = true; };
  }, [frames, frameSizes]);

  // THE CANVAS: the largest width and the largest height across the frames that
  // are actually going into the GIF, taken separately — exactly what the export
  // computes on the server before it hands anything to ffmpeg. Mixed orientations
  // therefore give a canvas bigger than either picture, and that is arithmetic
  // rather than a fault. Without this the preview measured one frame and stretched
  // every other one into its shape, so what she watched was never what she got.
  const canvasSize = useMemo(() => {
    const indices = selectedFrames.size > 0
      ? Array.from(selectedFrames).sort((a, b) => a - b)
      : frames.map((_, i) => i);
    let w = 0, h = 0;
    for (const i of indices) {
      const size = frames[i] ? frameSizes[frames[i].filename] : undefined;
      if (!size) continue;
      w = Math.max(w, size.w);
      h = Math.max(h, size.h);
    }
    return w > 0 && h > 0 ? { w, h } : null;
  }, [selectedFrames, frames, frameSizes]);

  // The size the GIF is ACTUALLY rendered at, which is not the size fields.
  // Preserve Color SEEDS the size fields with 320x320 and then honours whatever
  // they say — it used to override them, so changing the number did nothing and
  // the only symptom was every export coming out sticker-sized. With neither
  // field filled in there is no scale filter, so the output keeps the source
  // frame's own dimensions. The placement pad has to measure against this or the
  // caption is a lie: it was assuming 128, so a 30px caption on a 320px sticker
  // drew two and a half times too big on the pad and landed small in the corner.
  const renderSize = useMemo(() => {
    // Preserve Color used to hard-fall-back to 320x320 here AND on the request,
    // so picking Original under the preset silently re-imposed sticker size and
    // there was no way out of it but turning the preset off. It seeds the fields
    // and follows them, including following them to empty.
    const natural = canvasSize ?? frameNatural ?? { w: 128, h: 128 };
    if (outputWidth && outputHeight) return { w: outputWidth, h: outputHeight };
    if (outputWidth) return { w: outputWidth, h: Math.max(1, Math.round(outputWidth * natural.h / natural.w)) };
    if (outputHeight) return { w: Math.max(1, Math.round(outputHeight * natural.w / natural.h)), h: outputHeight };
    return natural;
  }, [outputWidth, outputHeight, canvasSize, frameNatural]);

  // Preserve Color letterboxes the frame into the square; every other path
  // scales straight to the target, which stretches. The pad shows whichever one
  // is going to happen.
  // Letterboxing only happens when there is a target box to letterbox INTO.
  const renderObjectFit = preserveColorPreset && outputWidth && outputHeight ? 'contain' : 'fill';

  // Where the padded canvas sits inside the output box. Stretch fills it; fit
  // scales it down until both sides are inside and centres what's left over.
  const canvasLayerStyle = useMemo((): React.CSSProperties => {
    if (!canvasSize) return { inset: 0 };
    if (renderObjectFit !== 'contain') return { inset: 0, width: '100%', height: '100%' };
    const scale = Math.min(renderSize.w / canvasSize.w, renderSize.h / canvasSize.h);
    return {
      width: `${((canvasSize.w * scale) / renderSize.w) * 100}%`,
      height: `${((canvasSize.h * scale) / renderSize.h) * 100}%`,
      left: '50%',
      top: '50%',
      transform: 'translate(-50%, -50%)',
    };
  }, [canvasSize, renderObjectFit, renderSize]);

  // Where the caption sits on the pad: a hand-placed anchor, or the preset's
  // own geometry (ffmpeg pads the top and bottom presets by 10px).
  const textOverlayPlacement = useMemo((): React.CSSProperties => {
    if (textAnchor) {
      return {
        left: `${textAnchor.x * 100}%`,
        top: `${textAnchor.y * 100}%`,
        transform: `translate(${-textAnchor.x * 100}%, ${-textAnchor.y * 100}%)`,
      };
    }
    const centered = { left: '50%', transform: 'translateX(-50%)' } as const;
    if (textPosition === 'top') return { ...centered, top: `${(10 / renderSize.h) * 100}%` };
    if (textPosition === 'center') return { ...centered, top: '50%', transform: 'translate(-50%, -50%)' };
    return { ...centered, bottom: `${(10 / renderSize.h) * 100}%` };
  }, [textAnchor, textPosition, renderSize]);

  // The preview sits at the foot of a long page, and Pick Color is most of the
  // way up it — so arming the eyedropper used to mean scrolling to find the
  // thing you were told to tap. Bring it to her instead.
  //
  // Scrolling her down to the preview was the wrong answer twice over: the
  // swatch, the hex field and the tolerance all live up in the chroma panel, so
  // every pick cost a trip down and a trip back to see what she'd got. The
  // picker comes to the controls instead. This only nudges it into view if the
  // panel is half off the screen — it's a few hundred pixels, not a journey.
  useEffect(() => {
    if (!pickingColor) return;
    const frame = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        pickerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [pickingColor]);

  const handleColorPick = useCallback((e: React.MouseEvent<HTMLImageElement>) => {
    if (!pickingColor) return;
    const img = e.currentTarget;
    const rect = img.getBoundingClientRect();

    // object-contain letterboxes the frame inside its box, so the drawn area is
    // not the element's area. Map through the drawn rect or the sample lands
    // off-subject on any frame that isn't the box's aspect ratio.
    const scale = Math.min(rect.width / img.naturalWidth, rect.height / img.naturalHeight);
    const drawnWidth = img.naturalWidth * scale;
    const drawnHeight = img.naturalHeight * scale;
    const offsetX = (rect.width - drawnWidth) / 2;
    const offsetY = (rect.height - drawnHeight) / 2;
    const x = Math.round((e.clientX - rect.left - offsetX) / scale);
    const y = Math.round((e.clientY - rect.top - offsetY) / scale);
    if (x < 0 || y < 0 || x >= img.naturalWidth || y >= img.naturalHeight) return;

    const canvas = colorPickCanvasRef.current ?? document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    try {
      ctx.drawImage(img, 0, 0);
      const pixel = ctx.getImageData(x, y, 1, 1).data;
      const hex = '#' + [pixel[0], pixel[1], pixel[2]].map(c => c.toString(16).padStart(2, '0')).join('').toUpperCase();
      setChromaColor(hex);
      setPickingColor(false);
    } catch {
      setPickingColor(false);
    }
  }, [pickingColor]);

  // Start color picking mode — show a frame that is actually in the selection,
  // so the color comes from a frame the key will be applied to.
  const startColorPick = useCallback(() => {
    if (pickingColor) { setPickingColor(false); return; }
    const selectedIndices = Array.from(selectedFrames).sort((a, b) => a - b);
    if (selectedIndices.length > 0 && !selectedFrames.has(previewFrame)) {
      setPreviewFrame(selectedIndices[0]);
    }
    setPickingColor(true);
  }, [pickingColor, selectedFrames, previewFrame]);

  // Load dimensions for the crop preview — of the frame she is LOOKING at, not
  // frame one. The cropper used to hardcode frames[0], so picking a different
  // frame in the strip changed the viewer and the cropper carried on showing
  // the first picture, which made per-frame framing impossible to even see.
  const loadOriginalDimensions = useCallback(async (index: number) => {
    const frame = frames[index] ?? frames[0];
    if (!frame) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      setOriginalDimensions({ w: img.width, h: img.height });
      setCropX(0);
      setCropY(0);
      setCropW(img.width);
      setCropH(img.height);
    };
    img.src = frame.url;
  }, [frames]);

  // Open crop panel
  const openCropPanel = useCallback(() => {
    loadOriginalDimensions(previewFrame);
    setShowCrop(true);
  }, [loadOriginalDimensions, previewFrame]);

  // Follow the strip. Tapping a thumbnail while the cropper is open re-reads that
  // frame's own size and starts its box fresh, so each picture is framed on its
  // own terms instead of inheriting a box measured against a different one.
  useEffect(() => {
    if (!showCrop) return;
    loadOriginalDimensions(previewFrame);
  }, [showCrop, previewFrame, loadOriginalDimensions]);

  // The box lives in the image's OWN pixels, and every gesture is a pointer
  // gesture with capture — one code path for a finger and a mouse instead of
  // the two parallel copies of this arithmetic that used to sit here and drift
  // apart. Same model as the Cutout cropper, which is the one that holds up.
  const cropDrag = useRef<'new' | 'move' | 'nw' | 'ne' | 'sw' | 'se' | null>(null);
  const cropAnchor = useRef<{ x: number; y: number } | null>(null);
  const cropGrabOffset = useRef<{ x: number; y: number } | null>(null);

  const toCropPoint = useCallback((clientX: number, clientY: number) => {
    const el = cropPreviewRef.current;
    if (!el || !originalDimensions) return null;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: ((clientX - rect.left) / rect.width) * originalDimensions.w,
      y: ((clientY - rect.top) / rect.height) * originalDimensions.h,
    };
  }, [originalDimensions]);

  const cropPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const p = toCropPoint(e.clientX, e.clientY);
    if (!p || !originalDimensions) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    // A corner is grabbed by being NEAR it, at a distance set by the picture
    // rather than by the box. The old threshold was a fifth of the box, so the
    // handles crept inward as you resized — and once the box was small enough
    // the four corner zones met in the middle and there was nothing left to
    // drag the box by. Fingertips are wider than handles.
    const grab = Math.max(originalDimensions.w, originalDimensions.h) * 0.07;
    const near = (cx: number, cy: number) => Math.abs(p.x - cx) < grab && Math.abs(p.y - cy) < grab;
    if (near(cropX, cropY)) { cropDrag.current = 'nw'; return; }
    if (near(cropX + cropW, cropY)) { cropDrag.current = 'ne'; return; }
    if (near(cropX, cropY + cropH)) { cropDrag.current = 'sw'; return; }
    if (near(cropX + cropW, cropY + cropH)) { cropDrag.current = 'se'; return; }
    if (p.x > cropX && p.x < cropX + cropW && p.y > cropY && p.y < cropY + cropH) {
      cropDrag.current = 'move';
      cropGrabOffset.current = { x: p.x - cropX, y: p.y - cropY };
      return;
    }
    cropDrag.current = 'new';
    cropAnchor.current = { x: p.x, y: p.y };
    setCropX(p.x); setCropY(p.y); setCropW(0); setCropH(0);
  }, [toCropPoint, originalDimensions, cropX, cropY, cropW, cropH]);

  const cropPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const mode = cropDrag.current;
    if (!mode || !originalDimensions) return;
    const p = toCropPoint(e.clientX, e.clientY);
    if (!p) return;
    const maxW = originalDimensions.w;
    const maxH = originalDimensions.h;
    const px = Math.max(0, Math.min(p.x, maxW));
    const py = Math.max(0, Math.min(p.y, maxH));

    if (mode === 'move') {
      const off = cropGrabOffset.current;
      if (!off) return;
      setCropX(Math.max(0, Math.min(px - off.x, maxW - cropW)));
      setCropY(Math.max(0, Math.min(py - off.y, maxH - cropH)));
      return;
    }

    if (mode === 'new') {
      const a = cropAnchor.current;
      if (!a) return;
      let w = Math.abs(px - a.x);
      let h = Math.abs(py - a.y);
      if (cropSquare) { const side = Math.min(w, h); w = side; h = side; }
      const x = Math.max(0, px < a.x ? a.x - w : a.x);
      const y = Math.max(0, py < a.y ? a.y - h : a.y);
      setCropX(x); setCropY(y);
      setCropW(Math.min(w, maxW - x));
      setCropH(Math.min(h, maxH - y));
      return;
    }

    // Corner drags pin the OPPOSITE corner and move only the one being held.
    const right = cropX + cropW;
    const bottom = cropY + cropH;
    let x = cropX, y = cropY, w = cropW, h = cropH;
    if (mode === 'nw' || mode === 'sw') { x = Math.min(px, right); w = right - x; }
    if (mode === 'ne' || mode === 'se') { w = Math.max(0, px - x); }
    if (mode === 'nw' || mode === 'ne') { y = Math.min(py, bottom); h = bottom - y; }
    if (mode === 'sw' || mode === 'se') { h = Math.max(0, py - y); }
    if (cropSquare) {
      const side = Math.min(w, h);
      if (mode === 'nw' || mode === 'sw') x = right - side;
      if (mode === 'nw' || mode === 'ne') y = bottom - side;
      w = side; h = side;
    }
    x = Math.max(0, x); y = Math.max(0, y);
    setCropX(x); setCropY(y);
    setCropW(Math.max(0, Math.min(w, maxW - x)));
    setCropH(Math.max(0, Math.min(h, maxH - y)));
  }, [toCropPoint, originalDimensions, cropX, cropY, cropW, cropH, cropSquare]);

  const cropPointerUp = useCallback(() => {
    cropDrag.current = null;
    cropAnchor.current = null;
    cropGrabOffset.current = null;
  }, []);

  // Turning the lock on snaps whatever is already drawn rather than making
  // her start the box again.
  const toggleCropSquare = useCallback(() => {
    setCropSquare((on) => {
      if (!on) {
        const side = Math.min(cropW, cropH);
        if (side > 0) { setCropW(side); setCropH(side); }
      }
      return !on;
    });
  }, [cropW, cropH]);

  // Apply crop to all frames
  const applyCrop = useCallback(async () => {
    if (!sessionId || frames.length === 0) return;

    setCropping(true);
    setError(null);

    try {
      const res = await apiFetch(`/api/gif/crop/${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          x: cropX, y: cropY, width: cropW, height: cropH,
          // No filename means every frame, which is what the route has always done.
          ...(cropAllFrames ? {} : { filename: frames[previewFrame]?.filename }),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Crop failed');
      }

      // Refresh frame URLs to bust cache
      setFrames(prev => prev.map(f => ({ ...f, url: `${f.url.split('?')[0]}?t=${Date.now()}` })));
      // Cropping one frame changes only that frame's size, so the measured set
      // has to be dropped and re-read or the preview keeps drawing the old canvas.
      setFrameSizes({});
      setShowCrop(false);
      setOriginalDimensions({ w: cropW, h: cropH });
      setCropX(0);
      setCropY(0);
    } catch (err: any) {
      setError(err.message || 'Crop failed');
    } finally {
      setCropping(false);
    }
  }, [sessionId, frames, cropX, cropY, cropW, cropH, cropAllFrames, previewFrame]);

  // Put the chosen frames back the way they arrived. The route is named for the
  // cutout because that is where it was first needed, but it restores whatever
  // original was saved — colour removal writes one too.
  const revertBg = useCallback(async () => {
    if (selectedFrames.size === 0 || !sessionId) return;
    setRemovingBg(true);
    setError(null);
    setBgProgress('Putting frames back...');
    try {
      const chosen = Array.from(selectedFrames).sort((a, b) => a - b);
      for (let i = 0; i < chosen.length; i++) {
        const idx = chosen[i];
        const frame = frames[idx];
        if (!frame) continue;
        setBgProgress(`Reverting frame ${i + 1}/${chosen.length}...`);
        const res = await apiFetch(`/api/gif/cutout/${sessionId}/${frame.filename}/revert`, { method: 'POST' });
        // A frame that was never changed has no original to restore. That is not
        // a failure worth stopping the run for — it is already what it was.
        if (!res.ok && res.status !== 404) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Revert failed');
        }
        setFrames(prev => prev.map((f, j) => j === idx
          ? { ...f, processed: false, chromaKeyed: false, url: `${f.url.split('?')[0]}?t=${Date.now()}` }
          : f));
      }
      // Sizes are keyed by filename and a revert can change the picture behind
      // one, so drop the measurements and let them be taken again.
      setFrameSizes({});
      setBgProgress(null);
    } catch (err: any) {
      setError(err.message || 'Revert failed');
      setBgProgress(null);
    } finally {
      setRemovingBg(false);
    }
  }, [sessionId, frames, selectedFrames]);

  // Commit what has been painted on the frame in front of her. This is the
  // DELIBERATE act, and it is also how she SEES what she did — the route hands
  // back the corrected frame and it replaces the one on screen. Without it she
  // would only find out on the next pass, or in the finished GIF.
  const applyPaint = useCallback(async (): Promise<boolean> => {
    const frame = frames[previewFrame];
    if (!sessionId || !frame || paint.strokes.length === 0) return true;
    setError(null);
    setRemovingBg(true);
    setBgProgress('Painting...');
    try {
      const { restore, erase } = await paint.masks();
      if (!restore && !erase) return true;
      const body = new FormData();
      if (restore) body.append('restore', restore, 'restore.png');
      if (erase) body.append('erase', erase, 'erase.png');
      const res = await apiFetch(`/api/gif/mask-paint/${sessionId}/${frame.filename}`, { method: 'POST', body });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Painting failed');
      setFrames(prev => prev.map((f, j) => j === previewFrame
        ? { ...f, processed: true, url: `${f.url.split('?')[0]}?t=${Date.now()}` }
        : f));
      paint.clear();
      setBgProgress(null);
      return true;
    } catch (err: any) {
      setError(err.message || 'Painting failed');
      setBgProgress(null);
      return false;
    } finally {
      setRemovingBg(false);
    }
  }, [sessionId, frames, previewFrame, paint]);

  // Stepping is a NET, not the mechanism. Pending strokes are applied rather than
  // dropped — and if that apply fails we do NOT move, or a swipe silently eats
  // the painting and the only way to find out is scrubbing back through thirty
  // frames looking for the one that reverted.
  const stepPaintFrame = useCallback(async (delta: number) => {
    const next = previewFrame + delta;
    if (next < 0 || next >= frames.length) return;
    if (paint.strokes.length > 0 && !(await applyPaint())) return;
    setPreviewFrame(next);
  }, [previewFrame, frames.length, paint.strokes.length, applyPaint]);

  // Apply chroma key removal
  const applyChromaKey = useCallback(async () => {
    if (selectedFrames.size === 0 || !sessionId) return;

    setRemovingBg(true);
    setError(null);
    setBgProgress('Applying chroma key...');

    try {
      const framesToProcess = Array.from(selectedFrames).sort((a, b) => a - b);

      for (let i = 0; i < framesToProcess.length; i++) {
        const idx = framesToProcess[i];
        const frame = frames[idx];
        if (!frame) continue;

        setBgProgress(`Processing frame ${i + 1}/${framesToProcess.length}...`);

        const res = await apiFetch(`/api/gif/chroma-key/${sessionId}/${frame.filename}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ color: chromaColor, tolerance: chromaTolerance, blend: chromaBlend, mode: greenScreen ? 'chroma' : 'color' }),
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Chroma key failed');
        }

        setFrames(prev => prev.map((f, j) => j === idx ? { ...f, chromaKeyed: true, url: `${f.url.split('?')[0]}?t=${Date.now()}` } : f));
      }
      setBgProgress(null);
    } catch (err: any) {
      console.error('[GifApp] Chroma key error:', err);
      setError(err.message || 'Chroma key failed');
      setBgProgress(null);
    } finally {
      setRemovingBg(false);
    }
  }, [sessionId, frames, selectedFrames, chromaColor, chromaTolerance, chromaBlend, greenScreen]);

  // Create GIF
  const createGif = useCallback(async () => {
    if (frames.length === 0) return;

    setLoading(true);
    setError(null);
    setOutputUrl(null);
    setOutputSize(null);

    try {
      const selectedFrameFiles = Array.from(selectedFrames)
        .sort((a, b) => a - b)
        .map(i => frames[i]?.filename)
        .filter(Boolean);

      if (selectedFrameFiles.length === 0) {
        throw new Error('No frames selected');
      }

      const res = await apiFetch('/api/gif/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          frames: selectedFrameFiles,
          fps,
          delayMs: delayMs > 0 ? delayMs : undefined,
          loop: true,
          optimize: true,
          width: outputWidth,
          height: outputHeight,
          fit: Boolean(preserveColorPreset && outputWidth && outputHeight),
          speed: speedValue !== 1 ? speedValue : undefined,
          lossy: preserveColorPreset ? undefined : (lossyLevel > 0 ? lossyLevel : undefined),
          colors: preserveColorPreset ? undefined : (colorCount < 256 ? colorCount : undefined),
          dither: preserveColorPreset ? false : dither,
          text: overlayText.trim() ? {
            content: overlayText,
            position: textPosition,
            anchor: textAnchor,
            fontSize: textSize,
            fontColor: textFillColor,
            borderColor: textBorderColor,
            fontFamily: textFont,
          } : undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create GIF');
      }

      let data = await res.json();

      if (preserveColorPreset) {
        const optimized = await apiFetch(`/api/gif/optimize/${sessionId}/${data.filename}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // These used to be hardcoded here, which meant the whole Optimization
          // panel was decoration while the preset was on: Keep all was set, shown
          // as set, and then overruled by a 2 written into this request. The preset
          // SEEDS these values when you switch it on and follows you afterwards,
          // same contract as the size fields.
          body: JSON.stringify({
            lossy: lossyLevel > 0 ? lossyLevel : undefined,
            optimizeLevel,
            dropDuplicates,
            removeFrames: removeFrames >= 2 ? removeFrames : undefined,
            stripMetadata,
            maxBytes: 512 * 1024,
          }),
        });
        if (!optimized.ok) {
          const failure = await optimized.json();
          throw new Error(failure.error || 'Discord preset optimization failed');
        }
        data = await optimized.json();
        setOptimizeStats({
          savedPercent: data.savedPercent ?? 0,
          framesDropped: data.framesDropped ?? 0,
          beforeKb: data.sizeBeforeKb ?? 0,
        });
      }

      setOutputUrl(data.url);
      setOutputSize({ kb: data.sizeKb, ok: data.discordOk, limitKb: data.maxKb ?? (preserveColorPreset ? 512 : 256) });
    } catch (err: any) {
      setError(err.message || 'GIF creation failed');
    } finally {
      setLoading(false);
    }
  }, [sessionId, frames, selectedFrames, fps, delayMs, outputWidth, outputHeight, speedValue, lossyLevel, colorCount, dither, overlayText, textPosition, textAnchor, textSize, textFillColor, textBorderColor, textFont, preserveColorPreset, optimizeLevel, dropDuplicates, removeFrames, stripMetadata]);

  useEffect(() => {
    if (!playing) setPadFrame(previewFrame);
  }, [playing, previewFrame]);

  // Playback used to swap one <img>'s src ten times a second. The frame route
  // answers `Cache-Control: public, max-age=0`, so every swap is a conditional
  // request over the network for a ~350KB PNG — and an <img> keeps showing its
  // last frame until the next one arrives and decodes. On a phone that reads as
  // a preview that doesn't move at all. Every selected frame is stacked in the
  // tile instead and playback just flips which one is visible: loaded once,
  // decoded once, no request after the first.
  const playbackFrames = useMemo(
    () => Array.from(selectedFrames).sort((a, b) => a - b).filter(i => frames[i]),
    [selectedFrames, frames],
  );
  // The tile stacks the frames it might need to show. That used to be the
  // SELECTED ones only, which meant tapping an unselected frame could never
  // bring it up — the whole reason only frame one was ever visible.
  const stackFrames = useMemo(() => {
    const set = new Set(playbackFrames);
    if (frames[previewFrame]) set.add(previewFrame);
    return Array.from(set).sort((a, b) => a - b);
  }, [playbackFrames, previewFrame, frames]);
  const visibleFrame = frames[previewFrame]
    ? previewFrame
    : (playbackFrames[0] ?? 0);

  // One definition of the caption, worn by both the placement pad and the
  // preview tile. Two copies of this is how they drift apart, and the pad
  // drifting from the render is the bug we just spent the night on.
  const captionStyle = useMemo((): React.CSSProperties => ({
    // fontsize is pixels of the rendered frame, and both surfaces are that
    // frame at screen scale — so the same share of the width is the same
    // caption. What you place is what you get.
    fontSize: `${((textSize / renderSize.w) * 100).toFixed(3)}cqw`,
    fontFamily: `"${gifFontFamily(textFont)}", sans-serif`,
    lineHeight: 1.2,
    color: textFillColor,
    // ffmpeg's borderw is a flat 2px of the frame, not a share of the type —
    // so it has to be quoted against the caption.
    WebkitTextStroke: `${(2 / Math.max(1, textSize)).toFixed(3)}em ${textBorderColor}`,
    paintOrder: 'stroke fill',
    ...textOverlayPlacement,
  }), [textSize, renderSize, textFont, textFillColor, textBorderColor, textOverlayPlacement]);

  // Preview animation
  // What the finished GIF will actually do: an explicit hold time wins over the
  // frame rate, and the speed multiplier scales whichever is in play. The
  // preview used to run on 1000/fps alone, which is why dragging speed changed
  // the export and did nothing to the thing you were watching.
  const frameDurationMs = useMemo(() => {
    const base = delayMs > 0 ? delayMs : 1000 / Math.max(1, fps);
    return Math.max(20, base / Math.max(0.25, Math.min(4, speedValue || 1)));
  }, [delayMs, fps, speedValue]);

  const togglePreview = useCallback(() => {
    setPlaying(p => !p);
  }, []);

  // Driven by an effect rather than set up once at play time, so changing the
  // rate, the hold or the speed re-times the preview while it is running.
  useEffect(() => {
    if (previewTimerRef.current) {
      clearInterval(previewTimerRef.current);
      previewTimerRef.current = null;
    }
    if (!playing) return;
    previewTimerRef.current = window.setInterval(() => {
      setPreviewFrame(prev => {
        const selectedIndices = Array.from(selectedFrames).sort((a, b) => a - b);
        if (selectedIndices.length === 0) return 0;
        const currentPos = selectedIndices.indexOf(prev);
        const nextPos = (currentPos + 1) % selectedIndices.length;
        return selectedIndices[nextPos];
      });
    }, frameDurationMs);
    return () => {
      if (previewTimerRef.current) {
        clearInterval(previewTimerRef.current);
        previewTimerRef.current = null;
      }
    };
  }, [playing, selectedFrames, frameDurationMs]);

  // Download GIF
  const downloadGif = useCallback(() => {
    if (!outputUrl) return;
    const a = document.createElement('a');
    // Ask for the file, not the view — the native shell only saves what the
    // server marks as an attachment (it ignores the download attribute).
    a.href = saveHref(outputUrl);
    a.download = `emoji-${Date.now()}.gif`;
    a.click();
  }, [outputUrl]);

  // Optimize GIF (reduce size further)
  const optimizeGif = useCallback(async () => {
    if (!outputUrl || !sessionId) return;

    // Extract filename from URL
    const match = outputUrl.match(/\/([^/]+\.gif)$/);
    if (!match) return;
    const filename = match[1];

    setOptimizing(true);
    setError(null);

    try {
      const res = await apiFetch(`/api/gif/optimize/${sessionId}/${filename}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lossy: lossyLevel,
          colors: colorCount,
          dither,
          ditherMethod,
          colorMethod,
          optimizeLevel,
          dropDuplicates,
          removeFrames: removeFrames >= 2 ? removeFrames : undefined,
          stripMetadata,
          unoptimize,
          interlace,
          scale: optimizeScale < 100 ? optimizeScale / 100 : undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Optimization failed');
      }

      const data = await res.json();
      setOutputUrl(data.url);
      setOutputSize({ kb: data.sizeKb, ok: data.discordOk, limitKb: data.maxKb ?? 256 });
      setOptimizeStats({
        savedPercent: data.savedPercent ?? 0,
        framesDropped: data.framesDropped ?? 0,
        beforeKb: data.sizeBeforeKb ?? 0,
      });
    } catch (err: any) {
      setError(err.message || 'Optimization failed');
    } finally {
      setOptimizing(false);
    }
  }, [outputUrl, sessionId, lossyLevel, colorCount, dither, ditherMethod, colorMethod,
      optimizeLevel, dropDuplicates, removeFrames, stripMetadata, unoptimize, interlace, optimizeScale]);

  // Change GIF speed
  const changeSpeed = useCallback(async () => {
    if (!outputUrl || !sessionId) return;

    const match = outputUrl.match(/\/([^/]+\.gif)$/);
    if (!match) return;
    const filename = match[1];

    setChangingSpeed(true);
    setError(null);

    try {
      const res = await apiFetch(`/api/gif/speed/${sessionId}/${filename}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ speed: speedValue }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Speed change failed');
      }

      const data = await res.json();
      setOutputUrl(data.url);
      setOutputSize({ kb: data.sizeKb, ok: data.discordOk });
    } catch (err: any) {
      setError(err.message || 'Speed change failed');
    } finally {
      setChangingSpeed(false);
    }
  }, [outputUrl, sessionId, speedValue]);

  // Add text overlay
  const addTextOverlay = useCallback(async () => {
    if (!outputUrl || !sessionId || !overlayText.trim()) return;

    const match = outputUrl.match(/\/([^/]+\.gif)$/);
    if (!match) return;
    const filename = match[1];

    setAddingText(true);
    setError(null);

    try {
      const res = await apiFetch(`/api/gif/add-text/${sessionId}/${filename}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: overlayText,
          position: textPosition,
          anchor: textAnchor,
          fontSize: textSize,
          fontColor: textFillColor,
          borderColor: textBorderColor,
          fontFamily: textFont,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Text overlay failed');
      }

      const data = await res.json();
      setOutputUrl(data.url);
      setOutputSize({ kb: data.sizeKb, ok: data.discordOk });
      setShowTextPanel(false);
      setOverlayText('');
    } catch (err: any) {
      setError(err.message || 'Text overlay failed');
    } finally {
      setAddingText(false);
    }
  }, [outputUrl, sessionId, overlayText, textPosition, textAnchor, textSize, textFillColor, textBorderColor, textFont]);

  // Size presets
  const sizePresets = [
    { label: 'Discord Emoji', w: 128, h: 128 },
    { label: 'Sticker', w: 320, h: 320 },
    { label: '64px', w: 64, h: 64 },
    { label: 'Original', w: undefined, h: undefined },
  ];

  return (
    <motion.div
      initial={embedded ? false : { opacity: 0, y: 20 }}
      animate={embedded ? undefined : { opacity: 1, y: 0 }}
      exit={embedded ? undefined : { opacity: 0, y: 20 }}
      className={cn(embedded ? "contents" : "absolute inset-0 flex flex-col z-20")}
    >
      {/* Header */}
      {!embedded && (
        <header
          className={cn("gl-shell-header flex items-center gap-3 px-4 pb-3", colors.pageBg)}
          style={{ paddingTop: 'calc(var(--sat) + 0.75rem)' }}
        >
          <button onClick={onClose} className={cn("p-1.5 rounded-full transition-colors", colors.textMuted)}>
            <ChevronLeft className="w-5 h-5" />
          </button>
          <h1 className={cn("text-lg font-semibold flex-1", colors.textMain)}>GIF Lab</h1>
          {frames.length > 0 && (
            <button
              onClick={startFresh}
              className={cn("p-1.5 rounded-full transition-colors", colors.textMuted)}
              title="Start fresh"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
          )}
        </header>
      )}

      {/* Content */}
      <div className={cn(
        "space-y-4",
        !embedded && "flex-1 overflow-auto px-4 pb-4",
        !embedded && colors.pageBg,
      )}>
        {embedded && frames.length > 0 && (
          <div className="flex justify-end">
            <button
              onClick={startFresh}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs shadow-sm backdrop-blur-md transition-colors",
                colors.panelBg,
                colors.panelBorder,
                colors.textMain,
              )}
              title="Start fresh"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Start fresh
            </button>
          </div>
        )}
        {/* Import buttons */}
        <div className={cn("p-4 rounded-2xl border backdrop-blur-md space-y-3", colors.panelBg, colors.panelBorder)}>
          <div className="flex gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*,.gif"
              onChange={handleFileSelect}
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={loading}
              className={cn("flex-1 py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 border", colors.panelBorder, colors.textMain)}
            >
              <Upload className="w-4 h-4" />Import Video/GIF
            </button>
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={handleImageUpload}
              className="hidden"
              id="gif-image-upload"
            />
            <label
              htmlFor="gif-image-upload"
              className={cn("flex-1 py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 border cursor-pointer", colors.panelBorder, colors.textMain)}
            >
              <Upload className="w-4 h-4" />Add Images
            </label>
          </div>
          <div className="flex items-center gap-3">
            <label className={cn("text-xs", colors.textMuted)}>FPS:</label>
            <input
              type="range"
              min={1}
              max={30}
              value={fps}
              onChange={(e) => setFps(parseInt(e.target.value))}
              className="flex-1"
              style={{ accentColor: colors.accent }}
            />
            <span className={cn("text-xs w-8 text-right", colors.textMain)}>{fps}</span>
          </div>
          <div className="flex items-center gap-3 mt-3">
            <label className={cn("text-xs font-medium uppercase tracking-wide", colors.textMuted)}>
              Hold
            </label>
            <input
              type="number"
              min={0}
              step={50}
              placeholder="off"
              value={delayMs || ''}
              onChange={(e) => setDelayMs(Math.max(0, parseInt(e.target.value) || 0))}
              className={cn("w-24 px-2 py-1 rounded-lg border bg-transparent text-sm", colors.panelBorder, colors.textMain)}
            />
            <span className={cn("text-xs", colors.textMuted)}>
              {delayMs > 0 ? `ms per frame` : 'ms per frame — blank uses the rate'}
            </span>
          </div>
        </div>

        {/* Frame timeline */}
        {frames.length > 0 && (
          <div className={cn("p-4 rounded-2xl border backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
            <div className="flex items-center justify-between mb-2">
              <label className={cn("text-xs font-medium uppercase tracking-wide", colors.textMuted)}>
                Frames ({selectedFrames.size}/{frames.length})
              </label>
              <div className="flex gap-1">
                <button
                  onClick={() => setSelectedFrames(new Set(frames.map((_, i) => i)))}
                  className={cn("px-2 py-1 rounded text-xs", colors.textMuted)}
                >
                  All
                </button>
                <button
                  onClick={() => setSelectedFrames(new Set())}
                  className={cn("px-2 py-1 rounded text-xs", colors.textMuted)}
                >
                  None
                </button>
                {selectedFrames.size > 0 && (
                  <button
                    onClick={deleteSelected}
                    className={cn("px-2 py-1 rounded text-xs text-red-400")}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>
            <div className="flex gap-1.5 overflow-x-auto pb-2">
              {frames.map((frame, i) => (
                <div
                  key={frame.filename}
                  // While picking a color, a thumbnail tap brings that frame up
                  // to pick from rather than changing the selection — tapping the
                  // frame you want is the whole gesture people expect here.
                  // A tap always brings that frame up in the viewer. Selection
                  // moved onto the tick in the corner, because a thumbnail that
                  // only ever toggles a checkbox leaves no way to LOOK at a
                  // frame — which is why the viewer never left frame one.
                  onClick={() => setPreviewFrame(i)}
                  className={cn(
                    // 64px. The circle in the corner is the ONLY thing that
                    // changes the selection, and at 16px on a 56px tile it was
                    // both unhittable and, on a dark frame, barely visible as a
                    // control at all. It needs to be findable and touchable
                    // WITHOUT eating the tile — a disc a third the width of the
                    // picture is its own kind of wrong.
                    "flex-shrink-0 w-16 h-16 rounded-lg overflow-hidden border-2 cursor-pointer transition-all relative",
                    // Ring = the frame you are looking at. Dimmed = not in the
                    // GIF. Two different facts, so two different signals.
                    previewFrame === i ? "border-current" : "border-transparent",
                    selectedFrames.has(i) || pickingColor ? "opacity-100" : "opacity-50",
                  )}
                  style={previewFrame === i ? { borderColor: colors.accent } : undefined}
                >
                  <img src={frame.url} alt="" className="w-full h-full object-cover" />
                  {!pickingColor && (
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleFrame(i); }}
                      aria-label={selectedFrames.has(i) ? 'Deselect frame' : 'Select frame'}
                      className="absolute bottom-0 left-0 p-1.5 flex items-center justify-center"
                    >
                      {/* The visible disc is 20px; the padding around it makes the
                          touch target half again as big without the dot growing
                          into the picture. A ring when it is out, filled when it
                          is in — so it reads as a control either way, including
                          on a dark frame where a dark dot simply vanished. */}
                      <span
                        className="w-5 h-5 rounded-full flex items-center justify-center border-2 shadow"
                        style={{
                          borderColor: colors.accent,
                          background: selectedFrames.has(i) ? colors.accent : 'rgba(0,0,0,0.6)',
                        }}
                      >
                        {selectedFrames.has(i) && <Check className="w-3 h-3" style={{ color: 'var(--gl-on-accent)' }} />}
                      </span>
                    </button>
                  )}
                  {(frame.processed || frame.chromaKeyed) && (
                    <div className="absolute top-1 right-1 w-4 h-4 rounded-full bg-green-500 flex items-center justify-center">
                      <Check className="w-2.5 h-2.5 text-white" />
                    </div>
                  )}
                </div>
              ))}
            </div>
            {/* The app never said this out loud and the readme did. Two gestures
                on one thumbnail is not guessable, and the person who cannot find
                the second one concludes selection is broken rather than hidden. */}
            <p className={cn("text-[11px] mt-1", colors.textMuted)}>
              Tap a frame to look at it. Tap its circle to include or leave it out.
            </p>
          </div>
        )}

        {/* Crop Tool */}
        {frames.length > 0 && !showCrop && (
          <div className={cn("p-4 rounded-2xl border backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
            <button
              onClick={openCropPanel}
              className={cn("w-full py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 border", colors.panelBorder, colors.textMain)}
            >
              <Crop className="w-4 h-4" />Crop Frames
            </button>
          </div>
        )}

        {/* Crop Panel */}
        {showCrop && originalDimensions && (
          <div className={cn("p-4 rounded-2xl border backdrop-blur-md space-y-3", colors.panelBg, colors.panelBorder)}>
            <div className="flex items-center justify-between">
              <label className={cn("text-xs font-medium uppercase tracking-wide", colors.textMuted)}>
                Crop — frame {previewFrame + 1} of {frames.length}
              </label>
              <button
                onClick={() => setShowCrop(false)}
                className={cn("text-xs", colors.textMuted)}
              >
                Cancel
              </button>
            </div>
            {/* Visual crop preview */}
            {/*
              touchAction: 'none' is what actually stops the page scrolling under a drag.
              React registers touchstart/touchmove as passive listeners, so the
              e.preventDefault() calls in the touch handlers below are silently ignored —
              the browser has to be told up front that this element owns its gestures.

              onTouchCancel matters too: an interrupted touch (notification, system gesture)
              never fires touchend, which left the box following her finger after she let go.
            */}
            <div
              ref={cropPreviewRef}
              className="relative mx-auto cursor-crosshair select-none"
              style={{
                maxWidth: '100%',
                aspectRatio: `${originalDimensions.w}/${originalDimensions.h}`,
                touchAction: 'none',
              }}
              onPointerDown={cropPointerDown}
              onPointerMove={cropPointerMove}
              onPointerUp={cropPointerUp}
              onPointerCancel={cropPointerUp}
            >
              <img
                src={frames[previewFrame]?.url ?? frames[0]?.url}
                alt="Crop preview"
                className="w-full h-full object-contain rounded-lg"
                draggable={false}
              />
              {/* Dark overlay outside crop area */}
              <div
                className="absolute inset-0 pointer-events-none"
                style={{
                  background: `linear-gradient(to right, rgba(0,0,0,0.6) ${(cropX / originalDimensions.w) * 100}%, transparent ${(cropX / originalDimensions.w) * 100}%, transparent ${((cropX + cropW) / originalDimensions.w) * 100}%, rgba(0,0,0,0.6) ${((cropX + cropW) / originalDimensions.w) * 100}%)`,
                }}
              />
              {/* Crop rectangle */}
              <div
                className="absolute border-2 border-dashed pointer-events-none"
                style={{
                  borderColor: colors.accent,
                  left: `${(cropX / originalDimensions.w) * 100}%`,
                  top: `${(cropY / originalDimensions.h) * 100}%`,
                  width: `${(cropW / originalDimensions.w) * 100}%`,
                  height: `${(cropH / originalDimensions.h) * 100}%`,
                  boxShadow: `0 0 0 9999px rgba(0,0,0,0.5)`,
                }}
              >
                {/* Corner handles */}
                <div className="absolute -top-1.5 -left-1.5 w-3 h-3 rounded-full" style={{ backgroundColor: colors.accent }} />
                <div className="absolute -top-1.5 -right-1.5 w-3 h-3 rounded-full" style={{ backgroundColor: colors.accent }} />
                <div className="absolute -bottom-1.5 -left-1.5 w-3 h-3 rounded-full" style={{ backgroundColor: colors.accent }} />
                <div className="absolute -bottom-1.5 -right-1.5 w-3 h-3 rounded-full" style={{ backgroundColor: colors.accent }} />
              </div>
            </div>
            <p className={cn("text-xs text-center", colors.textMuted)}>
              Drag corners to resize, inside to move, outside to start fresh
            </p>
            <div className="flex items-center justify-center gap-2">
              <button
                onClick={toggleCropSquare}
                className={cn(
                  'rounded-lg border px-3 py-1.5 text-xs font-medium',
                  colors.panelBorder,
                  cropSquare ? 'text-white' : colors.textMain,
                )}
                style={cropSquare ? { background: colors.accent, borderColor: colors.accent } : undefined}
              >
                Square
              </button>
              <button
                onClick={() => {
                  if (!originalDimensions) return;
                  const side = Math.min(originalDimensions.w, originalDimensions.h);
                  setCropX(Math.round((originalDimensions.w - side) / 2));
                  setCropY(Math.round((originalDimensions.h - side) / 2));
                  setCropW(side);
                  setCropH(side);
                }}
                className={cn('rounded-lg border px-3 py-1.5 text-xs', colors.panelBorder, colors.textMain)}
              >
                Biggest square
              </button>
              <button
                onClick={() => {
                  if (!originalDimensions) return;
                  setCropX(0); setCropY(0);
                  setCropW(originalDimensions.w); setCropH(originalDimensions.h);
                }}
                className={cn('rounded-lg border px-3 py-1.5 text-xs', colors.panelBorder, colors.textMain)}
              >
                Whole frame
              </button>
            </div>
            <div className="grid grid-cols-4 gap-2">
              <div>
                <label className={cn("text-xs", colors.textMuted)}>X</label>
                <input
                  type="number"
                  value={cropX}
                  onChange={(e) => setCropX(Math.max(0, parseInt(e.target.value) || 0))}
                  className={cn("w-full px-2 py-1.5 rounded-lg text-xs border bg-transparent", colors.panelBorder, colors.textMain)}
                />
              </div>
              <div>
                <label className={cn("text-xs", colors.textMuted)}>Y</label>
                <input
                  type="number"
                  value={cropY}
                  onChange={(e) => setCropY(Math.max(0, parseInt(e.target.value) || 0))}
                  className={cn("w-full px-2 py-1.5 rounded-lg text-xs border bg-transparent", colors.panelBorder, colors.textMain)}
                />
              </div>
              <div>
                <label className={cn("text-xs", colors.textMuted)}>W</label>
                <input
                  type="number"
                  value={cropW}
                  onChange={(e) => setCropW(Math.max(1, parseInt(e.target.value) || 1))}
                  className={cn("w-full px-2 py-1.5 rounded-lg text-xs border bg-transparent", colors.panelBorder, colors.textMain)}
                />
              </div>
              <div>
                <label className={cn("text-xs", colors.textMuted)}>H</label>
                <input
                  type="number"
                  value={cropH}
                  onChange={(e) => setCropH(Math.max(1, parseInt(e.target.value) || 1))}
                  className={cn("w-full px-2 py-1.5 rounded-lg text-xs border bg-transparent", colors.panelBorder, colors.textMain)}
                />
              </div>
            </div>
            <div className={cn("text-xs text-center", colors.textMuted)}>
              Original: {originalDimensions.w}×{originalDimensions.h}
            </div>
            {/* Scope. Tapping a thumbnail above re-opens this on that frame, so
                per-frame framing is strip-tap then crop, with no extra picker. */}
            <div className="flex items-center justify-center gap-2">
              {([true, false] as const).map((all) => (
                <button
                  key={String(all)}
                  onClick={() => setCropAllFrames(all)}
                  className={cn(
                    'rounded-lg border px-3 py-1.5 text-xs font-medium',
                    colors.panelBorder,
                    cropAllFrames === all ? 'text-white' : colors.textMain,
                  )}
                  style={cropAllFrames === all ? { background: colors.accent, borderColor: colors.accent } : undefined}
                >
                  {all ? 'All frames' : 'This frame only'}
                </button>
              ))}
            </div>
            <p className={cn("text-xs text-center", colors.textMuted)}>
              {cropAllFrames
                ? 'Every frame gets this same box.'
                : 'Only this frame is cut. Smaller frames get centered with transparent space around them in the GIF.'}
            </p>
            <button
              onClick={applyCrop}
              disabled={cropping}
              className={cn("w-full py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-50")}
              style={{ backgroundColor: colors.accent, color: 'var(--gl-on-accent)' }}
            >
              {cropping ? <Loader2 className="w-4 h-4 animate-spin" /> : <Crop className="w-4 h-4" />}
              {cropAllFrames ? 'Apply to all frames' : `Apply to frame ${previewFrame + 1}`}
            </button>
          </div>
        )}

        {/* Background Removal Options */}
        {frames.length > 0 && (
          <div className={cn("p-4 rounded-2xl border backdrop-blur-md space-y-3", colors.panelBg, colors.panelBorder)}>
            <div className="flex items-center justify-between">
              <label className={cn("text-xs font-medium uppercase tracking-wide", colors.textMuted)}>
                Background Removal
              </label>
              <div className="flex gap-1">
                <button
                  onClick={() => setChromaMode(false)}
                  className={cn("px-2 py-1 rounded text-xs transition-colors", !chromaMode ? 'bg-white/20' : '')}
                  style={!chromaMode ? { color: colors.accent } : { color: colors.textMuted }}
                >
                  AI
                </button>
                <button
                  onClick={() => setChromaMode(true)}
                  className={cn("px-2 py-1 rounded text-xs transition-colors", chromaMode ? 'bg-white/20' : '')}
                  style={chromaMode ? { color: colors.accent } : { color: colors.textMuted }}
                >
                  Color
                </button>
              </div>
            </div>

            {chromaMode ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <button
                    onClick={startColorPick}
                    className={cn("px-3 py-2 rounded-lg text-xs flex items-center gap-2 border", pickingColor ? 'ring-2' : '', colors.panelBorder, colors.textMain)}
                    style={pickingColor ? { borderColor: colors.accent } : undefined}
                  >
                    <Pipette className="w-3 h-3" />
                    {pickingColor ? 'Cancel' : 'Pick Color'}
                  </button>
                  <div
                    className="w-8 h-8 rounded-lg border"
                    style={{ backgroundColor: chromaColor, borderColor: colors.panelBorder }}
                  />
                  <input
                    type="text"
                    value={chromaColor}
                    onChange={(e) => setChromaColor(e.target.value)}
                    className={cn("flex-1 px-2 py-1.5 rounded-lg text-xs border bg-transparent", colors.panelBorder, colors.textMain)}
                    placeholder="#00FF00"
                  />
                </div>
                {/* The frame to sample, sitting directly under the swatch it
                    fills in — so the color you tapped is already on screen the
                    instant you tap it, with the tolerance slider right there to
                    chase it with. Tapping a thumbnail still changes the frame. */}
                {pickingColor && (
                  <div ref={pickerRef} className="space-y-2">
                    <div
                      className="rounded-lg px-3 py-2 text-xs font-medium text-center"
                      style={{ background: colors.accent, color: 'var(--gl-on-accent)' }}
                    >
                      Tap the color you want gone — frame {previewFrame + 1}
                    </div>
                    <div className="rounded-lg overflow-hidden bg-[repeating-conic-gradient(#ccc_0_90deg,#fff_90deg_180deg)_0_0/8px_8px]">
                      <img
                        src={frames[previewFrame]?.url || frames[0]?.url}
                        alt=""
                        crossOrigin="anonymous"
                        onClick={handleColorPick}
                        className="w-full h-auto max-h-[46vh] object-contain"
                        style={{ cursor: 'crosshair' }}
                      />
                    </div>
                  </div>
                )}
                <div className="flex items-center gap-3">
                  <label className={cn("text-xs", colors.textMuted)}>Tolerance:</label>
                  <input
                    type="range"
                    min={0.01}
                    max={0.8}
                    step={0.01}
                    value={chromaTolerance}
                    onChange={(e) => setChromaTolerance(parseFloat(e.target.value))}
                    className="flex-1"
                    style={{ accentColor: colors.accent }}
                  />
                  <span className={cn("text-xs w-10 text-right", colors.textMain)}>{Math.round(chromaTolerance * 100)}%</span>
                </div>
                <div className="flex items-center gap-3">
                  <label className={cn("text-xs", colors.textMuted)}>Edge blend:</label>
                  <input
                    type="range"
                    min={0}
                    max={0.5}
                    step={0.05}
                    value={chromaBlend}
                    onChange={(e) => setChromaBlend(parseFloat(e.target.value))}
                    className="flex-1"
                    style={{ accentColor: colors.accent }}
                  />
                  <span className={cn("text-xs w-10 text-right", colors.textMain)}>{Math.round(chromaBlend * 100)}%</span>
                </div>
                <label className="flex gap-2 items-start cursor-pointer">
                  <input
                    type="checkbox"
                    checked={greenScreen}
                    onChange={(e) => setGreenScreen(e.target.checked)}
                    className="mt-0.5"
                    style={{ accentColor: colors.accent }}
                  />
                  <span className={cn("text-xs", colors.textMain)}>
                    Green-screen mode
                    <span className={cn("block text-[11px]", colors.textMuted)}>
                      For an actual green screen, not a flat backdrop. Leave it off and a red
                      background stops taking the pink with it.
                    </span>
                  </span>
                </label>
                <button
                  onClick={applyChromaKey}
                  disabled={removingBg || selectedFrames.size === 0}
                  className={cn("w-full py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 border disabled:opacity-50", colors.panelBorder, colors.textMain)}
                >
                  {removingBg ? <Loader2 className="w-4 h-4 animate-spin" /> : <Scissors className="w-4 h-4" />}
                  Remove Color ({selectedFrames.size})
                </button>
              </div>
            ) : (
              <button
                onClick={removeBg}
                disabled={removingBg || selectedFrames.size === 0}
                className={cn("w-full py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 border disabled:opacity-50", colors.panelBorder, colors.textMain)}
              >
                {removingBg ? <Loader2 className="w-4 h-4 animate-spin" /> : <Scissors className="w-4 h-4" />}
                Remove BG with AI ({selectedFrames.size})
              </button>
            )}
            {frames.length > 0 && (
              <button
                onClick={() => { setPaintOpen(o => !o); paint.setPainting(!paintOpen); }}
                className={cn("w-full py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 border", colors.panelBorder, colors.textMain)}
              >
                <Brush className="w-4 h-4" />
                {paintOpen ? 'Done Painting' : 'Fix by Hand'}
              </button>
            )}

            {paintOpen && frames[previewFrame] && (
              <div className="space-y-2">
                <p className={cn("text-xs", colors.textMuted)}>
                  Paint the transparency yourself where the removal missed. Restore brings back
                  what it cut; erase takes away what it kept. One frame at a time — the same
                  stroke on every frame would land on the wrong thing as soon as anything moves.
                </p>
                <div ref={paintBoxRef} className="relative flex items-center justify-center rounded-xl overflow-hidden">
                  <img
                    ref={paintImageRef}
                    src={frames[previewFrame].url}
                    alt=""
                    crossOrigin="anonymous"
                    onLoad={() => paint.drawStrokes(paint.strokes)}
                    className="max-h-[46vh] w-auto object-contain"
                  />
                  <canvas
                    {...paint.canvasProps}
                    className={cn('absolute inset-0 h-full w-full', paint.painting ? 'touch-none' : 'pointer-events-none')}
                  />
                  {paint.loupe && paintImageRef.current && (
                    <div
                      className="pointer-events-none absolute top-1.5 z-20 overflow-hidden rounded-full border-2 shadow-lg"
                      style={{
                        left: paint.loupe.side === 'left' ? 6 : undefined,
                        right: paint.loupe.side === 'right' ? 6 : undefined,
                        width: LOUPE, height: LOUPE, borderColor: colors.accent,
                      }}
                    >
                      <div
                        className="absolute inset-0"
                        style={{
                          backgroundImage: `url(${frames[previewFrame].url})`,
                          backgroundRepeat: 'no-repeat',
                          backgroundSize: `${(paintImageRef.current.naturalWidth || 0) * paint.loupe.scale}px ${(paintImageRef.current.naturalHeight || 0) * paint.loupe.scale}px`,
                          backgroundPosition: `${LOUPE / 2 - paint.loupe.x * paint.loupe.scale}px ${LOUPE / 2 - paint.loupe.y * paint.loupe.scale}px`,
                        }}
                      />
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => paint.setTool('restore')}
                    className={cn("flex-1 py-1.5 rounded-lg text-xs font-medium border flex items-center justify-center gap-1", colors.panelBorder)}
                    style={paint.tool === 'restore' ? { backgroundColor: colors.accent, color: 'var(--gl-on-accent)' } : { color: colors.textMuted }}
                  >
                    <Brush className="w-3.5 h-3.5" /> Restore
                  </button>
                  <button
                    onClick={() => paint.setTool('erase')}
                    className={cn("flex-1 py-1.5 rounded-lg text-xs font-medium border flex items-center justify-center gap-1", colors.panelBorder)}
                    style={paint.tool === 'erase' ? { backgroundColor: colors.accent, color: 'var(--gl-on-accent)' } : { color: colors.textMuted }}
                  >
                    <Eraser className="w-3.5 h-3.5" /> Erase
                  </button>
                  <button
                    onClick={paint.undo}
                    disabled={paint.strokes.length === 0}
                    className={cn("px-3 py-1.5 rounded-lg text-xs border disabled:opacity-40", colors.panelBorder, colors.textMuted)}
                  >
                    <Undo2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="flex items-center gap-3">
                  <label className={cn("text-xs", colors.textMuted)}>Brush:</label>
                  <input
                    type="range" min={4} max={120} step={2}
                    value={paint.brush}
                    onChange={(e) => paint.setBrush(Number(e.target.value))}
                    className="flex-1"
                    style={{ accentColor: colors.accent }}
                  />
                  <span className={cn("text-xs w-10 text-right", colors.textMain)}>{paint.brush}px</span>
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => void stepPaintFrame(-1)}
                    disabled={previewFrame === 0 || removingBg}
                    className={cn("px-3 py-2 rounded-lg border disabled:opacity-40", colors.panelBorder, colors.textMuted)}
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => void applyPaint()}
                    disabled={paint.strokes.length === 0 || removingBg}
                    className={cn("flex-1 py-2 rounded-lg font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-40")}
                    style={{ backgroundColor: colors.accent, color: 'var(--gl-on-accent)' }}
                  >
                    {removingBg ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    Apply to frame {previewFrame + 1}
                  </button>
                  <button
                    onClick={() => void stepPaintFrame(1)}
                    disabled={previewFrame >= frames.length - 1 || removingBg}
                    className={cn("px-3 py-2 rounded-lg border disabled:opacity-40", colors.panelBorder, colors.textMuted)}
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
                <p className={cn("text-[11px] text-center", colors.textMuted)}>
                  Frame {previewFrame + 1} of {frames.length}. Stepping applies anything still painted first.
                </p>
              </div>
            )}

            {/* Both removals keep an original-frame-*.png before they touch
                anything, and the revert route puts that back — so one button
                undoes either of them. It was only ever wired into Cutout
                because of what the route is named. */}
            {frames.some(f => f.processed || f.chromaKeyed) && (
              <button
                onClick={revertBg}
                disabled={removingBg || selectedFrames.size === 0}
                className={cn("w-full py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 border disabled:opacity-50", colors.panelBorder, colors.textMuted)}
              >
                <RotateCcw className="w-4 h-4" />
                Revert to Original ({selectedFrames.size})
              </button>
            )}
          </div>
        )}

        {/* Output Size */}
        {frames.length > 0 && (
          <div className={cn("p-4 rounded-2xl border backdrop-blur-md space-y-3", colors.panelBg, colors.panelBorder)}>
            <label className={cn("text-xs font-medium uppercase tracking-wide", colors.textMuted)}>
              Output Size
            </label>
            <div className="flex gap-1.5 flex-wrap">
              {sizePresets.map((preset) => {
                const isSelected = outputWidth === preset.w && outputHeight === preset.h;
                return (
                  <button
                    key={preset.label}
                    onClick={() => { setOutputWidth(preset.w); setOutputHeight(preset.h); }}
                    className={cn(
                      "shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors border",
                      colors.panelBorder,
                      !isSelected && cn(colors.panelBg, colors.textMain),
                    )}
                    style={
                      isSelected
                        ? { background: colors.accent, color: 'var(--gl-on-accent)', borderColor: colors.accent }
                        : undefined
                    }
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-2">
              <ZoomIn className={cn("w-4 h-4", colors.textMuted)} />
              <input
                type="number"
                value={outputWidth || ''}
                onChange={(e) => setOutputWidth(e.target.value ? parseInt(e.target.value) : undefined)}
                className={cn("w-20 px-2 py-1.5 rounded-lg text-xs border bg-transparent", colors.panelBorder, colors.textMain)}
                placeholder="Width"
              />
              <span className={cn("text-xs", colors.textMuted)}>×</span>
              <input
                type="number"
                value={outputHeight || ''}
                onChange={(e) => setOutputHeight(e.target.value ? parseInt(e.target.value) : undefined)}
                className={cn("w-20 px-2 py-1.5 rounded-lg text-xs border bg-transparent", colors.panelBorder, colors.textMain)}
                placeholder="Height"
              />
            </div>
          </div>
        )}

        {/* Speed control - before creation */}
        {frames.length > 0 && (
          <div className={cn("p-4 rounded-2xl border backdrop-blur-md space-y-3", colors.panelBg, colors.panelBorder)}>
            <label className={cn("text-xs font-medium uppercase tracking-wide block", colors.textMuted)}>
              Speed
            </label>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0.25}
                max={4}
                step={0.25}
                value={speedValue}
                onChange={(e) => setSpeedValue(parseFloat(e.target.value))}
                className="flex-1"
                style={{ accentColor: colors.accent }}
              />
              <span className={cn("text-xs w-12 text-right", colors.textMain)}>{speedValue}x</span>
            </div>
          </div>
        )}

        {/* Text overlay - before creation */}
        {frames.length > 0 && (
          <div className={cn("p-4 rounded-2xl border backdrop-blur-md space-y-3", colors.panelBg, colors.panelBorder)}>
            <div className="flex items-center justify-between">
              <label className={cn("text-xs font-medium uppercase tracking-wide", colors.textMuted)}>
                Add Text
              </label>
              <button
                onClick={() => setShowTextPanel(!showTextPanel)}
                className={cn("text-xs", colors.textMuted)}
              >
                {showTextPanel ? 'Hide' : 'Show'}
              </button>
            </div>
            {showTextPanel && (
              <div className="space-y-2">
                <input
                  type="text"
                  value={overlayText}
                  onChange={(e) => setOverlayText(e.target.value)}
                  placeholder="Enter text..."
                  className={cn("w-full px-3 py-2 rounded-lg text-sm border bg-transparent", colors.panelBorder, colors.textMain)}
                />
                <div className="flex gap-1.5 overflow-x-auto pb-1">
                  {availableFonts.map(f => {
                    const isSelected = textFont === f;
                    return (
                      <button
                        key={f}
                        onClick={() => setTextFont(f)}
                        className={cn(
                          "shrink-0 rounded-lg px-3 py-1.5 text-sm transition-colors border whitespace-nowrap",
                          colors.panelBorder,
                          !isSelected && cn(colors.panelBg, colors.textMain),
                        )}
                        style={{
                          fontFamily: `"${gifFontFamily(f)}", sans-serif`,
                          ...(isSelected
                            ? { background: colors.accent, color: 'var(--gl-on-accent)', borderColor: colors.accent }
                            : {}),
                        }}
                      >
                        {f}
                      </button>
                    );
                  })}
                </div>
                {/* Place the caption on the frame itself, at the output's own
                    shape — checkerboarded, because transparency is the point of
                    half these stickers. Drag the text to put it anywhere. */}
                <div
                  ref={textPadRef}
                  onPointerDown={beginTextDrag}
                  className="relative rounded-lg overflow-hidden select-none touch-none mx-auto"
                  style={{
                    width: '100%',
                    // Capping the HEIGHT would leave the box wider than the frame
                    // it claims to be, which quietly breaks both the caption's
                    // scale and its position. Cap the width instead so the pad's
                    // shape is always the output's shape.
                    maxWidth: `calc(38vh * ${renderSize.w / renderSize.h})`,
                    aspectRatio: `${renderSize.w} / ${renderSize.h}`,
                    containerType: 'inline-size',
                    backgroundImage:
                      'linear-gradient(45deg, rgba(128,128,128,.28) 25%, transparent 25%, transparent 75%, rgba(128,128,128,.28) 75%),'
                      + 'linear-gradient(45deg, rgba(128,128,128,.28) 25%, transparent 25%, transparent 75%, rgba(128,128,128,.28) 75%)',
                    backgroundSize: '16px 16px',
                    backgroundPosition: '0 0, 8px 8px',
                  }}
                >
                  {frames[padFrame]?.url && (
                    <img
                      src={frames[padFrame].url}
                      alt=""
                      draggable={false}
                      onLoad={(e) => {
                        const img = e.currentTarget;
                        if (!img.naturalWidth || !img.naturalHeight) return;
                        setFrameNatural(prev =>
                          prev?.w === img.naturalWidth && prev?.h === img.naturalHeight
                            ? prev
                            : { w: img.naturalWidth, h: img.naturalHeight });
                      }}
                      className="absolute pointer-events-none"
                      // Same two steps as the preview tile. The pad used to
                      // stretch one frame across the whole output shape, so a
                      // mixed-size set was squashed here and padded in the GIF.
                      style={(() => {
                        const size = frames[padFrame] ? frameSizes[frames[padFrame].filename] : undefined;
                        if (!canvasSize || !size) return { inset: 0, width: '100%', height: '100%', objectFit: renderObjectFit };
                        const scale = renderObjectFit === 'contain'
                          ? Math.min(renderSize.w / canvasSize.w, renderSize.h / canvasSize.h)
                          : 0;
                        const boxW = scale ? (canvasSize.w * scale) / renderSize.w : 1;
                        const boxH = scale ? (canvasSize.h * scale) / renderSize.h : 1;
                        return {
                          width: `${(size.w / canvasSize.w) * boxW * 100}%`,
                          height: `${(size.h / canvasSize.h) * boxH * 100}%`,
                          left: '50%',
                          top: '50%',
                          transform: 'translate(-50%, -50%)',
                        } as React.CSSProperties;
                      })()}
                    />
                  )}
                  <span
                    className="absolute whitespace-nowrap cursor-move"
                    style={captionStyle}
                  >
                    {overlayText.trim() || 'Preview'}
                  </span>
                  <span
                    className={cn(
                      "absolute bottom-1 right-2 text-[10px] pointer-events-none",
                      colors.textMuted,
                    )}
                  >
                    {/* Naming the real output size is what makes the Size number
                        mean anything — 30 is huge on a 128 emoji and small on a
                        320 sticker, and nothing on this page used to say which. */}
                    {renderSize.w}×{renderSize.h} — {textAnchor ? 'placed, drag to move' : 'drag to place'}
                  </span>
                </div>
                <div className="flex gap-2">
                  <div className="flex gap-1.5 flex-1">
                    {(['top', 'center', 'bottom'] as const).map(pos => {
                      const isSelected = !textAnchor && textPosition === pos;
                      return (
                        <button
                          key={pos}
                          // A preset overrides a hand-placed spot — that's what
                          // makes it the way back after a drag goes wrong.
                          onClick={() => { setTextPosition(pos); setTextAnchor(null); }}
                          className={cn(
                            "flex-1 rounded-lg px-2 py-1.5 text-xs capitalize transition-colors border",
                            colors.panelBorder,
                            !isSelected && cn(colors.panelBg, colors.textMain),
                          )}
                          style={isSelected
                            ? { background: colors.accent, color: 'var(--gl-on-accent)', borderColor: colors.accent }
                            : undefined}
                        >
                          {pos}
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex items-center gap-1">
                    <label className={cn("text-xs", colors.textMuted)}>Size</label>
                    <input
                      type="number"
                      inputMode="numeric"
                      value={textSizeDraft ?? String(textSize)}
                      onChange={(e) => {
                        const raw = e.target.value;
                        setTextSizeDraft(raw);
                        const n = parseInt(raw, 10);
                        if (Number.isFinite(n) && n > 0) setTextSize(n);
                      }}
                      // An empty box is a fine thing to be looking at mid-edit;
                      // it just can't survive leaving the field.
                      onBlur={() => setTextSizeDraft(null)}
                      className={cn("w-14 px-2 py-1.5 rounded-lg text-xs border bg-transparent", colors.panelBorder, colors.textMain)}
                    />
                    <label className={cn("text-xs", colors.textMuted)}>px</label>
                  </div>
                </div>
                <div className="flex gap-2 items-center">
                  <div className="flex items-center gap-1 flex-1">
                    <label className={cn("text-xs", colors.textMuted)}>Fill</label>
                    <input
                      type="color"
                      value={textFillColor}
                      onChange={(e) => setTextFillColor(e.target.value)}
                      className="w-8 h-8 rounded cursor-pointer border-0 p-0"
                    />
                  </div>
                  <div className="flex items-center gap-1 flex-1">
                    <label className={cn("text-xs", colors.textMuted)}>Border</label>
                    <input
                      type="color"
                      value={textBorderColor}
                      onChange={(e) => setTextBorderColor(e.target.value)}
                      className="w-8 h-8 rounded cursor-pointer border-0 p-0"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Optimization settings - before creation */}
        {frames.length > 0 && (
          <div className={cn("p-4 rounded-2xl border backdrop-blur-md space-y-3", colors.panelBg, colors.panelBorder)}>
            <div className="flex items-center justify-between gap-3">
              <label className={cn("text-xs font-medium uppercase tracking-wide block", colors.textMuted)}>
                Optimization (for smaller files)
              </label>
              <button
                onClick={() => {
                  const next = !preserveColorPreset;
                  setPreserveColorPreset(next);
                  if (next) {
                    setOutputWidth(320);
                    setOutputHeight(320);
                    setColorCount(256);
                    setDither(false);
                    setLossyLevel(30);
                    setOptimizeLevel(3);
                    setDropDuplicates(true);
                    setRemoveFrames(2);
                    setStripMetadata(true);
                    setUnoptimize(false);
                    setInterlace(false);
                  }
                }}
                className={cn(
                  "shrink-0 rounded-lg px-3 py-1.5 text-[11px] font-semibold border transition-colors",
                  colors.panelBorder,
                  !preserveColorPreset && cn(colors.panelBg, colors.textMain),
                )}
                style={preserveColorPreset
                  ? { backgroundColor: colors.accent, borderColor: colors.accent, color: 'var(--gl-on-accent)' }
                  : undefined}
              >
                Preserve Color
              </button>
            </div>
            {preserveColorPreset && (
              <p className={cn("text-[11px]", colors.textMuted)}>
                {outputWidth && outputHeight
                  ? `Discord Sticker preset: transparent, letterboxed into ${outputWidth}×${outputHeight}, full color palette, timing-safe half-frame reduction, and light lossy compression against 512KB.`
                  : 'Full color, transparent, half-frame reduction and light lossy compression against 512KB — at the frames\u2019 own size. Not a Discord sticker: set an Output Size above for that.'}
              </p>
            )}
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <label className={cn("text-xs w-16", colors.textMuted)}>Lossy</label>
                <input
                  type="range"
                  min={0}
                  max={200}
                  value={lossyLevel}
                  onChange={(e) => setLossyLevel(parseInt(e.target.value))}
                  className="flex-1"
                  style={{ accentColor: colors.accent }}
                />
                <span className={cn("text-xs w-8 text-right", colors.textMain)}>{lossyLevel}</span>
              </div>
              <div className="flex items-center gap-3">
                <label className={cn("text-xs w-16", colors.textMuted)}>Colors</label>
                <input
                  type="range"
                  min={8}
                  max={256}
                  step={8}
                  value={colorCount}
                  onChange={(e) => setColorCount(parseInt(e.target.value))}
                  className="flex-1"
                  style={{ accentColor: colors.accent }}
                />
                <span className={cn("text-xs w-8 text-right", colors.textMain)}>{colorCount}</span>
              </div>
              <label className="flex items-center gap-3 cursor-pointer">
                <span className={cn("text-xs w-16", colors.textMuted)}>Dither</span>
                <input
                  type="checkbox"
                  checked={dither}
                  onChange={(e) => setDither(e.target.checked)}
                  style={{ accentColor: colors.accent }}
                />
                <span className={cn("text-[11px] flex-1", colors.textMuted)}>
                  {dither ? 'Smoother gradients, bigger file' : 'Cleaner flat art, smaller file'}
                </span>
              </label>
            </div>

            <button
              onClick={() => setShowAdvancedOpt(v => !v)}
              className={cn("flex items-center gap-1.5 text-xs pt-1", colors.textMuted)}
            >
              <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", !showAdvancedOpt && "-rotate-90")} />
              Advanced
            </button>

            {showAdvancedOpt && (
              <div className="space-y-3 pt-1">
                {dither && (
                  <div className="space-y-1.5">
                    <label className={cn("text-[11px] uppercase tracking-wide block", colors.textMuted)}>Dither pattern</label>
                    <SegmentedControl
                      colors={colors}
                      value={ditherMethod}
                      onChange={setDitherMethod}
                      options={[
                        { value: 'default', label: 'Floyd' },
                        { value: 'ro64', label: 'Ro64' },
                        { value: 'o3', label: 'Ordered' },
                        { value: 'atkinson', label: 'Atkinson' },
                        { value: 'halftone', label: 'Halftone' },
                      ]}
                    />
                  </div>
                )}

                <div className="space-y-1.5">
                  <label className={cn("text-[11px] uppercase tracking-wide block", colors.textMuted)}>Palette method</label>
                  <SegmentedControl
                    colors={colors}
                    value={colorMethod}
                    onChange={setColorMethod}
                    options={[
                      { value: 'diversity', label: 'Diversity' },
                      { value: 'blend-diversity', label: 'Blend' },
                      { value: 'median-cut', label: 'Median cut' },
                    ]}
                  />
                </div>

                <div className="space-y-1.5">
                  <label className={cn("text-[11px] uppercase tracking-wide block", colors.textMuted)}>Compression effort</label>
                  <SegmentedControl
                    colors={colors}
                    value={String(optimizeLevel)}
                    onChange={(v) => setOptimizeLevel(parseInt(v))}
                    options={[
                      { value: '1', label: 'Fast' },
                      { value: '2', label: 'Better' },
                      { value: '3', label: 'Best' },
                    ]}
                  />
                </div>

                <div className="space-y-1.5">
                  <label className={cn("text-[11px] uppercase tracking-wide block", colors.textMuted)}>Drop frames</label>
                  <SegmentedControl
                    colors={colors}
                    value={String(removeFrames)}
                    onChange={(v) => setRemoveFrames(parseInt(v))}
                    options={[
                      { value: '0', label: 'Keep all' },
                      { value: '2', label: 'Every 2nd' },
                      { value: '3', label: 'Every 3rd' },
                      { value: '4', label: 'Every 4th' },
                    ]}
                  />
                </div>

                <div className="flex items-center gap-3">
                  <label className={cn("text-xs w-16", colors.textMuted)}>Scale</label>
                  <input
                    type="range"
                    min={10}
                    max={100}
                    step={5}
                    value={optimizeScale}
                    onChange={(e) => setOptimizeScale(parseInt(e.target.value))}
                    className="flex-1"
                    style={{ accentColor: colors.accent }}
                  />
                  <span className={cn("text-xs w-10 text-right", colors.textMain)}>{optimizeScale}%</span>
                </div>

                <div className="space-y-2">
                  {([
                    { key: 'dupes', label: 'Drop duplicate frames', checked: dropDuplicates, set: setDropDuplicates, hint: 'Removes repeats, keeps the timing' },
                    { key: 'strip', label: 'Strip comments & metadata', checked: stripMetadata, set: setStripMetadata, hint: 'Free bytes, no quality cost' },
                    { key: 'whole', label: 'Whole frames (coalesce)', checked: unoptimize, set: setUnoptimize, hint: 'Bigger, but plays anywhere' },
                    { key: 'lace', label: 'Interlace', checked: interlace, set: setInterlace, hint: 'Loads blurry to sharp' },
                  ] as const).map((t) => (
                    <label key={t.key} className="flex items-start gap-2.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={t.checked}
                        onChange={(e) => t.set(e.target.checked)}
                        className="mt-0.5"
                        style={{ accentColor: colors.accent }}
                      />
                      <span className="flex-1">
                        <span className={cn("text-xs block", colors.textMain)}>{t.label}</span>
                        <span className={cn("text-[11px]", colors.textMuted)}>{t.hint}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {optimizeStats && optimizeStats.beforeKb > 0 && (
              <p className={cn("text-[11px] pt-1", colors.textMuted)}>
                {optimizeStats.savedPercent > 0
                  ? `Saved ${optimizeStats.savedPercent}% — ${optimizeStats.beforeKb}KB down to ${outputSize?.kb ?? '?'}KB`
                  : `Already as small as these settings get (${optimizeStats.beforeKb}KB)`}
                {optimizeStats.framesDropped > 0 && ` · ${optimizeStats.framesDropped} duplicate frames removed`}
              </p>
            )}
          </div>
        )}

        {/* Actions */}
        {frames.length > 0 && (
          <div className={cn("p-4 rounded-2xl border backdrop-blur-md space-y-3", colors.panelBg, colors.panelBorder)}>
            <div className="flex gap-2">
              <button
                onClick={togglePreview}
                disabled={selectedFrames.size === 0}
                className={cn("flex-1 py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 border disabled:opacity-50", colors.panelBorder, colors.textMain)}
              >
                {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                Preview
              </button>
            </div>
            <button
              onClick={createGif}
              disabled={loading || selectedFrames.size === 0}
              className={cn("w-full py-3 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-50")}
              style={{ backgroundColor: colors.accent, color: 'var(--gl-on-accent)' }}
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
              {preserveColorPreset
                ? (outputWidth && outputHeight ? 'Create Discord Sticker GIF' : 'Create Full-Color GIF')
                : 'Create GIF'}
            </button>
          </div>
        )}

        {/* Preview */}
        {frames.length > 0 && selectedFrames.size > 0 && (
          <div className={cn("p-4 rounded-2xl border backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
            <label className={cn("text-xs font-medium uppercase tracking-wide mb-2 block", colors.textMuted)}>
              Preview
            </label>
            <div className="flex items-center justify-center">
              <div
                className="relative rounded-lg overflow-hidden bg-[repeating-conic-gradient(#ccc_0_90deg,#fff_90deg_180deg)_0_0/8px_8px]"
                // The tile is the output's shape at screen scale, same as the
                // pad, so the caption it carries is the caption you'll get.
                style={{
                  width: Math.min(renderSize.w, 200),
                  aspectRatio: `${renderSize.w} / ${renderSize.h}`,
                  containerType: 'inline-size',
                }}
              >
                {/* Two layers, because the export is two steps. First every
                    picture is padded onto the shared canvas at its OWN size,
                    centered — that is this inner box. Then the canvas is scaled to
                    the output size, letterboxed when Fit is on and stretched when
                    it is not. Drawing it in one step is what made a mixed-size set
                    look smashed here and come out right in the GIF. */}
                <div
                  className="absolute"
                  // The letterbox is worked out as numbers rather than left to
                  // aspect-ratio with auto width and height — an absolutely
                  // positioned box given only an aspect ratio computes to nothing,
                  // which is why the preview vanished on a sticker size.
                  style={canvasSize ? canvasLayerStyle : { inset: 0 }}
                >
                  {stackFrames.map(i => {
                    const size = frames[i] ? frameSizes[frames[i].filename] : undefined;
                    // Placed at its own share of the canvas rather than filling it.
                    const placed: React.CSSProperties = canvasSize && size
                      ? {
                          width: `${(size.w / canvasSize.w) * 100}%`,
                          height: `${(size.h / canvasSize.h) * 100}%`,
                          left: '50%',
                          top: '50%',
                          transform: 'translate(-50%, -50%)',
                        }
                      : { inset: 0, width: '100%', height: '100%', objectFit: renderObjectFit };
                    return (
                      <img
                        key={i}
                        src={frames[i].url}
                        alt=""
                        crossOrigin="anonymous"
                        className="absolute"
                        style={{
                          ...placed,
                          visibility: i === visibleFrame ? 'visible' : 'hidden',
                        }}
                      />
                    );
                  })}
                </div>
                {/* The caption is drawn by ffmpeg at render time, so the preview
                    never carried it — you could only see it by spending a GIF. */}
                {overlayText.trim() && (
                  <span className="absolute whitespace-nowrap pointer-events-none" style={captionStyle}>
                    {overlayText}
                  </span>
                )}
              </div>
            </div>
            <canvas ref={colorPickCanvasRef} className="hidden" />
          </div>
        )}

        {/* Output */}
        {outputUrl && (
          <div className={cn("p-4 rounded-2xl border backdrop-blur-md space-y-3", colors.panelBg, colors.panelBorder)}>
            <div className="flex items-center justify-between">
              <label className={cn("text-xs font-medium uppercase tracking-wide", colors.textMuted)}>
                Output
              </label>
              {outputSize && (
                <div
                  className="flex items-center gap-1 text-xs"
                  style={{ color: outputSize.ok ? colors.accent : undefined }}
                >
                  {outputSize.ok ? <Check className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3 text-amber-400" />}
                  {outputSize.kb}KB {outputSize.ok
                    ? `(under ${outputSize.limitKb ?? 256}KB)`
                    : `(over ${outputSize.limitKb ?? 256}KB)`}
                </div>
              )}
            </div>
            <div className="flex items-center justify-center">
              <img src={outputUrl} alt="Output GIF" className="max-h-32 rounded-lg" />
            </div>
            <button
              onClick={downloadGif}
              className={cn("w-full py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 border", colors.panelBorder, colors.textMain)}
            >
              <Download className="w-4 h-4" />Download GIF
            </button>
            {outputSize && !outputSize.ok && (
              <p className={cn("text-xs text-center", colors.textMuted)}>
                Adjust optimization settings above and create again to reduce size
              </p>
            )}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="text-sm text-center py-2 px-3 rounded-lg text-red-400 bg-red-500/10">
            {error}
          </div>
        )}

        {/* Loading overlay */}
        {(loading || removingBg) && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className={cn("p-6 rounded-2xl flex flex-col items-center gap-3", colors.panelBg)}>
              <Loader2 className="w-8 h-8 animate-spin" style={{ color: colors.accent }} />
              <span className={cn("text-sm", colors.textMain)}>
                {bgProgress || (removingBg ? 'Removing backgrounds...' : 'Processing...')}
              </span>
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}
