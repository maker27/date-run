import { RoomPreviewSchema, type RoomPreview } from '../../shared/model.js';
import type { appUrls } from '../platform/app-urls.js';

export type RoomApiErrorCode = 'room_not_found' | 'rate_limited' | 'network_error' | 'invalid_response' | 'timeout' | 'aborted';

export class RoomApiError extends Error {
  constructor(readonly code: RoomApiErrorCode) {
    super(code);
    this.name = 'RoomApiError';
  }
}

export class RoomApi {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly urls: ReturnType<typeof appUrls>, options: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
    this.fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  preview(code: string, signal?: AbortSignal): Promise<RoomPreview> {
    let url: string;
    try {
      url = this.urls.preview(code);
    } catch {
      return Promise.reject(new RoomApiError('invalid_response'));
    }
    if (signal?.aborted) return Promise.reject(new RoomApiError('aborted'));
    return new Promise<RoomPreview>((resolve, reject) => {
      const controller = new AbortController();
      let settled = false;
      const finish = (result: RoomPreview | RoomApiError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (result instanceof RoomApiError) reject(result);
        else resolve(result);
      };
      const onAbort = () => {
        finish(new RoomApiError('aborted'));
        controller.abort();
      };
      const timer = setTimeout(() => {
        finish(new RoomApiError('timeout'));
        controller.abort();
      }, this.timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      const operation = async (): Promise<RoomPreview> => {
        const response = await this.fetcher(url, { method: 'GET', signal: controller.signal });
        if (response.status === 404) throw new RoomApiError('room_not_found');
        if (response.status === 429) throw new RoomApiError('rate_limited');
        if (!response.ok) throw new RoomApiError('network_error');
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          throw new RoomApiError('invalid_response');
        }
        const result = RoomPreviewSchema.safeParse(body);
        if (!result.success) throw new RoomApiError('invalid_response');
        return result.data;
      };
      void operation().then(
        (preview) => finish(preview),
        (error: unknown) => finish(error instanceof RoomApiError ? error : new RoomApiError('network_error')),
      );
    });
  }
}
