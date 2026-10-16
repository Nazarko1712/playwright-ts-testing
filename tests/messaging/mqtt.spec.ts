import { expect, test } from '@playwright/test';
import mqtt, { type MqttClient } from 'mqtt';
import { startBroker, type StoppableBroker } from '../../src/mqtt-broker';

/**
 * MQTT.
 *
 * A publish/subscribe protocol over TCP, designed for unreliable networks and
 * constrained devices. In a restaurant-ordering platform this is the transport
 * for kitchen displays, drive-thru screens and delivery trackers.
 *
 * Core concepts an interviewer will ask about:
 *
 *  BROKER        Every message goes through it. Publishers and subscribers never
 *                know each other - that decoupling is the whole point.
 *
 *  TOPIC         A hierarchical string: `store/123/orders/ready`. Wildcards:
 *                `+` matches exactly one level (`store/+/orders/ready`),
 *                `#` matches the rest (`store/123/#`). `#` must be last.
 *
 *  QoS 0  at most once  - fire and forget. May be lost. No ack.
 *      1  at least once - acked (PUBACK), so DUPLICATES ARE POSSIBLE.
 *                         Your consumer must be idempotent.
 *      2  exactly once  - four-step handshake. Slowest, rarely needed.
 *      The QoS of delivery is min(publisher QoS, subscriber QoS).
 *
 *  RETAINED      The broker stores the last retained message per topic and
 *                delivers it immediately to any new subscriber. This is how a
 *                display that just booted learns the current state instead of
 *                waiting for the next change.
 *
 *  CLEAN SESSION / persistent session: with `clean: false` plus a stable
 *                clientId the broker queues QoS 1/2 messages while the client
 *                is offline and delivers them on reconnect.
 *
 *  LAST WILL     A message the broker publishes on the client's behalf if it
 *                disconnects ungracefully - how you detect a dead device.
 *
 * The tests run against a broker started in-process, so they are hermetic.
 */

/**
 * Isolation, learned the hard way while writing these tests.
 *
 * With `fullyParallel: true` Playwright spreads the tests of one file across
 * workers, and `beforeAll` runs once PER WORKER. A hard-coded port therefore
 * makes every worker but the first fail with EADDRINUSE. Deriving the port from
 * `workerIndex` gives each worker its own broker - the tests stay parallel and
 * fully isolated, which is better than forcing the file to run serially.
 *
 * The same class of bug bites shared brokers in real projects: two parallel
 * tests publishing to the same topic see each other's messages. The fix there
 * is the same idea - make the topic unique per test.
 */
const BASE_PORT = 18833;

let broker: StoppableBroker;
let brokerUrl: string;

test.beforeAll(async ({}, testInfo) => {
    broker = await startBroker(BASE_PORT + testInfo.workerIndex);
    brokerUrl = `mqtt://127.0.0.1:${broker.port}`;
});

test.afterAll(async () => {
    await broker.stop();
});

function connect(options: mqtt.IClientOptions = {}): Promise<MqttClient> {
    return new Promise((resolve, reject) => {
        const client = mqtt.connect(brokerUrl, { connectTimeout: 5_000, ...options });
        client.once('connect', () => resolve(client));
        client.once('error', reject);
    });
}

interface BufferedClient {
    client: MqttClient;
    messages: Array<{ topic: string; payload: string }>;
}

/**
 * Connect while buffering every inbound message from the moment the client is
 * created.
 *
 * Needed for the persistent-session test, and for the same reason the
 * WebSocket greeting test needed it: on reconnect with `clean: false` the
 * broker flushes the queued messages immediately after CONNACK, but
 * `connect()` resolves on the `connect` event - so a `client.once('message')`
 * attached after the await can miss a message that was already delivered.
 *
 * Two different transports, one identical race. Whenever the peer pushes
 * without being asked, the listener must exist before the handshake finishes.
 */
function connectBuffered(options: mqtt.IClientOptions = {}): Promise<BufferedClient> {
    return new Promise((resolve, reject) => {
        const client = mqtt.connect(brokerUrl, { connectTimeout: 5_000, ...options });
        const messages: Array<{ topic: string; payload: string }> = [];

        // Attached synchronously, before CONNACK can be processed.
        client.on('message', (topic, payload) => {
            messages.push({ topic, payload: payload.toString() });
        });

        client.once('connect', () => resolve({ client, messages }));
        client.once('error', reject);
    });
}

function subscribe(client: MqttClient, topic: string, qos: 0 | 1 | 2 = 0): Promise<void> {
    return new Promise((resolve, reject) => {
        client.subscribe(topic, { qos }, (err) => (err ? reject(err) : resolve()));
    });
}

/** Await the next message matching a topic filter, with a timeout. */
function nextMessage(
    client: MqttClient,
    timeoutMs = 8_000,
): Promise<{ topic: string; payload: string }> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`no MQTT message within ${timeoutMs}ms`)),
            timeoutMs,
        );
        client.once('message', (topic, payload) => {
            clearTimeout(timer);
            resolve({ topic, payload: payload.toString() });
        });
    });
}

