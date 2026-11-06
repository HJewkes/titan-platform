/** The global `fetch`, resolved at each call; recipe files may not name the global themselves. */
export const ambientFetch: typeof fetch = (input, init) => fetch(input, init);
