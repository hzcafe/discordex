/** Only an explicit Discord 404 identifies deletion; access/network failures do not. */
export function discordNotFound(error: unknown, code: number): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
    && 'status' in error && error.status === 404;
}

/** Payload rejections require a changed message; network/access failures remain retryable. */
export function invalidDelivery(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (
    ('status' in error && error.status === 413)
    || ('code' in error && [50006, 50035, 40005, 50045, 50146].includes(Number(error.code))));
}

/** Known temporary upload failures can deliver text now and retry files separately. */
export function temporaryUploadFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('status' in error && (error.status === 429 || Number(error.status) >= 500)) return true;
  if ('code' in error && ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET'].includes(String(error.code))) return true;
  return 'name' in error && ['AbortError', 'TimeoutError'].includes(String(error.name));
}

export class MissingThreadError extends Error {
  constructor(readonly channelId: string) { super(`Discord thread ${channelId} was deleted`); }
}

export class MissingMessageError extends Error {
  constructor(readonly channelId: string, readonly messageId: string) { super(`Discord message ${messageId} was deleted`); }
}
