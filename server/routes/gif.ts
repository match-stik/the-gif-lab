// Copyright 2026 match-stik. Licensed under the Apache License 2.0.
/**
 * GIF Lab routes — extract frames, create GIFs, optimize for Discord
 */

import { Router } from 'express';
import { spawn } from 'child_process';
import { join, basename, extname } from 'path';
import { mkdirSync, existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync, statSync, rmSync } from 'fs';
import { randomUUID, createHash } from 'crypto';
import multer from 'multer';
import sharp from 'sharp';
import { getConfig } from '../config.js';
import { attachmentFilename } from '../services/files.js';

const router = Router();

/**
 * ONE GUARD, AT THE FRONT, FOR EVERY HANDLER BELOW.
 *
 * Session ids and frame names are the only user-supplied strings that ever reach
 * a filesystem path here, and until now each handler checked them for itself —
 * fourteen did, five did not, and `POST /gif/upload-frame` took a session id
 * straight out of the body into mkdirSync, while `POST /gif/create` joined every
 * entry of `frames` with nothing looked at at all.
 *
 * Checking for '..' per handler is also weaker than it looks and is exactly what
 * a new route forgets. So the check moved to the ADDRESS rather than living
 * nineteen times inside it: everything that can name a file has to be a plain
 * name — letters, digits, dot, dash, underscore. That rejects slashes,
 * backslashes, traversal, absolute paths and null bytes in one rule, and it is
 * what every real value already looks like: a UUID, or frame-0001.png.
 */
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
const unsafeName = (v: unknown): boolean =>
  typeof v !== 'string' || v === '.' || v === '..' || !SAFE_NAME.test(v);

router.use((req, res, next) => {
  const named: unknown[] = [
    req.params?.sessionId, req.params?.filename,
    (req.body as Record<string, unknown> | undefined)?.sessionId,
    (req.body as Record<string, unknown> | undefined)?.filename,
  ];
  const frames = (req.body as Record<string, unknown> | undefined)?.frames;
  if (Array.isArray(frames)) named.push(...frames);

  for (const value of named) {
    if (value === undefined || value === null) continue;
    if (unsafeName(value)) {
      res.status(400).json({ error: 'That is not a valid name.' });
      return;
    }
  }
  next();
});
const DATA_DIR = join(process.cwd(), 'data');
const GIF_WORK_DIR = join(DATA_DIR, 'gif-work');
const CUTOUT_SCRIPT = join(process.cwd(), 'tools', 'cutout.py');
const STILL_EXPORT_SCRIPT = join(process.cwd(), 'tools', 'still-export.py');
const MASK_PAINT_SCRIPT = join(process.cwd(), 'tools', 'mask-paint.py');

/** The exporter needs only Pillow, so the system interpreter usually suffices. */
function stillExportPython(): string {
  const configured = cutoutRuntime().python;
  return configured && existsSync(configured) ? configured : 'python3';
}

/**
 * Where the local cut-out runtime lives, read from the environment:
 * GIFLAB_PYTHON and GIFLAB_MODEL.
 */
function cutoutRuntime(): { python: string; model: string; alsoModels: string[] } {
  let configured: { python?: string; model?: string; also_models?: string[] } = {};
  try {
    configured = getConfig().integrations?.cutout ?? {};
  } catch {
    /* config may not be loaded in isolated tests */
  }
  const alsoRaw = process.env.GIFLAB_ALSO_MODELS || (configured.also_models ?? []).join(',');
  return {
    python: process.env.GIFLAB_PYTHON || configured.python || '',
    model: process.env.GIFLAB_MODEL || configured.model || '',
    alsoModels: alsoRaw.split(',').map((p) => p.trim()).filter((p) => p && existsSync(p)),
  };
}

function cutoutSetupHint(runtime: { python: string; model: string }): string {
  const missing: string[] = [];
  if (!runtime.python) missing.push('an interpreter with onnxruntime, numpy and pillow');
  else if (!existsSync(runtime.python)) missing.push(`an interpreter at ${runtime.python}`);
  if (!runtime.model) missing.push('a u2net- or isnet-style .onnx model');
  else if (!existsSync(runtime.model)) missing.push(`a model file at ${runtime.model}`);
  return `Background removal needs ${missing.join(' and ')}. `
    + 'Set GIFLAB_PYTHON and GIFLAB_MODEL when you start it. '
    + 'See tools/cutout.py for the model download.';
}

/**
 * ffmpeg cannot draw text onto a paletted image, so it silently converts the
 * frames to a format without an alpha channel first — and a transparent GIF
 * comes back out solid white. Keeping the chain in rgba and building the
 * output palette with a slot reserved for transparency is what preserves it;
 * -offsetting keeps ffmpeg from cropping frames to their changed region, which
 * is the other half of how transparent GIFs get mangled here.
 */
/**
 * Where the text sits, as ffmpeg x/y expressions.
 *
 * A hand-placed anchor arrives as a fraction of the frame rather than a pixel
 * count, so the same placement lands in the same spot whether the GIF is
 * rendered at 128px or 320px — and the expression is evaluated against the real
 * text box, so a long caption can't be dragged off the edge.
 */
function textPositionExprs(opts: {
  position?: string;
  anchor?: { x?: number; y?: number } | null;
  x?: number;
  y?: number;
}): { posX: string; posY: string } {
  const { position = 'bottom', anchor } = opts;

  const fx = typeof anchor?.x === 'number' && Number.isFinite(anchor.x) ? clamp01(anchor.x) : null;
  const fy = typeof anchor?.y === 'number' && Number.isFinite(anchor.y) ? clamp01(anchor.y) : null;
  if (fx !== null && fy !== null) {
    return { posX: `x=(w-text_w)*${fx.toFixed(4)}`, posY: `y=(h-text_h)*${fy.toFixed(4)}` };
  }

  // Absolute pixels stay supported for callers that already send them.
  let posX = typeof opts.x === 'number' ? `x=${Math.round(opts.x)}` : 'x=(w-text_w)/2';
  let posY = 'y=h-th-10';
  if (typeof opts.y === 'number') posY = `y=${Math.round(opts.y)}`;
  else if (position === 'top') posY = 'y=10';
  else if (position === 'center') posY = 'y=(h-text_h)/2';
  return { posX, posY };
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function drawTextArgs(input: string, drawTextFilter: string, output: string): string[] {
  return [
    '-i', input,
    '-filter_complex',
    `[0:v]format=rgba,${drawTextFilter},split[a][b];`
      + '[b]palettegen=reserve_transparent=1:stats_mode=diff[p];'
      + '[a][p]paletteuse=alpha_threshold=128',
    '-gifflags', '-offsetting',
    '-y', output,
  ];
}

// Ensure work directory exists.
// multer's `dest` does NOT create the folder it is given — it opens a file in
// it and fails with ENOENT if it is not there. On a machine where this has run
// before the folder already exists, so the bug is invisible; on a fresh install
// EVERY upload fails, and without an error handler that returns JSON the
// browser gets an HTML error page and reports it as "Unexpected token '<'".
mkdirSync(GIF_WORK_DIR, { recursive: true });
mkdirSync(join(GIF_WORK_DIR, 'uploads'), { recursive: true });

/**
 * The session directory, or null if that name has no business being one.
 *
 * The guard above catches params and JSON bodies, and it is NOT enough on its
 * own: multer parses a multipart body AFTER router middleware runs, so on the
 * upload routes req.body.sessionId is still undefined when the door is checked.
 * A traversing session id sailed straight through and mkdir tried to make a
 * folder four levels above the work directory — it failed on permissions, not on
 * anything we did.
 *
 * So the check also lives HERE, at the only place that actually touches the
 * filesystem, where no ordering can get in front of it.
 */
function sessionDirOf(sessionId: unknown): string | null {
  if (unsafeName(sessionId)) return null;
  return join(GIF_WORK_DIR, sessionId as string);
}


// Multer for file uploads
const upload = multer({
  dest: join(GIF_WORK_DIR, 'uploads'),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
});

/**
 * Extract frames from a video or GIF
 * POST /api/gif/extract-frames
 * Body: multipart form with 'file' field
 * Query: fps (default 10), maxFrames (default 100)
 */
router.post('/gif/extract-frames', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded' });
    return;
  }

  const fps = parseInt(req.query.fps as string) || 10;
  const maxFrames = parseInt(req.query.maxFrames as string) || 100;
  const sessionId = randomUUID();
  const sessionDir = sessionDirOf(sessionId);
  if (!sessionDir) { res.status(400).json({ error: 'That is not a valid session.' }); return; }
  mkdirSync(sessionDir, { recursive: true });

  try {
    const inputPath = req.file.path;
    const outputPattern = join(sessionDir, 'frame-%04d.png');

    // Use ffmpeg to extract frames
    await new Promise<void>((resolve, reject) => {
      const args = [
        '-i', inputPath,
        '-vf', `fps=${fps}`,
        '-frames:v', String(maxFrames),
        outputPattern,
      ];
      const proc = spawn('ffmpeg', args);
      let stderr = '';
      proc.stderr.on('data', (d) => stderr += d.toString());
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
      });
      proc.on('error', reject);
    });

    // Clean up uploaded file
    try { unlinkSync(inputPath); } catch {}

    // List extracted frames
    const frames = readdirSync(sessionDir)
      .filter(f => f.startsWith('frame-') && f.endsWith('.png'))
      .sort()
      .map(f => ({
        filename: f,
        url: `/api/gif/frame/${sessionId}/${f}`,
      }));

    res.json({ sessionId, frames, fps });
  } catch (err: any) {
    console.error('[gif] extract-frames error:', err);
    res.status(500).json({ error: err.message || 'Failed to extract frames' });
  }
});

