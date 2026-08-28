// The paint surface, lifted out of Cutout so both tabs share one.
//
// It was only ever in Cutout because that is where it was first needed. GIF Lab
// wants the same thing per frame, and two copies of stroke maths that must agree
// is the bug rather than the plan: the mask has to land on the same pixels the
// overlay drew on, or the correction lands somewhere she did not paint.
//
// The strokes are kept as DATA, in the image's own pixel space, never baked into
// a canvas. That is what makes undo a slice and makes the surface indifferent to
// zoom, pan and element size — everything is mapped through the image's rendered
// box at the moment it is needed.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

export interface Stroke {
  tool: 'restore' | 'erase';
  /** Brush width in the image's own pixels, so replay is resolution-independent. */
  width: number;
  points: Array<{ x: number; y: number }>;
}

/** Diameter of the magnifier that follows the brush, in screen pixels. */
export const LOUPE = 104;

export interface Loupe {
  x: number;
  y: number;
  scale: number;
  side: 'left' | 'right';
}

interface Options {
  /** The picture being painted on. Strokes are mapped through its rendered box. */
  imageRef: React.RefObject<HTMLImageElement | null>;
  /** The box the magnifier is pinned inside. Defaults to the image's own box. */
  viewportRef?: React.RefObject<HTMLElement | null>;
  /** Divides the magnifier's scale, so it stays 3x the UNZOOMED view. 1 if the
   *  host has no zoom of its own. */
  zoom?: number;
}

export function usePaint({ imageRef, viewportRef, zoom = 1 }: Options) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokeRef = useRef<Stroke | null>(null);

  const [painting, setPainting] = useState(false);
  const [tool, setTool] = useState<'restore' | 'erase'>('restore');
  const [brush, setBrush] = useState(28);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [loupe, setLoupe] = useState<Loupe | null>(null);

  /** Map a pointer event to the image's own pixel space, accounting for the
   *  letterboxing object-contain introduces. */
  const toImagePoint = useCallback((clientX: number, clientY: number) => {
    const img = imageRef.current;
    if (!img || !img.naturalWidth) return null;
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
  }, [imageRef]);

  /** Redraw the overlay. Restores read green, erases read red, both translucent
   *  so the picture underneath stays visible while she works. */
  const drawStrokes = useCallback((list: Stroke[]) => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img || !img.naturalWidth) return;
    const rect = img.getBoundingClientRect();
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
      if (stroke.points.length === 1) ctx.lineTo(stroke.points[0].x * scale + offsetX + 0.1, stroke.points[0].y * scale + offsetY);
      ctx.stroke();
    }
  }, [imageRef]);

  /** Mirror the point under the finger into the loupe, in the corner away from it —
   *  a finger covers the exact thing it is painting. */
  const updateLoupe = useCallback((clientX: number, clientY: number) => {
    const point = toImagePoint(clientX, clientY);
    const box = (viewportRef?.current ?? imageRef.current)?.getBoundingClientRect();
    if (!point || !box || !point.scale) return;
    setLoupe({
      x: point.x,
      y: point.y,
      scale: (point.scale / zoom) * 3,
      side: clientX - box.left < box.width / 2 ? 'right' : 'left',
    });
  }, [toImagePoint, viewportRef, imageRef, zoom]);

  const startStroke = useCallback((e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!painting) return;
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

  // THE OVERLAY HAS TO REDRAW ITSELF, and it belongs here rather than in each
  // host. Without it the strokes are recorded and applied perfectly and NOTHING
  // APPEARS while you draw — you find out where the brush went only after you
  // press apply, which is painting blind. A host can add its own triggers on top
  // (a zoom, a pan, a new picture); it must not have to remember this one.
  useEffect(() => { drawStrokes(strokes); }, [strokes, drawStrokes, painting]);

  const undo = useCallback(() => { setStrokes((prev) => prev.slice(0, -1)); }, []);
  const clear = useCallback(() => { strokeRef.current = null; setStrokes([]); setLoupe(null); }, []);

  /** Rasterise one tool's strokes to a white-on-transparent PNG at the image's
   *  OWN size — which is what the server expects, and why the strokes are stored
   *  in image pixels rather than screen ones. */
  const mask = useCallback((which: 'restore' | 'erase'): Promise<Blob | null> => {
    const img = imageRef.current;
    const mine = strokes.filter((stroke) => stroke.tool === which);
    if (!img || !img.naturalWidth || mine.length === 0) return Promise.resolve(null);

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
  }, [strokes, imageRef]);

  /** Both layers at once, ready for the multipart body. */
  const masks = useCallback(async () => {
    const [restore, erase] = await Promise.all([mask('restore'), mask('erase')]);
    return { restore, erase };
  }, [mask]);

  return {
    canvasRef, painting, setPainting, tool, setTool, brush, setBrush,
    strokes, loupe, drawStrokes, undo, clear, masks,
    /** Spread onto the overlay canvas. */
    canvasProps: {
      ref: canvasRef,
      onPointerDown: startStroke,
      onPointerMove: extendStroke,
      onPointerUp: endStroke,
      onPointerCancel: endStroke,
    },
  };
}
