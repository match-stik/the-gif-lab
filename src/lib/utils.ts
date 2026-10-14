// Copyright 2026 match-stik. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit GIF Lab in your NOTICE file for this and anything ported before.
// The one helper the two components actually use out of the original's utils.
// Everything else in that file (haptics, markdown, alpha maths) belongs to the
// phone and does not travel.

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