/**
 * Get a frame image
 * GET /api/gif/frame/:sessionId/:filename
 */
router.get('/gif/frame/:sessionId/:filename', (req, res) => {
  const { sessionId, filename } = req.params;
  // Sanitize to prevent path traversal
  if (sessionId.includes('..') || filename.includes('..')) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }
  const dir = sessionDirOf(sessionId);
  if (!dir || unsafeName(filename)) { res.status(400).json({ error: 'That is not a valid name.' }); return; }
  const framePath = join(dir, filename);
  if (!existsSync(framePath)) {
    res.status(404).json({ error: 'Frame not found' });
    return;
  }
  res.sendFile(framePath);
});

/**
 * Upload individual frames (for importing images)
 * POST /api/gif/upload-frame
 */
router.post('/gif/upload-frame', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded' });
    return;
  }

  const sessionId = (req.body.sessionId as string) || randomUUID();
  const sessionDir = sessionDirOf(sessionId);
  if (!sessionDir) { res.status(400).json({ error: 'That is not a valid session.' }); return; }
  mkdirSync(sessionDir, { recursive: true });

  try {
    // Find next frame number
    const existing = readdirSync(sessionDir).filter(f => f.startsWith('frame-'));
    const nextNum = existing.length + 1;
    const filename = `frame-${String(nextNum).padStart(4, '0')}.png`;
    const destPath = join(sessionDir, filename);

    // Convert to PNG if needed
    const ext = extname(req.file.originalname).toLowerCase();
    if (ext === '.png') {
      // Just move it
      const data = readFileSync(req.file.path);
      writeFileSync(destPath, data);
    } else {
      // Convert with ffmpeg
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('ffmpeg', ['-i', req.file!.path, '-y', destPath]);
        proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Convert failed: ${code}`)));
        proc.on('error', reject);
      });
    }

    // Clean up temp file
    try { unlinkSync(req.file.path); } catch {}

    res.json({
      sessionId,
      frame: { filename, url: `/api/gif/frame/${sessionId}/${filename}` },
    });
  } catch (err: any) {
    console.error('[gif] upload-frame error:', err);
    res.status(500).json({ error: err.message || 'Failed to upload frame' });
  }
});

/**
 * Save a processed frame (e.g., after client-side background removal)
 * POST /api/gif/save-frame/:sessionId/:filename
 * Body: base64 PNG data
 */
router.post('/gif/save-frame/:sessionId/:filename', (req, res) => {
  const { sessionId, filename } = req.params;
  const { data } = req.body;

  if (!data) {
    res.status(400).json({ error: 'No data provided' });
    return;
  }

  // Sanitize
  if (sessionId.includes('..') || filename.includes('..')) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  const sessionDir = sessionDirOf(sessionId);
  if (!sessionDir) { res.status(400).json({ error: 'That is not a valid session.' }); return; }
  if (!existsSync(sessionDir)) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  try {
    // Decode base64 and save
    const buffer = Buffer.from(data.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    const framePath = join(sessionDir, filename);
    writeFileSync(framePath, buffer);
    res.json({ ok: true });
  } catch (err: any) {
    console.error('[gif] save-frame error:', err);
    res.status(500).json({ error: err.message || 'Failed to save frame' });
  }
});

/**
 * Crop frames in a session
 * POST /api/gif/crop/:sessionId
 * Body: { x: number, y: number, width: number, height: number, filename?: string }
 *
 * Every frame by default — that is what a GIF wants, and what a matched batch out of
 * one generator wants. Pass a filename to cut exactly one, which is what the Cutout
 * tab wants once you can tap a picture in the batch and work on it by itself.
 */
router.post('/gif/crop/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { x = 0, y = 0, width, height, filename } = req.body;

  if (!width || !height) {
    res.status(400).json({ error: 'width and height required' });
    return;
  }

  if (sessionId.includes('..')) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  const sessionDir = sessionDirOf(sessionId);
  if (!sessionDir) { res.status(400).json({ error: 'That is not a valid session.' }); return; }
  if (!existsSync(sessionDir)) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  try {
    let frames = readdirSync(sessionDir).filter(f => f.startsWith('frame-') && f.endsWith('.png'));

    if (filename) {
      // Name it exactly. The originals kept for revert are original-frame-*.png, so a
      // startsWith guard also keeps a crop from ever eating the undo copy.
      if (typeof filename !== 'string' || filename.includes('..') || !filename.startsWith('frame-')) {
        res.status(400).json({ error: 'Invalid filename' });
        return;
      }
      frames = frames.filter(f => f === filename);
      if (frames.length === 0) {
        res.status(404).json({ error: 'Frame not found in this session' });
        return;
      }
    }

    for (const frame of frames) {
      const framePath = join(sessionDir, frame);
      const tempPath = join(sessionDir, `crop-temp-${frame}`);

      await new Promise<void>((resolve, reject) => {
        const args = [
          '-i', framePath,
          '-vf', `crop=${width}:${height}:${x}:${y}`,
          '-c:v', 'png',
          '-y',
          tempPath,
        ];
        const proc = spawn('ffmpeg', args);
        let stderr = '';
        proc.stderr.on('data', (d) => stderr += d.toString());
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`ffmpeg crop failed: ${stderr.slice(-500)}`));
        });
        proc.on('error', reject);
      });

      // Replace original with cropped version
      const data = readFileSync(tempPath);
      writeFileSync(framePath, data);
      try { unlinkSync(tempPath); } catch {}
    }

    res.json({ ok: true, croppedFrames: frames.length });
  } catch (err: any) {
    console.error('[gif] crop error:', err);
    res.status(500).json({ error: err.message || 'Crop failed' });
  }
});

/**
 * Chroma key removal — remove a specific color (e.g., green screen)
 * POST /api/gif/chroma-key/:sessionId/:filename
 * Body: { color: string (hex), tolerance?: number (0-1), blend?: number (0-1),
 *         mode?: 'chroma' | 'color' }
 *
 * Two filters, because they are good at different things. `chromakey` works in
 * YUV and is built for green screens. `colorkey` compares RGB directly, which
 * is what a flat generated backdrop — brown, orange, whatever — actually needs.
 * Default stays 'chroma' so existing GIF Lab calls behave as they always have.
 */
/**
 * Is local background removal available, and if not, what's missing?
 * GET /api/gif/cutout/status
 */
router.get('/gif/cutout/status', (_req, res) => {
  const runtime = cutoutRuntime();
  const ready = !!runtime.python && !!runtime.model
    && existsSync(runtime.python) && existsSync(runtime.model)
    && existsSync(CUTOUT_SCRIPT);
  res.json({
    ready,
    model: ready ? basename(runtime.model) : null,
    reason: ready ? null : cutoutSetupHint(runtime),
  });
});

/**
 * Remove the background from one frame, in place, keeping a copy of the
 * original so the tab can show a before and let the user start over.
 * POST /api/gif/cutout/:sessionId/:filename
 * Body: { feather?: number (px), threshold?: number (0-1) }
 */
router.post('/gif/cutout/:sessionId/:filename', async (req, res) => {
  const { sessionId, filename } = req.params;
  const { feather = 0, threshold } = req.body ?? {};

  if (sessionId.includes('..') || filename.includes('..')) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  const runtime = cutoutRuntime();
  if (!runtime.python || !runtime.model || !existsSync(runtime.python) || !existsSync(runtime.model)) {
    res.status(501).json({ error: cutoutSetupHint(runtime) });
    return;
  }

  const sessionDir = sessionDirOf(sessionId);
  if (!sessionDir) { res.status(400).json({ error: 'That is not a valid session.' }); return; }
  const framePath = join(sessionDir, filename);
  if (!existsSync(framePath)) {
    res.status(404).json({ error: 'Frame not found' });
    return;
  }

  // Keep the untouched frame once, so re-running with different edges works
  // from the original rather than from an already-cut image.
  const originalPath = join(sessionDir, `original-${filename}`);
  if (!existsSync(originalPath)) writeFileSync(originalPath, readFileSync(framePath));

  const outputPath = join(sessionDir, `cutout-${filename}`);
  const args = [CUTOUT_SCRIPT, originalPath, outputPath, '--model', runtime.model];
  // A second model family costs ~1s and covers the first one's blind spots:
  // one loses a secondary person, the other loses low-contrast clothing.
  for (const extra of cutoutRuntime().alsoModels) args.push('--also-model', extra);
  const featherPx = Number(feather);
  if (Number.isFinite(featherPx) && featherPx > 0) args.push('--feather', String(Math.min(12, featherPx)));
  const cut = Number(threshold);
  if (Number.isFinite(cut) && cut > 0) args.push('--threshold', String(Math.min(1, cut)));

  try {
    const stderr = await new Promise<string>((resolve, reject) => {
      const proc = spawn(runtime.python, args);
      let err = '';
      proc.stderr.on('data', (chunk) => { err += chunk.toString(); });
      proc.on('close', (code) => code === 0 ? resolve(err) : reject(new Error(err.trim() || `cutout exited ${code}`)));
      proc.on('error', reject);
    });
    if (stderr.trim()) console.warn('[gif] cutout notes:', stderr.trim());

    writeFileSync(framePath, readFileSync(outputPath));
    try { unlinkSync(outputPath); } catch { /* best effort */ }

    res.json({
      filename,
      url: `/api/gif/frame/${sessionId}/${filename}?t=${Date.now()}`,
      originalUrl: `/api/gif/frame/${sessionId}/original-${filename}`,
    });
  } catch (err: any) {
    console.error('[gif] cutout error:', err);
    res.status(500).json({ error: err.message || 'Background removal failed' });
  }
});

/**
 * Put a cut frame back the way it arrived.
 * POST /api/gif/cutout/:sessionId/:filename/revert
 */
router.post('/gif/cutout/:sessionId/:filename/revert', (req, res) => {
  const { sessionId, filename } = req.params;
  if (sessionId.includes('..') || filename.includes('..')) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }
  const sessionDir = sessionDirOf(sessionId);
  if (!sessionDir) { res.status(400).json({ error: 'That is not a valid session.' }); return; }
  const originalPath = join(sessionDir, `original-${filename}`);
  if (!existsSync(originalPath)) {
    res.status(404).json({ error: 'No original kept for this frame' });
    return;
  }
  writeFileSync(join(sessionDir, filename), readFileSync(originalPath));
  res.json({ filename, url: `/api/gif/frame/${sessionId}/${filename}?t=${Date.now()}` });
});

/**
 * Export one frame as a still, to a size budget, keeping transparency.
 * POST /api/gif/still-export/:sessionId/:filename
 * Body: { format?: 'png'|'webp', maxSide?: number, maxBytes?: number,
 *         padSquare?: boolean, allowReduce?: boolean }
 *
 * PNG with alpha has no palette limit, so nothing lossy happens unless the file
 * is genuinely over budget — the color ladder is a last resort, not a default.
 */
router.post('/gif/still-export/:sessionId/:filename', async (req, res) => {
  const { sessionId, filename } = req.params;
  const {
    format = 'png', maxSide = 0, maxBytes = 0, padSquare = false, allowReduce = true,
  } = req.body ?? {};

  if (sessionId.includes('..') || filename.includes('..')) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }
  if (format !== 'png' && format !== 'webp') {
    res.status(400).json({ error: "format must be 'png' or 'webp'" });
    return;
  }

  const sessionDir = sessionDirOf(sessionId);
  if (!sessionDir) { res.status(400).json({ error: 'That is not a valid session.' }); return; }
  const framePath = join(sessionDir, filename);
  if (!existsSync(framePath)) {
    res.status(404).json({ error: 'Frame not found' });
    return;
  }
  if (!existsSync(STILL_EXPORT_SCRIPT)) {
    res.status(501).json({ error: 'tools/still-export.py is missing from this install' });
    return;
  }

  // A single-image session always names its frame frame-0001, so deriving the
  // export name from it gave every cutout ever made the identical filename.
  // Stamping it makes each save land under its own name in the phone's
  // downloads instead of stacking up as copies of one file.
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
  const outName = `cutout-${stamp}.${format}`;
  const outPath = join(sessionDir, outName);
  const args = [STILL_EXPORT_SCRIPT, framePath, outPath, '--format', format];
  if (Number(maxSide) > 0) args.push('--max-side', String(Math.min(4096, Math.round(Number(maxSide)))));
  if (Number(maxBytes) > 0) args.push('--max-bytes', String(Math.round(Number(maxBytes))));
  if (padSquare) args.push('--pad-square');
  if (!allowReduce) args.push('--no-reduce');

  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const proc = spawn(stillExportPython(), args);
      let out = '';
      let err = '';
      proc.stdout.on('data', (chunk) => { out += chunk.toString(); });
      proc.stderr.on('data', (chunk) => { err += chunk.toString(); });
      proc.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(err.trim() || `export exited ${code}`)));
      proc.on('error', reject);
    });

    let stats: Record<string, unknown> = {};
    try { stats = JSON.parse(stdout.trim().split('\n').pop() || '{}'); } catch { /* report what we can */ }

    res.json({
      filename: outName,
      url: `/api/gif/output/${sessionId}/${outName}?t=${Date.now()}`,
      ...stats,
    });
  } catch (err: any) {
    console.error('[gif] still-export error:', err);
    res.status(500).json({ error: err.message || 'Export failed' });
  }
});

/**
 * Hand-painted corrections to a cut frame's transparency.
 * POST /api/gif/mask-paint/:sessionId/:filename
 * Multipart: optional `restore` and `erase` painted layers (PNG with strokes
 * drawn on transparency, any size).
 *
 * The point of this route is that no model gets every picture right. Rather than
 * a picture being a loss, the person looking at it paints the fix. Only alpha is
 * edited; restored pixels come from the retained original, not from a guess.
 */
router.post(
  '/gif/mask-paint/:sessionId/:filename',
  upload.fields([{ name: 'restore', maxCount: 1 }, { name: 'erase', maxCount: 1 }]),
  async (req, res) => {
    // Express types params as string | string[] once middleware is attached.
    const sessionId = String(req.params.sessionId);
    const filename = String(req.params.filename);
    const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
    const restore = files.restore?.[0];
    const erase = files.erase?.[0];

    const cleanup = () => {
      for (const file of [restore, erase]) {
        if (file?.path) { try { unlinkSync(file.path); } catch { /* best effort */ } }
      }
    };

    if (sessionId.includes('..') || filename.includes('..')) {
      cleanup();
      res.status(400).json({ error: 'Invalid path' });
      return;
    }
    if (!restore && !erase) {
      res.status(400).json({ error: 'Nothing painted' });
      return;
    }

    const sessionDir = sessionDirOf(sessionId);
  if (!sessionDir) { res.status(400).json({ error: 'That is not a valid session.' }); return; }
    const framePath = join(sessionDir, filename);
    if (!existsSync(framePath)) {
      cleanup();
      res.status(404).json({ error: 'Frame not found' });
      return;
    }
    if (!existsSync(MASK_PAINT_SCRIPT)) {
      cleanup();
      res.status(501).json({ error: 'tools/mask-paint.py is missing from this install' });
      return;
    }

    // Painting can happen before any cut, so the original may not exist yet.
    const originalPath = join(sessionDir, `original-${filename}`);
    if (!existsSync(originalPath)) writeFileSync(originalPath, readFileSync(framePath));

    const outputPath = join(sessionDir, `painted-${filename}`);
    const args = [MASK_PAINT_SCRIPT, framePath, originalPath, outputPath];
    if (restore) args.push('--restore', restore.path);
    if (erase) args.push('--erase', erase.path);

    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(stillExportPython(), args);
        let err = '';
        proc.stderr.on('data', (chunk) => { err += chunk.toString(); });
        proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(err.trim() || `mask-paint exited ${code}`)));
        proc.on('error', reject);
      });

      writeFileSync(framePath, readFileSync(outputPath));
      try { unlinkSync(outputPath); } catch { /* best effort */ }

      res.json({
        filename,
        url: `/api/gif/frame/${sessionId}/${filename}?t=${Date.now()}`,
      });
    } catch (err: any) {
      console.error('[gif] mask-paint error:', err);
      res.status(500).json({ error: err.message || 'Painting failed' });
    } finally {
      cleanup();
    }
  },
);

router.post('/gif/chroma-key/:sessionId/:filename', async (req, res) => {
  const { sessionId, filename } = req.params;
  const { color, tolerance = 0.3, blend = 0.1, mode = 'chroma' } = req.body;

  if (!color) {
    res.status(400).json({ error: 'color required (hex format)' });
    return;
  }

  if (sessionId.includes('..') || filename.includes('..')) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  const sessionDir = sessionDirOf(sessionId);
  if (!sessionDir) { res.status(400).json({ error: 'That is not a valid session.' }); return; }
  const framePath = join(sessionDir, filename);
  if (!existsSync(framePath)) {
    res.status(404).json({ error: 'Frame not found' });
    return;
  }

  try {
    const outputPath = join(sessionDir, `chroma-${filename}`);

    // Parse hex color to RGB
    const hex = color.replace('#', '');
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);

    // Similarity is 0-1 where 0.01 is very tight and 0.5 is loose
    const similarity = Math.min(1, Math.max(0.01, Number(tolerance)));
    const softness = Math.min(1, Math.max(0, Number(blend)));
    const filter = mode === 'color' ? 'colorkey' : 'chromakey';

    // Keep the untouched frame so a key can be retried, or undone, from the
    // real image rather than from an already-keyed one.
    const keyOriginal = join(sessionDir, `original-${filename}`);
    if (!existsSync(keyOriginal)) writeFileSync(keyOriginal, readFileSync(framePath));

    await new Promise<void>((resolve, reject) => {
      const args = [
        '-i', keyOriginal,
        '-vf', `${filter}=0x${hex.toUpperCase()}:${similarity}:${softness}`,
        '-c:v', 'png',
        '-y',
        outputPath,
      ];
      const proc = spawn('ffmpeg', args);
      let stderr = '';
      proc.stderr.on('data', (d) => stderr += d.toString());
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg chromakey failed: ${stderr.slice(-500)}`));
      });
      proc.on('error', reject);
    });

    // Replace original with keyed version
    const data = readFileSync(outputPath);
    writeFileSync(framePath, data);
    try { unlinkSync(outputPath); } catch {}

    res.json({
      ok: true,
      filename,
      url: `/api/gif/frame/${sessionId}/${filename}?t=${Date.now()}`,
    });
  } catch (err: any) {
    console.error('[gif] chroma-key error:', err);
    res.status(500).json({ error: err.message || 'Chroma key failed' });
  }
});

