/** What the fake throws where GitHub answers an HTTP error; callers branch on `status`. */
export class FakeHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`HTTP ${status}: ${message}`);
  }
}
