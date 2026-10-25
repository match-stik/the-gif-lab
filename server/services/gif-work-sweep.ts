// Copyright 2026 match-stik. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit GIF Lab in your NOTICE file for this and anything ported before.
/**
 * The GIF Lab's working folders, swept by age.
 *
 * Every extract makes a session folder of frames, and the only thing that ever
 * removed one was Start Fresh. Close the page, or just upload the next thing,
 * and the frames stayed on the machine for good, gigabytes of them over a few
 * months, while this README said working files are cleared out as sessions age.
 * This is the half that makes that sentence true.
 *
 * Age is read from the newest file anywhere in the folder, not the folder's own
 * stamp, because painting a frame or cropping writes files inside it without
 * touching the folder itself. A session somebody is still working in is never
 * old, however long ago it was first made.
 */

import { readdirSync, statSync, rmSync } from 'fs';
import { join } from 'path';

/** A week untouched, and a session counts as abandoned. */
export const GIF_WORK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The newest modification time at or under a path, a few levels deep. */
export function newestMtime(path: string, depth = 4): number {
  const st = statSync(path);
  let newest = st.mtimeMs;
  if (!st.isDirectory() || depth <= 0) return newest;
  for (const name of readdirSync(path)) {
    try {
      newest = Math.max(newest, newestMtime(join(path, name), depth - 1));
    } catch {
      // A file removed mid-walk is simply not counted.
    }
  }
  return newest;
}

/**
 * Remove every session folder (and every leftover upload) nobody has touched for
 * maxAgeMs. The uploads folder itself always stays: multer writes into it and
 * does not create it. Returns what was removed, relative to dir.
 */
export function sweepGifWork(dir: string, maxAgeMs = GIF_WORK_MAX_AGE_MS, now = Date.now()): string[] {
  const removed: string[] = [];
  const cutoff = now - maxAgeMs;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    const path = join(dir, name);
    try {
      if (name === 'uploads') {
        for (const upload of readdirSync(path)) {
          const uploadPath = join(path, upload);
          if (newestMtime(uploadPath) < cutoff) {
            rmSync(uploadPath, { recursive: true, force: true });
            removed.push(join(name, upload));
          }
        }
        continue;
      }
      if (newestMtime(path) < cutoff) {
        rmSync(path, { recursive: true, force: true });
        removed.push(name);
      }
    } catch {
      // One unreadable entry does not stop the rest of the sweep.
    }
  }
  return removed;
}