/**
 * Create GIF from frames
 * POST /api/gif/create
 * Body: { sessionId, frames: string[], fps: number, loop: boolean, optimize: boolean, width?: number, height?: number,
 *         speed?: number, lossy?: number, colors?: number, dither?: boolean, text?: { content, position, fontSize, fontColor, borderColor, fontFamily } }
 */
/**
 * Say what happened, in words, before handing over the machine's own account.
 *
 * ffmpeg reports a size mismatch as "Task finished with error code -558323010
 * (Internal bug, should not have happened)" plus a frame number — which is
 * true, useless, and frightening. Anything a person can act on goes first;
 * the raw tail stays underneath for whoever wants it.
 */
function explainFfmpegFailure(stderr: string): string {
  const tail = stderr.slice(-400).trim();
  const frameMatch = stderr.match(/frame=\s*(\d+)/);
  const atFrame = frameMatch ? ` It stopped at frame ${frameMatch[1]}.` : '';
  if (/Internal bug, should not have happened|changing frame properties|Invalid frame size/i.test(stderr)) {
    // ffmpeg says underneath exactly what changed — "Reconfiguring filter graph
    // because video parameters changed to rgba(pc, gbr), 320x240" — and that
    // line carries BOTH the pixel format and the size. The two fail
    // identically from the outside: a run of RGB frames followed by one RGBA
    // frame dies the same way 320x240 followed by 200x200 does. This used to
    // report the size every time, which sent you to re-fit frames that already
    // matched. Read what it actually said instead of picking one.
    // The lazy [^\n]*? is load-bearing: the format prints as "rgba(pc, gbr)",
    // so a regex that stops at the first comma never reaches the dimensions
    // and this whole branch silently falls through to the generic message.
    const changes = [...stderr.matchAll(/video parameters changed to\s+([a-z0-9]+)[^\n]*?(\d+)x(\d+)/gi)]
      .map((m) => ({ format: m[1].toLowerCase(), size: `${m[2]}x${m[3]}` }));
    const sizes = [...new Set(changes.map((c) => c.size))];
    const formats = [...new Set(changes.map((c) => c.format))];

    if (sizes.length > 1) {
      return `Those pictures are not all the same size, so they cannot be strung together as one animation.${atFrame} `
        + `ffmpeg saw ${sizes.join(', then ')}. Re-run this once the frames have been fitted to a common canvas.\n\n${tail}`;
    }
    if (changes.length) {
      const said = formats.length
        ? ` ffmpeg had to switch to ${formats.join(', then ')}${sizes.length ? ` at ${sizes[0]}` : ''}.`
        : '';
      return `The frames stopped matching partway through — same size, different picture format.${atFrame}${said} `
        + `They have to agree on both. This usually means frames pulled out of a video were mixed with images added `
        + `separately.\n\n${tail}`;
    }
    return `The frames stopped matching partway through, so they cannot be strung together as one animation.${atFrame} `
      + `They have to be identical in size AND in picture format.\n\n${tail}`;
  }
  if (/No such file or directory|Could not open file/i.test(stderr)) {
    return `One of the frames has gone missing from this session.${atFrame} Re-import the images and try again.\n\n${tail}`;
  }
  if (/Invalid data found|moov atom not found|Decoder .* not found/i.test(stderr)) {
    return `One of the files could not be read as an image or video.${atFrame}\n\n${tail}`;
  }
  return `Could not build the GIF.${atFrame}\n\n${tail}`;
}

