import { createServer, type Server } from 'node:net';
import Aedes from 'aedes';

/**
 * In-process MQTT broker for the tests.
 *
 * Running the broker inside the test process instead of pointing at a public
 * one (test.mosquitto.org, broker.hivemq.com) keeps the suite hermetic: no
 * network flakiness, no cross-talk with other people publishing to the same
 * topics, and retained-message tests cannot leak state between runs.
 *
 * In a real project this is the same argument for Testcontainers or a
 * docker-compose Mosquitto service in CI.
 */

export interface StoppableBroker {
    port: number;
    stop: () => Promise<void>;
}

export function startBroker(port: number): Promise<StoppableBroker> {
    const aedes = new Aedes();
    const server: Server = createServer(aedes.handle);

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
            resolve({
                port,
                stop: () =>
                    new Promise<void>((done) => {
                        server.close(() => aedes.close(() => done()));
                    }),
            });
        });
    });
}
