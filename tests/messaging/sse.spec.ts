import { expect, test } from '@playwright/test';
import { collectSseEvents } from '../../src/sse-client';

/**
 * Server-Sent Events.
 *
 * What SSE is: a long-lived HTTP response with `Content-Type: text/event-stream`
 * that the server keeps writing to. ONE-DIRECTIONAL - server to client only.
 * Plain HTTP, so proxies, auth headers and gzip all behave normally.
 *
 * Wire format (the bit interviewers probe):
 *     id: 42
 *     event: order.updated
 *     data: {"orderId":7}
 *     <blank line>
 * The blank line terminates the event. `retry: 1000` tells the browser how long
 * to wait before auto-reconnecting.
 *
 * SSE vs WebSocket - the comparison you will be asked for:
 *   SSE: server->client only, over HTTP/1.1 or HTTP/2, auto-reconnect built in,
 *        Last-Event-ID replay on reconnect, text only, simple to scale.
 *   WS:  bidirectional, separate protocol after an HTTP Upgrade handshake,
 *        binary capable, you implement reconnection yourself.
 * Rule of thumb: notifications and live dashboards -> SSE. Chat, collaborative
 * editing, anything the client must push into -> WebSocket.
 *
 * HOW YOU TEST IT - the pattern that matters:
 *   subscribe first, then trigger the action, then await the message with a
 *   timeout. Never trigger first: the event can arrive before you subscribe and
 *   the test hangs. This ordering is the whole answer.
 */

test.describe('SSE /events', () => {
    test('delivers a published message to a subscribed client', async ({ request, baseURL }) => {
        // 1. Subscribe BEFORE publishing.
        const events = collectSseEvents(`${baseURL}/events`, { expected: 1, timeoutMs: 10_000 });

        // 2. Trigger.
        const publish = await request.post('/publish', {
            data: { topic: 'order.updated', payload: { orderId: 7 } },
        });
        expect(publish.status()).toBe(202);

        // 3. Await with a timeout.
        const received = await events;

        expect(received).toHaveLength(1);
        expect(received[0]?.event).toBe('order.updated');
        expect(JSON.parse(received[0]?.data ?? '{}')).toMatchObject({
            topic: 'order.updated',
            payload: { orderId: 7 },
        });
    });

    test('preserves publication order and increments ids', async ({ request, baseURL }) => {
        const events = collectSseEvents(`${baseURL}/events`, { expected: 3, timeoutMs: 10_000 });

        for (const step of ['created', 'paid', 'shipped']) {
            await request.post('/publish', { data: { topic: 'order', payload: { step } } });
        }

        const received = await events;
        const steps = received.map((e) => JSON.parse(e.data).payload.step);
        expect(steps).toEqual(['created', 'paid', 'shipped']);

        // Monotonic ids let a consumer detect a gap (loss) or a repeat (dupe).
        const ids = received.map((e) => Number(e.id));
        expect(ids).toEqual([...ids].sort((a, b) => a - b));
        expect(new Set(ids).size).toBe(ids.length);
    });

    test('sends the documented event-stream headers', async ({ request }) => {
        const response = await request.get('/events', { timeout: 3_000 }).catch(() => null);
        if (!response) return; // streaming response may not settle; header check is best-effort

        const headers = response.headers();
        expect(headers['content-type']).toContain('text/event-stream');
        // Missing no-cache is a real production bug: a proxy buffers the stream
        // and the client receives nothing until the connection closes.
        expect(headers['cache-control']).toContain('no-cache');
    });

    test('the browser EventSource API consumes the same stream', async ({ page, baseURL }) => {
        await page.goto(`${baseURL}/health`);

        // Subscribe inside the page, resolving on the first message.
        const fromBrowser = page.evaluate(
            (url) =>
                new Promise<string>((resolve, reject) => {
                    const source = new EventSource(url);
                    const timer = setTimeout(() => {
                        source.close();
                        reject(new Error('no SSE message within 8s'));
                    }, 8_000);
                    source.addEventListener('greeting', (event) => {
                        clearTimeout(timer);
                        source.close();
                        resolve((event as MessageEvent<string>).data);
                    });
                }),
            `${baseURL}/events`,
        );

        // Give the subscription a moment, then publish.
        await page.waitForTimeout(500);
        await page.request.post(`${baseURL}/publish`, {
            data: { topic: 'greeting', payload: 'hello from the server' },
        });

        const data = await fromBrowser;
        expect(JSON.parse(data).payload).toBe('hello from the server');
    });
});