router.post('/gif/create', async (req, res) => {
  const { sessionId, frames, fps = 10, loop = true, optimize = true, width, height, fit = false, speed, lossy, colors, dither = false, text, delayMs } = req.body;

  if (!sessionId || !frames?.length) {
    res.status(400).json({ error: 'sessionId and frames required' });
    return;
  }

  const sessionDir = sessionDirOf(sessionId);
  if (!sessionDir) { res.status(400).json({ error: 'That is not a valid session.' }); return; }
  if (!existsSync(sessionDir)) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  try {
    const outputId = randomUUID();
    const rawGif = join(sessionDir, `${outputId}-raw.gif`);
    const finalGif = join(sessionDir, `${outputId}.gif`);
    const paletteFile = join(sessionDir, `${outputId}-palette.png`);

    // Build filter string with optional scaling
    let scaleFilter = '';
    if (width || height) {
      const w = width || -1;
      const h = height || -1;
      scaleFilter = fit && width && height
        ? `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,`
        : `scale=${w}:${h}:flags=lanczos,`;
    }

    // Use image2 demuxer with glob pattern for transparent PNGs
    // First, create symlinks with sequential names to handle arbitrary filenames
    const seqDir = join(sessionDir, `seq-${outputId}`);
    mkdirSync(seqDir, { recursive: true });

    // EVERY FRAME HAS TO BE THE SAME SIZE BEFORE FFMPEG SEES IT.
    // The image2 demuxer reads the first picture, fixes the stream size from it,
    // and dies on the first one that differs — with an "internal bug, should not
    // have happened" and a frame number, which is the only clue that the picture
    // at that index was a different shape. Extracted video frames always match;
    // hand-picked images almost never do. So the canvas is the largest width and
    // the largest height across the set, and anything smaller is centered on it
    // with transparent padding rather than stretched.
    const sizes = await Promise.all(frames.map(async (f: string) => {
      const src = join(sessionDir, f);
      if (!existsSync(src)) return null;
      try {
        const meta = await sharp(src).metadata();
        return { width: meta.width || 0, height: meta.height || 0 };
      } catch {
        return null;
      }
    }));
    const canvasW = Math.max(1, ...sizes.map((s) => s?.width || 0));
    const canvasH = Math.max(1, ...sizes.map((s) => s?.height || 0));

    for (let i = 0; i < frames.length; i++) {
      const src = join(sessionDir, frames[i]);
      const dst = join(seqDir, `frame${String(i).padStart(5, '0')}.png`);
      if (!existsSync(src)) continue;
      const size = sizes[i];
      if (size && size.width === canvasW && size.height === canvasH) {
        // THE SAME SIZE IS NOT THE SAME FORMAT, and ffmpeg cares about both.
        // This used to copy the bytes straight through, which is faster and
        // wrong: frames extracted from a video are RGB, while anything sharp
        // has touched comes back RGBA. Mix the two in one sequence and the
        // filter graph reconfigures halfway and dies with "Internal bug, should
        // not have happened" — which the handler below reads as a size
        // mismatch, sending you to fix a thing that was never broken. Import a
        // video, add a still, press create: that was the whole bug.
        await sharp(src).ensureAlpha().png().toFile(dst);
        continue;
      }
      // withoutEnlargement: a smaller picture sits on the canvas at its own
      // size rather than being blown up to fill it. Upscaling a 200px sticker
      // to sit beside a 1000px photo makes the whole set soft to rescue one
      // frame's framing, and softness cannot be undone later. Flip this to
      // false if filling the canvas ever matters more than staying sharp.
      await sharp(src)
        .resize(canvasW, canvasH, {
          fit: 'contain',
          withoutEnlargement: true,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .ensureAlpha()
        .png()
        .toFile(dst);
    }

    const inputPattern = join(seqDir, 'frame%05d.png');

    // Step 1: Generate palette (needed for transparency)
    await new Promise<void>((resolve, reject) => {
      const args = [
        '-framerate', String(fps),
        '-i', inputPattern,
        '-vf', `${scaleFilter}palettegen=reserve_transparent=1`,
        '-y',
        paletteFile,
      ];
      const proc = spawn('ffmpeg', args);
      let stderr = '';
      proc.stderr.on('data', (d) => stderr += d.toString());
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(explainFfmpegFailure(stderr)));
      });
      proc.on('error', reject);
    });

    // Step 2: Create GIF using palette
    // ffmpeg's gif encoder enables `transdiff` and `offsetting` BY DEFAULT — it writes
    // each frame as a delta (unchanged pixels marked transparent, cropped to a bounding
    // box) and relies on the previous frame showing through. That is invisible on an
    // opaque GIF and catastrophic on a transparent one: the areas that should be see-through
    // get filled by the previous frame instead. Removing flags we never passed does nothing —
    // these have to be switched OFF explicitly so every frame is written whole.
    await new Promise<void>((resolve, reject) => {
      const args = [
        '-framerate', String(fps),
        '-i', inputPattern,
        '-i', paletteFile,
        '-lavfi', `${scaleFilter}paletteuse=alpha_threshold=128`,
        '-gifflags', '-transdiff-offsetting',
        '-loop', loop ? '0' : '-1',
        '-y',
        rawGif,
      ];
      const proc = spawn('ffmpeg', args);
      let stderr = '';
      proc.stderr.on('data', (d) => stderr += d.toString());
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(explainFfmpegFailure(stderr)));
      });
      proc.on('error', reject);
    });

    // Cleanup temp files
    try { unlinkSync(paletteFile); } catch {}
    try {
      for (const f of readdirSync(seqDir)) unlinkSync(join(seqDir, f));
      require('fs').rmdirSync(seqDir);
    } catch {}

    // GIF transparency means "keep whatever pixel was already there", so every frame of a
    // transparent animation needs disposal method 2 (restore to background) or the previous
    // frame stays visible underneath. ffmpeg's muxer can't set disposal; gifsicle can.
    // This is safe now only because the frames above are whole — applying it to delta frames
    // clears everything except what changed (which is why an earlier attempt left just the eyes).
    // No -O flag: gifsicle without it rewrites frames as-is instead of re-differencing them.
    const gifsicleArgs: string[] = ['--disposal=background'];
    // How long each frame is HELD, in milliseconds, independent of the frame rate.
    // A frame rate is the right control for video; a hold time is the right one for
    // a handful of stills, and gifsicle stores delay per frame in centiseconds —
    // its own floor is 2 (20ms), below which browsers substitute their own.
    if (typeof delayMs === 'number' && delayMs > 0) {
      gifsicleArgs.push('-d', String(Math.max(2, Math.min(6000, Math.round(delayMs / 10)))));
    }
    if (typeof colors === 'number' && colors >= 2 && colors <= 256) {
      gifsicleArgs.push('--colors', String(colors));
      // Dithering helps photographic sources and hurts flat art — it adds visible
      // speckle and inflates the file, so the caller decides rather than us.
      if (dither) gifsicleArgs.push('--dither');
    }
    if (typeof lossy === 'number' && lossy > 0) {
      gifsicleArgs.push(`--lossy=${Math.min(200, Math.max(0, lossy))}`);
    }
    gifsicleArgs.push('-o', finalGif, rawGif);

    await new Promise<void>((resolve, reject) => {
      const proc = spawn('gifsicle', gifsicleArgs);
      let stderr = '';
      proc.stderr.on('data', (d) => stderr += d.toString());
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`gifsicle failed: ${stderr || code}`));
      });
      proc.on('error', reject);
    });
    try { unlinkSync(rawGif); } catch {}

    // Apply speed change if requested
    if (typeof speed === 'number' && speed !== 1) {
      const clampedSpeed = Math.min(4, Math.max(0.25, speed));
      const delayMultiplier = 1 / clampedSpeed;
      const speedTempGif = join(sessionDir, `${outputId}-speed.gif`);

      // Get current delay
      const infoProc = spawn('gifsicle', ['--info', finalGif]);
      let info = '';
      infoProc.stdout.on('data', d => info += d.toString());
      infoProc.stderr.on('data', d => info += d.toString());
      await new Promise<void>((resolve) => infoProc.on('close', resolve));

      const delayMatch = info.match(/delay (\d+\.?\d*)s/);
      const currentDelay = delayMatch ? parseFloat(delayMatch[1]) : 0.1;
      const newDelay = Math.round(currentDelay * delayMultiplier * 100);

      await new Promise<void>((resolve, reject) => {
        const args = ['-d', String(Math.max(2, newDelay)), '-O3', '-o', speedTempGif, finalGif];
        const proc = spawn('gifsicle', args);
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`gifsicle speed failed: ${code}`));
        });
        proc.on('error', reject);
      });
      // Replace original
      const data = readFileSync(speedTempGif);
      writeFileSync(finalGif, data);
      try { unlinkSync(speedTempGif); } catch {}
    }

    // Apply text overlay if requested
    if (text?.content) {
      const textTempGif = join(sessionDir, `${outputId}-text.gif`);
      const { content, position = 'bottom', fontSize = 24, fontColor = 'white', borderColor = 'black', fontFamily = 'DejaVu Sans', anchor } = text;

      const { posX, posY } = textPositionExprs({ position, anchor });

      const escapedText = content.replace(/\\/g, '\\\\').replace(/'/g, "'\\''").replace(/:/g, '\\:');
      const escapedFont = fontFamily.replace(/:/g, '\\:');
      const drawTextFilter = `drawtext=text='${escapedText}':font='${escapedFont}':fontsize=${fontSize}:fontcolor=${fontColor}:${posX}:${posY}:borderw=2:bordercolor=${borderColor}`;

      await new Promise<void>((resolve, reject) => {
        const args = drawTextArgs(finalGif, drawTextFilter, textTempGif);
        const proc = spawn('ffmpeg', args);
        let stderr = '';
        proc.stderr.on('data', d => stderr += d.toString());
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`ffmpeg text failed: ${stderr.slice(-500)}`));
        });
        proc.on('error', reject);
      });
      // Replace original
      const data = readFileSync(textTempGif);
      writeFileSync(finalGif, data);
      try { unlinkSync(textTempGif); } catch {}
    }

    // Get file size
    const stats = statSync(finalGif);
    const sizeBytes = stats.size;
    const sizeKb = Math.round(sizeBytes / 1024);
    const discordOk = sizeBytes <= 256 * 1024;

    res.json({
      url: `/api/gif/output/${sessionId}/${outputId}.gif`,
      filename: `${outputId}.gif`,
      sizeBytes,
      sizeKb,
      discordOk,
    });
  } catch (err: any) {
    console.error('[gif] create error:', err);
    res.status(500).json({ error: err.message || 'Failed to create GIF' });
  }
});

