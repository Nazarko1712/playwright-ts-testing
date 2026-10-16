/**
 * Typed JSON helpers.
 *
 * `JSON.parse` returns `any`, which silently disables type checking for
 * everything downstream — `JSON.parse(x).payload.step` compiles no matter what
 * the shape actually is. ESLint's `no-unsafe-member-access` flags exactly that,
 * and the honest fix is to narrow once at the boundary rather than to disable
 * the rule.
 */

/** Parse a JSON string into a known shape, with the cast confined to one place. */
export function parseJson<T>(raw: string): T {
    return JSON.parse(raw) as T;
}

/**
 * Normalise the `ws` library's `RawData` union (Buffer | ArrayBuffer | Buffer[])
 * into a string.
 *
 * `data.toString()` on that union is what triggers `no-base-to-string`: for an
 * `ArrayBuffer` it really does produce `"[object ArrayBuffer]"` rather than the
 * payload, which would be a silent data-corruption bug rather than a style nit.
 */
export function rawDataToString(data: Buffer | ArrayBuffer | Buffer[]): string {
    if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    return Buffer.from(data).toString('utf8');
}
