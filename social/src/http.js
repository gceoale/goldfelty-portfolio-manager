export class HttpError extends Error {
  constructor(message, { status = 0, body = '', retryable = false } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.retryable = retryable;
  }
}

export function isRetryableStatus(status) {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

// fetch, then read the body as JSON when it is JSON. Network failures become
// a retryable HttpError with status 0.
export async function request(fetchImpl, url, init = {}) {
  let res;
  try {
    res = await fetchImpl(url, init);
  } catch (err) {
    throw new HttpError(`Couldn't reach ${new URL(url).host}: ${err.message}`, { retryable: true });
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, ok: res.ok, headers: res.headers, json, text };
}

export function failure(what, res) {
  const detail =
    res.json?.error_description ||
    res.json?.detail ||
    res.json?.error?.message ||
    res.json?.message ||
    (typeof res.json?.error === 'string' ? res.json.error : '') ||
    res.text.slice(0, 300);
  return new HttpError(`${what} failed (${res.status})${detail ? `: ${detail}` : ''}`, {
    status: res.status,
    body: res.text,
    retryable: isRetryableStatus(res.status),
  });
}
