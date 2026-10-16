import { expect, test } from '@playwright/test';
import WebSocket from 'ws';

/**
 * WebSocket.
 *
 * How the connection starts: a normal HTTP request with `Upgrade: websocket`
 * and `Connection: Upgrade` plus a `Sec-WebSocket-Key`. The server answers
 * `101 Switching Protocols`, and from then on the TCP connection carries
 * WebSocket frames, not HTTP. So a 101 - not a 200 - is the success status.
 *
 * Because it is a persistent bidirectional channel, the interesting test cases
 * are not "does the payload match" but the lifecycle ones:
 *   - does a message published elsewhere reach this subscriber
 *   - is ordering preserved
 *   - what happens on reconnect (lost? replayed? duplicated?)
 *   - does the server close with a sensible close code
 *
 * ---------------------------------------------------------------------------
 * THE RACE THAT COST THREE ITERATIONS OF THIS FILE
 *
 * This server pushes a greeting the moment the connection is established.
 * `await open(url)` resolves on the `open` event, so ANY listener attached
 * after that await can miss a frame that was already delivered. The window is
 * sub-millisecond, which is why the affected test passed in isolation and
 * failed roughly a third of the time under parallel load.
 *
 * The fix is structural, not a longer timeout: every socket here is opened with
 * `openBuffered`, which attaches the collector synchronously at construction,
 * before the handshake can complete. Nothing can be missed, and assertions poll
 * the buffer instead of awaiting "the next message".
 *
 * Generalised: when the peer pushes without being asked, "connect then
 * subscribe" is still too late. And in pub/sub, never assert on "the next
 * message" - assert on "a message matching my filter", with a unique topic per
 * test so parallel tests cannot observe each other.
 * ---------------------------------------------------------------------------
 */

const WS_URL = 'ws://127.0.0.1:8137/ws';

interface Frame {
    topic: string;
    payload: unknown;
    seq: number;
}

interface BufferedSocket {
    socket: WebSocket;
    frames: Frame[];
}

/** Open a socket, buffering every frame from the moment of construction. */
function openBuffered(url: string, timeoutMs = 8_000): Promise<BufferedSocket> {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(url);
        const frames: Frame[] = [];

        socket.on('message', (data) => {
            try {
                frames.push(JSON.parse(data.toString()) as Frame);
            } catch {
                /* ignore non-JSON frames */
            }
        });

        const timer = setTimeout(() => {
            socket.terminate();
            reject(new Error(`WS did not open within ${timeoutMs}ms`));
        }, timeoutMs);
        socket.once('open', () => {
            clearTimeout(timer);
            resolve({ socket, frames });
        });
        socket.once('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

/** Poll the buffer until a frame matching the predicate exists. */
async function waitForFrame(
    frames: Frame[],
    match: (frame: Frame) => boolean,
    timeoutMs = 8_000,
): Promise<Frame> {
    await expect(async () => {
        expect(frames.some(match)).toBe(true);
    }).toPass({ timeout: timeoutMs });

    const frame = frames.find(match);
    if (!frame) throw new Error('frame vanished from the buffer');
    return frame;
}

/** Unique topic per test, so parallel tests cannot observe each other. */
function uniqueTopic(name: string): string {
    return `${name}.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
}

test.describe('WebSocket /ws', () => {
    test('completes the upgrade handshake and greets the client', async () => {
        const { socket, frames } = await openBuffered(WS_URL);
        try {
            expect(socket.readyState).toBe(WebSocket.OPEN);
            const greeting = await waitForFrame(frames, (f) => f.topic === 'system');
            expect(greeting.payload).toBe('connected');
        } finally {
            socket.close();
        }
    });

    test('echoes a client message back - proves the channel is bidirectional', async () => {
        const { socket, frames } = await openBuffered(WS_URL);
        try {
            // Unique marker: the `echo` topic is shared with other tests.
            const marker = uniqueTopic('echo-probe');
            socket.send(marker);

            const echoed = await waitForFrame(
                frames,
                (f) => f.topic === 'echo' && f.payload === marker,
            );
            expect(echoed.payload).toBe(marker);
        } finally {
            socket.close();
        }
    });

    test('receives a message published over HTTP by another producer', async ({ request }) => {
        const { socket, frames } = await openBuffered(WS_URL);
        const topic = uniqueTopic('kitchen.display');
        try {
            // Connected and buffering, so the publish cannot outrun the listener.
            await request.post('/publish', {
                data: { topic, payload: { orderId: 42, state: 'ready' } },
            });

            const message = await waitForFrame(frames, (f) => f.topic === topic);
            expect(message.payload).toMatchObject({ orderId: 42, state: 'ready' });
        } finally {
            socket.close();
        }
    });

    test('preserves message order across a burst', async ({ request }) => {
        const { socket, frames } = await openBuffered(WS_URL);
        const topic = uniqueTopic('burst');
        try {
            for (let n = 1; n <= 5; n++) {
                await request.post('/publish', { data: { topic, payload: { n } } });
            }

            await expect(async () => {
                expect(frames.filter((f) => f.topic === topic)).toHaveLength(5);
            }).toPass({ timeout: 8_000 });

            const order = frames
                .filter((f) => f.topic === topic)
                .map((f) => (f.payload as { n: number }).n);
            expect(order).toEqual([1, 2, 3, 4, 5]);
        } finally {
            socket.close();
        }
    });

    test('a reconnecting client does not receive messages sent while it was away', async ({
        request,
    }) => {
        /**
         * Documents at-most-once delivery: a plain WebSocket topic has no replay
         * buffer. Contrast with the MQTT persistent-session test, where the
         * broker DOES queue while the client is offline. Knowing which
         * guarantee your system needs - and testing for it - is the point.
         */
        const topic = uniqueTopic('missed');

        const first = await openBuffered(WS_URL);
        await waitForFrame(first.frames, (f) => f.topic === 'system');
        first.socket.close();
        await new Promise((r) => setTimeout(r, 200));

        await request.post('/publish', { data: { topic, payload: 'while offline' } });

        const { socket: second, frames } = await openBuffered(WS_URL);
        try {
            // Wait for proof of life first, so the negative cannot pass vacuously.
            await waitForFrame(frames, (f) => f.topic === 'system');
            await new Promise((r) => setTimeout(r, 1_000));

            // The gap message must never appear.
            expect(frames.map((f) => f.topic)).not.toContain(topic);
        } finally {
            second.close();
        }
    });

    test('closes with a normal closure code', async () => {
        const { socket } = await openBuffered(WS_URL);
        const closed = new Promise<number>((resolve) => socket.once('close', resolve));
        socket.close(1000, 'test finished');

        // 1000 = normal closure. 1006 ("abnormal closure") is what you see when
        // the socket dropped without a close frame - a proxy timeout, a crash,
        // or a missed keep-alive. Asserting the code, not just "it closed",
        // is how you catch that.
        expect(await closed).toBe(1000);
    });
});
