import { get } from 'node:http';

/**
 * Minimal Node-side SSE consumer.
 *
 * Playwright's APIRequestContext buffers the whole response body, which never
 * completes for a stream, so protocol-level SSE assertions need a raw client.
 * Parsing the wire format by hand is also the clearest way to show you know it.
 */

export interface SseEvent {
    id?: string;
    event?: string;
    data: string;
}

export interface CollectOptions {
    /** Resolve as soon as this many events have arrived. */
    expected: number;
    timeoutMs: number;
}

/** Parse one SSE block ("id: 1\nevent: x\ndata: y") into an event. */
function parseBlock(block: string): SseEvent | null {
    const event: Partial<SseEvent> & { data?: string } = {};
    const dataLines: string[] = [];

    for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue; // comment / keep-alive
        const separator = line.indexOf(':');
        const field = separator === -1 ? line : line.slice(0, separator);
        // A single leading space after the colon is stripped, per the spec.
        const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '');

        if (field === 'id') event.id = value;
        else if (field === 'event') event.event = value;
        else if (field === 'data') dataLines.push(value);
    }

    if (dataLines.length === 0) return null; // `retry:`-only block
    return { id: event.id, event: event.event, data: dataLines.join('\n') };
}

export function collectSseEvents(url: string, options: CollectOptions): Promise<SseEvent[]> {
    const { expected, timeoutMs } = options;

    return new Promise((resolve, reject) => {
        const events: SseEvent[] = [];
        let buffer = '';

        const req = get(url, { headers: { Accept: 'text/event-stream' } }, (res) => {
            if (res.statusCode !== 200) {
                req.destroy();
                reject(new Error(`SSE stream returned ${res.statusCode}`));
                return;
            }

            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
                buffer += chunk;

                // Events are separated by a blank line.
                let boundary = buffer.indexOf('\n\n');
                while (boundary !== -1) {
                    const block = buffer.slice(0, boundary);
                    buffer = buffer.slice(boundary + 2);

                    const parsed = parseBlock(block);
                    if (parsed) events.push(parsed);

                    if (events.length >= expected) {
                        clearTimeout(timer);
                        req.destroy();
                        resolve(events);
                        return;
                    }
                    boundary = buffer.indexOf('\n\n');
                }
            });
        });

        const timer = setTimeout(() => {
            req.destroy();
            reject(
                new Error(
                    `timed out after ${timeoutMs}ms with ${events.length}/${expected} SSE events`,
                ),
            );
        }, timeoutMs);

        req.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

/**
 * Read the response headers of a stream WITHOUT consuming its body.
 *
 * Playwright's `APIRequestContext` buffers the entire response before
 * resolving, so `request.get('/events')` never settles against an endpoint that
 * stays open by design — the symptom is a timeout that looks like the server is
 * down.
 *
 * A raw request can capture the headers and hang up immediately, which is all
 * the header assertions need.
 */
export function fetchStreamHeaders(
    url: string,
    timeoutMs = 10_000,
): Promise<Record<string, string | string[] | undefined>> {
    return new Promise((resolve, reject) => {
        const req = get(url, { headers: { Accept: 'text/event-stream' } }, (res) => {
            const headers = { ...res.headers };
            req.destroy(); // Headers received; the body is not needed.
            clearTimeout(timer);
            resolve(headers);
        });

        const timer = setTimeout(() => {
            req.destroy();
            reject(new Error(`no response headers within ${timeoutMs}ms`));
        }, timeoutMs);

        req.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}