/** Run gifsicle and resolve with its combined output (--info writes to stdout). */
function runGifsicle(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('gifsicle', args);
    let out = '';
    let err = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', (code) => {
      if (code === 0) resolve(out + err);
      else reject(new Error(`gifsicle failed: ${err.trim() || `exit ${code}`}`));
    });
    proc.on('error', reject);
  });
}

/** Per-frame delays in hundredths of a second, in frame order, from `gifsicle --info`. */
function parseDelays(info: string): number[] {
  return [...info.matchAll(/delay ([\d.]+)s/g)].map(m => Math.round(parseFloat(m[1]) * 100));
}

const DITHER_METHODS = ['default', 'floyd-steinberg', 'ro64', 'o3', 'o4', 'o8', 'ordered', 'halftone', 'squarehalftone', 'diagonal', 'atkinson'];
const COLOR_METHODS = ['diversity', 'blend-diversity', 'median-cut'];

/**
 * Drop consecutive duplicate frames, folding each dropped frame's delay into the
 * frame it repeats so the animation keeps its original timing.
 *
 * Compares decoded pixels rather than stored frame bytes. Two identical-looking frames can
 * be written with different palettes, so hashing the frame files finds only a fraction of
 * the duplicates (31 of 58 on the test animation). One ffmpeg pass composites every frame
 * to a PNG instead, and PNG output is deterministic for identical pixels.
 *
 * Rebuilds from gifsicle's exploded frames, which keep palette and transparency, and which
 * are whole frames — consistent with the create route's deliberate ghost-frame avoidance.
 *
 * Returns the number of frames removed.
 */
