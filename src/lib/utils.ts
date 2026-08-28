// The one helper the two components actually use out of the original's utils.
// Everything else in that file (haptics, markdown, alpha maths) belongs to the
// phone and does not travel.

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
