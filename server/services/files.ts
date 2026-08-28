// Copied out of the original app's file service. The route imports one function from it and
// this is that function, unchanged — a filename sanitiser for the Content-
// Disposition header.

export function attachmentFilename(name: string): string {
  const cleaned = name.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, ' ').trim();
  return cleaned || 'download';
}
