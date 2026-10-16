import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * GraphQL layer.
 *
 * The five things that actually differ from REST when you TEST a GraphQL API:
 *
 *  1. One endpoint, always POST (queries can be GET, but POST is the norm).
 *     There is no per-resource URL, so "status code per resource" disappears.
 *
 *  2. THE STATUS CODE PROVES NOTHING. A failed query may come back as 200 with
 *     an `errors` array (the classic `application/json` behaviour) OR as 4xx
 *     (the GraphQL-over-HTTP spec says a validation error SHOULD be 400 when
 *     the response is `application/graphql-response+json`). Both exist in the
 *     wild - this very API answers 400. So the only reliable assertion is on
 *     the `errors` array, never on the status alone. Checking just
 *     `expect(res.status()).toBe(200)` is the most common GraphQL testing
 *     mistake; hard-coding 400 is the same mistake mirrored.
 *
 *  3. The response is partial-by-design: `data` can hold values for the fields
 *     that resolved while `errors` describes the ones that failed. So you assert
 *     on both, not one.
 *
 *  4. You ask for exactly the fields you need. Over-fetching is a client bug,
 *     and a field you did not request is absent rather than null.
 *
 *  5. The schema is introspectable, so the contract is machine-readable - useful
 *     for generating types and for detecting breaking changes.
 */

const ENDPOINT = '/graphql';

interface GraphQLResponse<T> {
    data?: T;
    errors?: Array<{ message: string; path?: Array<string | number> }>;
}

/** Thin helper: one place that knows how a GraphQL call is shaped. */
async function gql<T>(
    request: APIRequestContext,
    query: string,
    variables?: Record<string, unknown>,
): Promise<{ status: number; body: GraphQLResponse<T> }> {
    const response = await request.post(ENDPOINT, {
        data: { query, variables },
        headers: { 'Content-Type': 'application/json' },
    });
    return { status: response.status(), body: (await response.json()) as GraphQLResponse<T> };
}

interface Character {
    id: string;
    name: string;
    status: string;
    origin?: { name: string };
}

test.describe('GraphQL', () => {
    test('a valid query returns data and no errors', async ({ request }) => {
        const { status, body } = await gql<{ character: Character }>(
            request,
            `query GetCharacter($id: ID!) {
                character(id: $id) { id name status }
            }`,
            { id: '1' },
        );

        expect(status).toBe(200);
        // Assert the absence of errors explicitly - 200 alone proves nothing.
        expect(body.errors).toBeUndefined();
        expect(body.data?.character).toMatchObject({ id: '1', name: 'Rick Sanchez' });
    });

    test('returns only the requested fields', async ({ request }) => {
        const { body } = await gql<{ character: Character }>(
            request,
            `{ character(id: 1) { name } }`,
        );

        expect(body.errors).toBeUndefined();
        expect(body.data?.character.name).toBeTruthy();
        // `status` was not requested, so it must not appear at all.
        expect(body.data?.character).not.toHaveProperty('status');
        expect(Object.keys(body.data?.character ?? {})).toEqual(['name']);
    });

    test('an invalid field yields a validation error regardless of status', async ({ request }) => {
        const { status, body } = await gql(request, `{ character(id: 1) { notAField } }`);

        // The assertion that actually matters: the error is in the body.
        expect(body.errors).toBeDefined();
        expect(body.errors?.[0]?.message).toMatch(/notAField/i);
        expect(body.data).toBeFalsy();

        // The status is server-dependent, so accept either convention rather
        // than coupling the test to one implementation. This API returns 400.
        expect([200, 400]).toContain(status);
    });

    test('a wrong variable type is rejected before execution', async ({ request }) => {
        const { body } = await gql(
            request,
            `query Bad($id: ID!) { character(id: $id) { name } }`,
            { id: { nested: 'object' } },
        );

        expect(body.errors).toBeDefined();
    });

    test('nested resolvers return a consistent object graph', async ({ request }) => {
        const { body } = await gql<{
            characters: { info: { count: number }; results: Character[] };
        }>(
            request,
            `query Page($page: Int!) {
                characters(page: $page) {
                    info { count }
                    results { id name origin { name } }
                }
            }`,
            { page: 1 },
        );

        expect(body.errors).toBeUndefined();
        const results = body.data?.characters.results ?? [];
        expect(results.length).toBeGreaterThan(0);
        for (const character of results) {
            expect(character.id).toBeTruthy();
            expect(character.origin?.name).toBeDefined();
        }
    });

    test('aliases let one request fetch the same field twice', async ({ request }) => {
        const { body } = await gql<{ first: Character; second: Character }>(
            request,
            `{
                first: character(id: 1) { name }
                second: character(id: 2) { name }
            }`,
        );

        expect(body.errors).toBeUndefined();
        expect(body.data?.first.name).not.toBe(body.data?.second.name);
    });

    test('fragments keep a shared field set in one place', async ({ request }) => {
        const { body } = await gql<{ a: Character; b: Character }>(
            request,
            `fragment Basics on Character { id name status }
             {
                a: character(id: 1) { ...Basics }
                b: character(id: 2) { ...Basics }
             }`,
        );

        expect(body.errors).toBeUndefined();
        expect(Object.keys(body.data?.a ?? {}).sort()).toEqual(['id', 'name', 'status']);
    });

    test('introspection exposes the schema as a testable contract', async ({ request }) => {
        const { body } = await gql<{ __type: { fields: Array<{ name: string }> } }>(
            request,
            `{ __type(name: "Character") { fields { name } } }`,
        );

        expect(body.errors).toBeUndefined();
        const fieldNames = body.data?.__type.fields.map((f) => f.name) ?? [];
        // A contract test: these fields must not disappear without notice.
        expect(fieldNames).toEqual(expect.arrayContaining(['id', 'name', 'status', 'species']));
    });
});