async function dropDuplicateFrames(inputPath: string, outputPath: string, workDir: string): Promise<number> {
  const scratch = join(workDir, `dedup-${randomUUID()}`);
  mkdirSync(scratch, { recursive: true });

  try {
    const info = await runGifsicle(['--info', inputPath]);
    const delays = parseDelays(info);
    const loopsForever = /loop forever/.test(info);

    await new Promise<void>((resolve, reject) => {
      const proc = spawn('ffmpeg', [
        '-loglevel', 'error', '-i', inputPath,
        '-fps_mode', 'passthrough', join(scratch, 'p-%05d.png'),
      ]);
      let stderr = '';
      proc.stderr.on('data', d => stderr += d.toString());
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${stderr.trim() || code}`)));
      proc.on('error', reject);
    });

    await runGifsicle(['--unoptimize', '--explode', '-o', join(scratch, 'g'), inputPath]);

    const entries = readdirSync(scratch);
    const pngs = entries.filter(f => f.startsWith('p-')).sort();
    const gifFrames = entries.filter(f => f.startsWith('g.')).sort();

    // If the two decoders disagree on frame count there is no safe way to map one onto
    // the other, so leave the animation alone rather than dropping the wrong frames.
    if (gifFrames.length < 2 || pngs.length !== gifFrames.length) return 0;

    const kept: { file: string; delay: number }[] = [];
    let lastHash = '';
    pngs.forEach((p, i) => {
      const hash = createHash('sha1').update(readFileSync(join(scratch, p))).digest('hex');
      const delay = delays[i] ?? 10;
      if (hash === lastHash && kept.length > 0) {
        kept[kept.length - 1].delay += delay;
      } else {
        kept.push({ file: join(scratch, gifFrames[i]), delay });
        lastHash = hash;
      }
    });

    const removed = gifFrames.length - kept.length;
    if (removed === 0) return 0;

    // These are whole transparent frames. Clear the canvas before drawing the next
    // one or transparent pixels reveal the previous frame as a ghost underneath.
    const args: string[] = ['--disposal=background'];
    if (loopsForever) args.push('--loopcount=forever');
    for (const k of kept) args.push(`--delay=${Math.max(1, k.delay)}`, k.file);
    args.push('-o', outputPath);
    await runGifsicle(args);

    return removed;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Drop every nth frame and fold its delay into the preceding retained frame. */
async function dropEveryNthFrame(
  inputPath: string,
  outputPath: string,
  workDir: string,
  nth: number,
): Promise<number> {
  const scratch = join(workDir, `thin-${randomUUID()}`);
  mkdirSync(scratch, { recursive: true });

  try {
    const info = await runGifsicle(['--info', inputPath]);
    const delays = parseDelays(info);
    const loopsForever = /loop forever/.test(info);
    await runGifsicle(['--unoptimize', '--explode', '-o', join(scratch, 'f'), inputPath]);
    const gifFrames = readdirSync(scratch).filter(f => f.startsWith('f.')).sort();
    if (gifFrames.length < 2) return 0;

    const kept: { file: string; delay: number }[] = [];
    gifFrames.forEach((frame, index) => {
      const delay = delays[index] ?? 10;
      if ((index + 1) % nth === 0 && kept.length > 0) {
        kept[kept.length - 1].delay += delay;
      } else {
        kept.push({ file: join(scratch, frame), delay });
      }
    });

    const removed = gifFrames.length - kept.length;
    if (removed === 0) return 0;
    // `--explode` gives us whole frames, but disposal is not reliably carried when
    // selected frames are assembled into a new GIF. Set it explicitly so transparent
    // regions remain transparent instead of accumulating prior poses.
    const args: string[] = ['--disposal=background'];
    if (loopsForever) args.push('--loopcount=forever');
    for (const frame of kept) {
      args.push(`--delay=${Math.max(1, frame.delay)}`, frame.file);
    }
    args.push('-o', outputPath);
    await runGifsicle(args);
    return removed;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Optimize an existing GIF with gifsicle
 * POST /api/gif/optimize/:sessionId/:filename
 * Body: {
 *   lossy?: number (0-200), colors?: number (2-256),
 *   dither?: boolean (default false), ditherMethod?: string, colorMethod?: string,
 *   optimizeLevel?: 1|2|3 (default 3), unoptimize?: boolean,
 *   removeFrames?: number (2-4), dropDuplicates?: boolean,
 *   stripMetadata?: boolean (default true), interlace?: boolean,
 *   scale?: number (0-1), resizeWidth?: number, resizeHeight?: number
 * }
 */
router.post('/gif/optimize/:sessionId/:filename', async (req, res) => {
  const { sessionId, filename } = req.params;
  const {
    lossy, colors, dither = false, ditherMethod, colorMethod,
    optimizeLevel = 3, unoptimize = false,
    removeFrames, dropDuplicates = false,
    stripMetadata = true, interlace = false,
    scale, resizeWidth, resizeHeight, maxBytes = 256 * 1024,
  } = req.body;

  if (sessionId.includes('..') || filename.includes('..')) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  const sessionDir = sessionDirOf(sessionId);
  if (!sessionDir) { res.status(400).json({ error: 'That is not a valid session.' }); return; }
  const gifPath = join(sessionDir, filename);
  if (!existsSync(gifPath)) {
    res.status(404).json({ error: 'GIF not found' });
    return;
  }

  const outputId = randomUUID();
  const outputPath = join(sessionDir, `${outputId}.gif`);
  let dedupPath: string | null = null;
  let thinnedPath: string | null = null;

  try {
    const sizeBefore = statSync(gifPath).size;
    let sourcePath = gifPath;
    let framesDropped = 0;

    // Duplicate removal rewrites the file, so it runs as its own pass first.
    if (dropDuplicates) {
      const candidate = join(sessionDir, `${outputId}-dedup.gif`);
      framesDropped = await dropDuplicateFrames(gifPath, candidate, sessionDir);
      if (framesDropped > 0) {
        dedupPath = candidate;
        sourcePath = candidate;
      }
    }

    if (typeof removeFrames === 'number' && removeFrames >= 2 && removeFrames <= 4) {
      const candidate = join(sessionDir, `${outputId}-thin.gif`);
      const removed = await dropEveryNthFrame(sourcePath, candidate, sessionDir, removeFrames);
      if (removed > 0) {
        thinnedPath = candidate;
        sourcePath = candidate;
        framesDropped += removed;
      }
    }

    const args: string[] = [];

    // Coalesce to whole frames — larger, but some editors choke on delta frames.
    if (unoptimize) args.push('--unoptimize');

    // Comments and names are pure overhead once a GIF is finished.
    if (stripMetadata) args.push('--no-comments', '--no-names', '--no-extensions');

    // Lossy compression (0-200, higher = smaller and noisier)
    if (typeof lossy === 'number' && lossy > 0) {
      args.push(`--lossy=${Math.min(200, Math.max(0, lossy))}`);
    }

    // Color reduction (2-256)
    if (typeof colors === 'number' && colors >= 2 && colors <= 256) {
      args.push('--colors', String(colors));
      if (typeof colorMethod === 'string' && COLOR_METHODS.includes(colorMethod)) {
        args.push('--color-method', colorMethod);
      }
      // Dithering trades file size for smoother gradients — worth it on photos,
      // actively harmful on flat art, so it is the caller's call. Defaults off:
      // measured on a 41-frame transparent emote at 64 colors, dithering moved
      // ~22 px/frame away from the source AND grew the file (253 KB vs 245 KB).
      // Emotes and stickers are flat art, which is most of what this Lab makes.
      if (dither) {
        args.push(typeof ditherMethod === 'string' && DITHER_METHODS.includes(ditherMethod)
          ? `--dither=${ditherMethod}`
          : '--dither');
      }
    }

    // Resize: proportional scale, or fit inside a box (gifsicle takes _ for "unset").
    if (typeof scale === 'number' && scale > 0 && scale < 1) {
      args.push('--scale', String(scale));
    } else if (typeof resizeWidth === 'number' || typeof resizeHeight === 'number') {
      const w = typeof resizeWidth === 'number' ? Math.round(resizeWidth) : '_';
      const h = typeof resizeHeight === 'number' ? Math.round(resizeHeight) : '_';
      args.push('--resize-fit', `${w}x${h}`);
    }

    if (interlace) args.push('--interlace');

    const level = [1, 2, 3].includes(optimizeLevel) ? optimizeLevel : 3;
    args.push(`-O${level}`);
    args.push('-o', outputPath);
    args.push(sourcePath);

    await runGifsicle(args);

    const sizeBytes = statSync(outputPath).size;

    res.json({
      url: `/api/gif/output/${sessionId}/${outputId}.gif`,
      filename: `${outputId}.gif`,
      sizeBytes,
      sizeKb: Math.round(sizeBytes / 1024),
      sizeBeforeKb: Math.round(sizeBefore / 1024),
      savedPercent: sizeBefore > 0 ? Math.round((1 - sizeBytes / sizeBefore) * 100) : 0,
      framesDropped,
      discordOk: sizeBytes <= Math.min(512 * 1024, Math.max(1, Number(maxBytes))),
      maxKb: Math.round(Math.min(512 * 1024, Math.max(1, Number(maxBytes))) / 1024),
    });
  } catch (err: any) {
    console.error('[gif] optimize error:', err);
    res.status(500).json({ error: err.message || 'Optimization failed' });
  } finally {
    if (dedupPath && existsSync(dedupPath)) unlinkSync(dedupPath);
    if (thinnedPath && existsSync(thinnedPath)) unlinkSync(thinnedPath);
  }
});

/**
 * Change GIF speed
 * POST /api/gif/speed/:sessionId/:filename
 * Body: { speed: number (0.25-4, where 2 = 2x faster, 0.5 = half speed) }
 */
router.post('/gif/speed/:sessionId/:filename', async (req, res) => {
  const { sessionId, filename } = req.params;
  const { speed = 1 } = req.body;

  if (sessionId.includes('..') || filename.includes('..')) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  const dir = sessionDirOf(sessionId);
  if (!dir || unsafeName(filename)) { res.status(400).json({ error: 'That is not a valid name.' }); return; }
  const gifPath = join(dir, filename);
  if (!existsSync(gifPath)) {
    res.status(404).json({ error: 'GIF not found' });
    return;
  }

  // Clamp speed to reasonable range
  const clampedSpeed = Math.min(4, Math.max(0.25, speed));
  // Delay multiplier is inverse of speed (faster = shorter delays)
  const delayMultiplier = 1 / clampedSpeed;

  try {
    const outputId = randomUUID();
    const outputPath = join(dir, `${outputId}.gif`);

    // gifsicle --delay expects 1/100ths of a second
    // We use --scale-delay to multiply existing delays
    // Actually gifsicle doesn't have scale-delay, we need to use -d with #all
    // Better approach: use -d N to set uniform delay across all frames

    // First get current delay info
    const infoProc = spawn('gifsicle', ['--info', gifPath]);
    let info = '';
    infoProc.stdout.on('data', d => info += d.toString());
    infoProc.stderr.on('data', d => info += d.toString());
    await new Promise<void>((resolve) => infoProc.on('close', resolve));

    // Parse typical delay (usually in format "delay X.XXs")
    const delayMatch = info.match(/delay (\d+\.?\d*)s/);
    const currentDelay = delayMatch ? parseFloat(delayMatch[1]) : 0.1;
    const newDelay = Math.round(currentDelay * delayMultiplier * 100); // Convert to centiseconds

    await new Promise<void>((resolve, reject) => {
      const args = [
        '-d', String(Math.max(2, newDelay)), // Minimum 2 centiseconds
        '-O3',
        '-o', outputPath,
        gifPath,
      ];
      const proc = spawn('gifsicle', args);
      let stderr = '';
      proc.stderr.on('data', d => stderr += d.toString());
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`gifsicle failed: ${stderr || code}`));
      });
      proc.on('error', reject);
    });

    const stats = statSync(outputPath);
    const sizeBytes = stats.size;
    const sizeKb = Math.round(sizeBytes / 1024);
    const discordOk = sizeBytes <= 256 * 1024;

    res.json({
      url: `/api/gif/output/${sessionId}/${outputId}.gif`,
      filename: `${outputId}.gif`,
      sizeBytes,
      sizeKb,
      discordOk,
      newSpeed: clampedSpeed,
    });
  } catch (err: any) {
    console.error('[gif] speed error:', err);
    res.status(500).json({ error: err.message || 'Speed change failed' });
  }
});

/**
 * List available fonts
 * GET /api/gif/fonts
 */
router.get('/gif/fonts', async (_req, res) => {
  try {
    const proc = spawn('fc-list', [':', 'family']);
    let output = '';
    proc.stdout.on('data', d => output += d.toString());
    await new Promise<void>((resolve) => proc.on('close', resolve));

    // fc-list prints every alias a face answers to on one comma-separated line
    // ("Bebas Neue,Bebas Neue Bold"). Only the first is a family drawtext can
    // match, so listing the raw line offers names that render nothing.
    const fontSet = new Set<string>();
    output.split('\n').forEach(line => {
      const family = line.split(',')[0].trim();
      if (family) fontSet.add(family);
    });
    const fonts = Array.from(fontSet).sort((a, b) => a.localeCompare(b));

    res.json({ fonts: fonts.length ? fonts : FALLBACK_FONTS });
  } catch {
    res.json({ fonts: FALLBACK_FONTS });
  }
});

const FALLBACK_FONTS = ['DejaVu Sans', 'DejaVu Sans Mono', 'DejaVu Serif'];

/**
 * Serve one installed font file so the picker can draw each name in its own
 * typeface. The fonts live on the server; without this the list is only names
 * typed in the app's own font, which shows nothing about what you're choosing.
 *
 * GET /api/gif/font-file/:family
 */
router.get('/gif/font-file/:family', async (req, res) => {
  const family = req.params.family;
  if (!family || family.length > 80 || /[:;'"\n\\]/.test(family)) {
    res.status(400).json({ error: 'Invalid family' });
    return;
  }

  try {
    const proc = spawn('fc-match', ['-f', '%{family}\t%{file}', `${family}:style=Regular`]);
    let out = '';
    proc.stdout.on('data', d => out += d.toString());
    await new Promise<void>((resolve) => proc.on('close', resolve));

    const [matchedFamilies, file] = out.split('\t');
    // fc-match always answers with something, so an unknown name comes back as
    // the system default. Serving that would draw the picker a lie.
    const matched = (matchedFamilies || '').split(',').map(f => f.trim());
    if (!file || !matched.includes(family)) {
      res.status(404).json({ error: 'Font not found' });
      return;
    }

    const path = file.trim();
    if (!/^\/(usr\/share\/|usr\/local\/share\/|home\/[^/]+\/\.(local\/share\/)?)fonts\//.test(path)
      || !/\.(ttf|otf|ttc)$/i.test(path)
      || !existsSync(path)) {
      res.status(404).json({ error: 'Font not readable' });
      return;
    }

    res.setHeader('Content-Type', path.toLowerCase().endsWith('.otf') ? 'font/otf' : 'font/ttf');
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.sendFile(path);
  } catch (err: any) {
    console.error('[gif] font-file error:', err);
    res.status(500).json({ error: 'Font lookup failed' });
  }
});

/**
 * Add text overlay to GIF
 * POST /api/gif/add-text/:sessionId/:filename
 * Body: { text: string, x?: number, y?: number, fontSize?: number, fontColor?: string, borderColor?: string, fontFamily?: string, position?: string }
 */
router.post('/gif/add-text/:sessionId/:filename', async (req, res) => {
  const { sessionId, filename } = req.params;
  const {
    text,
    x,
    y,
    fontSize = 24,
    fontColor = 'white',
    borderColor = 'black',
    fontFamily = 'DejaVu Sans',
    position = 'bottom', // top, center, bottom
    anchor // { x, y } as fractions of the frame — a hand-placed position
  } = req.body;

  if (!text) {
    res.status(400).json({ error: 'text required' });
    return;
  }

  if (sessionId.includes('..') || filename.includes('..')) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  const dir = sessionDirOf(sessionId);
  if (!dir || unsafeName(filename)) { res.status(400).json({ error: 'That is not a valid name.' }); return; }
  const gifPath = join(dir, filename);
  if (!existsSync(gifPath)) {
    res.status(404).json({ error: 'GIF not found' });
    return;
  }

  try {
    const outputId = randomUUID();
    const outputPath = join(dir, `${outputId}.gif`);

    const { posX, posY } = textPositionExprs({ position, anchor, x, y });

    // Escape text for ffmpeg (single quotes and backslashes)
    const escapedText = text.replace(/\\/g, '\\\\').replace(/'/g, "'\\''").replace(/:/g, '\\:');
    const escapedFont = fontFamily.replace(/:/g, '\\:');

    const drawTextFilter = `drawtext=text='${escapedText}':font='${escapedFont}':fontsize=${fontSize}:fontcolor=${fontColor}:${posX}:${posY}:borderw=2:bordercolor=${borderColor}`;

    await new Promise<void>((resolve, reject) => {
      const args = drawTextArgs(gifPath, drawTextFilter, outputPath);
      const proc = spawn('ffmpeg', args);
      let stderr = '';
      proc.stderr.on('data', d => stderr += d.toString());
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg text overlay failed: ${stderr.slice(-500)}`));
      });
      proc.on('error', reject);
    });

    const stats = statSync(outputPath);
    const sizeBytes = stats.size;
    const sizeKb = Math.round(sizeBytes / 1024);
    const discordOk = sizeBytes <= 256 * 1024;

    res.json({
      url: `/api/gif/output/${sessionId}/${outputId}.gif`,
      filename: `${outputId}.gif`,
      sizeBytes,
      sizeKb,
      discordOk,
    });
  } catch (err: any) {
    console.error('[gif] add-text error:', err);
    res.status(500).json({ error: err.message || 'Text overlay failed' });
  }
});