test.describe('MQTT', () => {
    test('a subscriber receives a message published by another client', async () => {
        const subscriber = await connect();
        const publisher = await connect();
        try {
            // Subscribe BEFORE publishing - same rule as SSE and WebSocket.
            await subscribe(subscriber, 'store/123/orders/ready');
            const pending = nextMessage(subscriber);

            publisher.publish('store/123/orders/ready', JSON.stringify({ orderId: 7, table: 4 }));

            const message = await pending;
            expect(message.topic).toBe('store/123/orders/ready');
            expect(JSON.parse(message.payload)).toMatchObject({ orderId: 7, table: 4 });
        } finally {
            await subscriber.endAsync();
            await publisher.endAsync();
        }
    });

    test('the + wildcard matches exactly one topic level', async () => {
        const subscriber = await connect();
        const publisher = await connect();
        try {
            await subscribe(subscriber, 'store/+/orders/ready');
            const pending = nextMessage(subscriber);

            publisher.publish('store/999/orders/ready', 'matched');

            const message = await pending;
            expect(message.topic).toBe('store/999/orders/ready');
            expect(message.payload).toBe('matched');
        } finally {
            await subscriber.endAsync();
            await publisher.endAsync();
        }
    });

    test('the # wildcard matches every remaining level', async () => {
        const subscriber = await connect();
        const publisher = await connect();
        try {
            await subscribe(subscriber, 'store/123/#');
            const pending = nextMessage(subscriber);

            publisher.publish('store/123/kitchen/display/1', 'deep topic');

            expect((await pending).payload).toBe('deep topic');
        } finally {
            await subscriber.endAsync();
            await publisher.endAsync();
        }
    });

    test('a subscriber does NOT receive messages from a non-matching topic', async () => {
        const subscriber = await connect();
        const publisher = await connect();
        try {
            await subscribe(subscriber, 'store/123/orders/ready');

            const received: string[] = [];
            subscriber.on('message', (_topic, payload) => received.push(payload.toString()));

            publisher.publish('store/456/orders/ready', 'other store');
            publisher.publish('store/123/orders/cancelled', 'other topic');
            await new Promise((r) => setTimeout(r, 800));

            // The negative case is what proves the topic filter actually filters.
            expect(received).toHaveLength(0);
        } finally {
            await subscriber.endAsync();
            await publisher.endAsync();
        }
    });

    test('a retained message reaches a subscriber that connects afterwards', async () => {
        const publisher = await connect();
        publisher.publish('store/123/status', 'open', { retain: true, qos: 1 });
        await new Promise((r) => setTimeout(r, 300));
        await publisher.endAsync();

        // Brand-new subscriber, message already published and the publisher gone.
        const latecomer = await connect();
        try {
            const pending = nextMessage(latecomer);
            await subscribe(latecomer, 'store/123/status');

            const message = await pending;
            expect(message.payload).toBe('open');
        } finally {
            // Clear the retained value so the test is re-runnable.
            const cleaner = await connect();
            cleaner.publish('store/123/status', '', { retain: true });
            await new Promise((r) => setTimeout(r, 200));
            await cleaner.endAsync();
            await latecomer.endAsync();
        }
    });

    test('QoS 1 delivers the message and acknowledges it', async () => {
        const subscriber = await connect();
        const publisher = await connect();
        try {
            await subscribe(subscriber, 'store/123/qos', 1);
            const pending = nextMessage(subscriber);

            const acked = new Promise<void>((resolve, reject) => {
                publisher.publish('store/123/qos', 'at least once', { qos: 1 }, (err) =>
                    err ? reject(err) : resolve(),
                );
            });

            await acked; // PUBACK received
            expect((await pending).payload).toBe('at least once');
        } finally {
            await subscriber.endAsync();
            await publisher.endAsync();
        }
    });

    test('a persistent session queues messages while the client is offline', async () => {
        const clientId = 'kitchen-display-1';

        /**
         * `protocolVersion: 4` (MQTT 3.1.1) is deliberate, and the reason is a
         * real trap this test walked into:
         *
         *   MQTT 3.1.1 - `clean: false` alone keeps the session, and the broker
         *                queues QoS 1/2 messages for the offline client.
         *   MQTT 5.0   - `clean: false` (cleanStart=false) is NOT enough. The
         *                session lives only as long as `sessionExpiryInterval`,
         *                which defaults to 0, i.e. it is discarded the instant
         *                the client disconnects. You must send
         *                `properties: { sessionExpiryInterval: <seconds> }`.
         *
         * mqtt.js v5 defaults to protocol version 5, so a test written the
         * 3.1.1 way silently receives nothing and times out - which is exactly
         * what happened here before this comment existed.
         */
        const sessionOptions: mqtt.IClientOptions = {
            clientId,
            clean: false,
            protocolVersion: 4,
        };

        // First connection establishes the session and the subscription.
        const first = await connect(sessionOptions);
        await subscribe(first, 'store/123/queued', 1);
        await first.endAsync();

        // Publish while the subscriber is disconnected.
        const publisher = await connect();
        publisher.publish('store/123/queued', 'sent while offline', { qos: 1 });
        await new Promise((r) => setTimeout(r, 400));
        await publisher.endAsync();

        // Reconnecting with the same clientId and clean:false drains the queue.
        // Buffered, because the flush happens right after CONNACK.
        const { client: resumed, messages } = await connectBuffered(sessionOptions);
        try {
            await expect(() => {
                expect(messages.map((m) => m.payload)).toContain('sent while offline');
            }).toPass({ timeout: 6_000 });

            const queued = messages.find((m) => m.payload === 'sent while offline');
            expect(queued?.topic).toBe('store/123/queued');
        } finally {
            await resumed.endAsync();
        }
    });
});
