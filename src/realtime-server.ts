/**
 * Minimal real-time server used as a test fixture.
 *
 * It exposes the three Pub/Sub-shaped transports the role asks about, so the
 * tests can assert on them without depending on a third-party service:
 *
 *   GET  /health          -> readiness probe (playwright.config waits on this)
 *   GET  /events          -> Server-Sent Events stream (server -> client only)
 *   POST /publish         -> inject a message into the SSE stream and WS topic
 *   ws://.../ws           -> WebSocket echo + topic broadcast (bidirectional)
 *
 * Why a local server rather than a public echo service: tests stay hermetic and
 * fast, and the setup itself is the answer to "how would you test SSE/WS".
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

const PORT = Number(process.env.REALTIME_PORT ?? 8137);
const HOST = '127.0.0.1';

interface TopicMessage {
    topic: string;
    payload: unknown;
    /** Monotonic id so a client can detect gaps or duplicates. */
    seq: number;
}

const sseClients = new Set<ServerResponse>();
const wsClients = new Set<WebSocket>();
let sequence = 0;

function broadcast(message: TopicMessage): void {
    const frame = JSON.stringify(message);

    // SSE framing: "data: <payload>\n\n". The blank line terminates the event.
    for (const res of sseClients) {
        res.write(`id: ${message.seq}\n`);
        res.write(`event: ${message.topic}\n`);
        res.write(`data: ${frame}\n\n`);
    }

    for (const socket of wsClients) {
        if (socket.readyState === socket.OPEN) socket.send(frame);
    }
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

    if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', sseClients: sseClients.size }));
        return;
    }

    if (url.pathname === '/events') {
        // The three headers that make SSE work. Missing no-cache is a classic bug:
        // a proxy buffers the stream and the client sees nothing until it closes.
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.write('retry: 1000\n\n');
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
    }

    if (url.pathname === '/publish' && req.method === 'POST') {
        const raw = await readBody(req);
        let parsed: { topic?: string; payload?: unknown };
        try {
            parsed = raw ? JSON.parse(raw) : {};
        } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid JSON body' }));
            return;
        }

        const message: TopicMessage = {
            topic: parsed.topic ?? 'default',
            payload: parsed.payload ?? null,
            seq: ++sequence,
        };
        broadcast(message);

        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ accepted: true, seq: message.seq }));
        return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket) => {
    wsClients.add(socket);
    socket.send(JSON.stringify({ topic: 'system', payload: 'connected', seq: 0 }));

    socket.on('message', (data) => {
        // Echo back with a marker so a test can prove the round trip.
        socket.send(JSON.stringify({ topic: 'echo', payload: data.toString(), seq: ++sequence }));
    });

    socket.on('close', () => wsClients.delete(socket));
});

server.listen(PORT, HOST, () => {
    process.stdout.write(`realtime server listening on http://${HOST}:${PORT}\n`);
});

// Without this the webServer teardown can leave the port bound between runs.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        wss.close();
        server.close(() => process.exit(0));
    });
}