/**
 * Get output GIF
 */
router.get('/gif/output/:sessionId/:filename', (req, res) => {
  const { sessionId, filename } = req.params;
  if (sessionId.includes('..') || filename.includes('..')) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }
  const dir = sessionDirOf(sessionId);
  if (!dir || unsafeName(filename)) { res.status(400).json({ error: 'That is not a valid name.' }); return; }
  const gifPath = join(dir, filename);
  if (!existsSync(gifPath)) {
    res.status(404).json({ error: 'GIF not found' });
    return;
  }
  const byExt: Record<string, string> = {
    '.gif': 'image/gif', '.png': 'image/png', '.webp': 'image/webp', '.apng': 'image/apng',
  };
  res.setHeader('Content-Type', byExt[extname(filename).toLowerCase()] || 'application/octet-stream');
  // ?download=1 asks for a save rather than a view. Android's WebView ignores
  // a link's download attribute, so this header is the only thing that turns
  // a tap on the export pill into an actual file inside the app.
  if (req.query?.download) {
    res.setHeader('Content-Disposition', `attachment; filename="${attachmentFilename(basename(filename))}"`);
  }
  res.sendFile(gifPath);
});

/**
 * Delete a session and its files
 */
router.delete('/gif/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  if (sessionId.includes('..')) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }
  const sessionDir = sessionDirOf(sessionId);
  if (!sessionDir) { res.status(400).json({ error: 'That is not a valid session.' }); return; }
  if (existsSync(sessionDir)) {
    try {
      for (const f of readdirSync(sessionDir)) {
        unlinkSync(join(sessionDir, f));
      }
      require('fs').rmdirSync(sessionDir);
    } catch {}
  }
  res.json({ ok: true });
});

export default router;
