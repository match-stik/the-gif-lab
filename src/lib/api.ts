// Copyright 2026 match-stik. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit GIF Lab in your NOTICE file for this and anything ported before.
// Where the original app's authenticated client used to be.
//
// There it attaches a session cookie and a CSRF header, because that API
// sits behind a login. This tool has no login and no cookie: the server it talks
// to is the one you started in your own terminal, on your own machine. So the
// whole thing collapses to fetch, kept at the same signature so the components
// that call it did not have to be touched.

type FetchOptions = RequestInit & {
  /** Accepted and ignored — there is no CSRF token here to skip. */
  skipCsrf?: boolean;
};

export async function apiFetch(url: string, options: FetchOptions = {}): Promise<Response> {
  const { skipCsrf: _skipCsrf, ...fetchOptions } = options;
  return fetch(url, fetchOptions);
}
