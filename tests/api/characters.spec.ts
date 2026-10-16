import { expect, test } from '@playwright/test';

/**
 * REST layer, driven by Playwright's `request` fixture.
 *
 * `request` is an APIRequestContext - a real HTTP client with cookie handling
 * and the config's baseURL, but no browser. That is why the `api` project in
 * playwright.config.ts launches nothing: API tests should not pay for a browser.
 *
 * Interview note: this replaces Pactum/axios in a Playwright stack. The mental
 * model is the same - build a request, assert status, assert body shape - so the
 * REST experience transfers directly.
 */

interface Character {
    id: number;
    name: string;
    status: 'Alive' | 'Dead' | 'unknown';
    species: string;
    origin: { name: string; url: string };
    episode: string[];
}

interface Paginated<T> {
    info: { count: number; pages: number; next: string | null; prev: string | null };
    results: T[];
}

test.describe('REST /api/character', () => {
    test('returns a paginated envelope with a stable shape', async ({ request }) => {
        const response = await request.get('/api/character');

        expect(response.status()).toBe(200);
        expect(response.headers()['content-type']).toContain('application/json');

        const body = (await response.json()) as Paginated<Character>;
        expect(body.info.count).toBeGreaterThan(0);
        expect(body.results.length).toBeGreaterThan(0);

        // Assert the contract, not the data: types and required keys.
        const first = body.results[0];
        expect(first).toBeDefined();
        expect(first).toMatchObject({
            id: expect.any(Number),
            name: expect.any(String),
            species: expect.any(String),
        });
        expect(['Alive', 'Dead', 'unknown']).toContain(first?.status);
    });

    test('fetches a single resource by id', async ({ request }) => {
        const response = await request.get('/api/character/1');

        expect(response.ok()).toBeTruthy();
        const character = (await response.json()) as Character;
        expect(character.id).toBe(1);
        expect(character.name).toBe('Rick Sanchez');
        expect(Array.isArray(character.episode)).toBe(true);
    });

    test('a missing resource returns 404 with an error body, not an empty 200', async ({
        request,
    }) => {
        const response = await request.get('/api/character/999999');

        expect(response.status()).toBe(404);
        const body = (await response.json()) as { error: string };
        expect(body.error).toBeTruthy();
    });

    /**
     * KNOWN DEFECT, found by this test: the API answers 500 for a malformed id
     * instead of a 4xx. Malformed client input is a client error; a 500 means
     * an unhandled exception reached the edge, and it also tells an attacker
     * that the input got far enough to break something.
     *
     * `test.fail()` is the honest way to keep this in the suite: the run stays
     * green while the bug exists, and the moment it is fixed Playwright reports
     * "expected to fail but passed" and forces this test to be updated. That is
     * strictly better than deleting the test or weakening the assertion.
     */
    test('an unparseable id is rejected as a client error', async ({ request }) => {
        test.fail(true, 'API returns 500 for a non-numeric id - should be 4xx');

        const response = await request.get('/api/character/not-a-number');

        expect(response.status()).toBeGreaterThanOrEqual(400);
        expect(response.status()).toBeLessThan(500);
    });

    test('filtering narrows the result set and stays self-consistent', async ({ request }) => {
        const response = await request.get('/api/character', {
            params: { status: 'alive', species: 'human' },
        });

        expect(response.ok()).toBeTruthy();
        const body = (await response.json()) as Paginated<Character>;
        expect(body.results.length).toBeGreaterThan(0);

        // Every returned row must honour every filter - catches ignored params.
        //
        // Note the filter SEMANTICS, which this test revealed: `species=human`
        // also returns "Humanoid", because the API does a case-insensitive
        // SUBSTRING match, not an exact one. Asserting `toBe('Human')` fails
        // against a correctly-working API. Establishing whether a filter is
        // exact, prefix or substring before writing the assertion is the
        // difference between a real test and a guess.
        for (const character of body.results) {
            expect(character.status).toBe('Alive');
            expect(character.species.toLowerCase()).toContain('human');
        }
    });

    test('pagination links resolve and do not repeat rows', async ({ request }) => {
        const firstPage = await request.get('/api/character?page=1');
        const secondPage = await request.get('/api/character?page=2');

        const one = (await firstPage.json()) as Paginated<Character>;
        const two = (await secondPage.json()) as Paginated<Character>;

        expect(one.info.next).toBeTruthy();
        expect(one.info.prev).toBeNull();

        const idsOnPageOne = new Set(one.results.map((c) => c.id));
        const overlap = two.results.filter((c) => idsOnPageOne.has(c.id));
        expect(overlap).toHaveLength(0);
    });
});
