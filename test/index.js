const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const HttpError = require('@stores.com/http-error');

const Wayfair = require('../index');

/**
 * Stub fetch with a fake Wayfair: the token endpoint returns a new token each call, and GraphQL requests go to a handler.
 *
 * @param {Object} t - The test context.
 * @param {Function} handleGraphql - Called with ({ body, headers }) for each GraphQL request; returns a Response.
 * @returns {Object} Recorded calls ({ graphql: [...], token: [...] }).
 */
function mockWayfair(t, handleGraphql) {
    const calls = { graphql: [], token: [] };

    t.mock.method(globalThis, 'fetch', async (url, options) => {
        if (url === 'https://sso.auth.wayfair.com/oauth/token') {
            calls.token.push({ body: JSON.parse(options.body), options });

            return Response.json({ access_token: crypto.randomUUID(), expires_in: 86400, token_type: 'Bearer' });
        }

        const call = { body: JSON.parse(options.body), headers: new Headers(options.headers), url };

        calls.graphql.push(call);

        return handleGraphql(call);
    });

    return calls;
}

/**
 * A client with its own credentials, so each test gets its own cached token.
 *
 * @param {Object} [args] - Extra client options.
 * @returns {Wayfair} The client.
 */
function createClient(args) {
    return new Wayfair({ client_id: crypto.randomUUID(), client_secret: 'secret', ...args });
}

test('getAccessToken requests a client_credentials token for the API audience and caches it', async (t) => {
    const calls = mockWayfair(t);
    const clientId = crypto.randomUUID();
    const wayfair = new Wayfair({ client_id: clientId, client_secret: 'secret', url: 'https://sandbox.api.wayfair.com' });

    const first = await wayfair.getAccessToken();
    const second = await wayfair.getAccessToken();

    assert.equal(first.access_token, second.access_token);
    assert.equal(calls.token.length, 1);
    assert.deepEqual(calls.token[0].body, { audience: 'https://sandbox.api.wayfair.com/', client_id: clientId, client_secret: 'secret', grant_type: 'client_credentials' });
    assert.equal(calls.token[0].options.method, 'POST');
});

test('getAccessToken gets a new token after half its lifetime', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-23T12:00:00Z') });

    const calls = mockWayfair(t);
    const wayfair = createClient();

    const first = await wayfair.getAccessToken();

    t.mock.timers.tick(43200000);

    assert.equal((await wayfair.getAccessToken()).access_token, first.access_token);

    t.mock.timers.tick(1);

    assert.notEqual((await wayfair.getAccessToken()).access_token, first.access_token);
    assert.equal(calls.token.length, 2);
});

test('getAccessToken throws HttpError when Wayfair refuses the credentials', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'access_denied', error_description: 'Unauthorized' }, { status: 401 }));

    await assert.rejects(createClient().getAccessToken(), err => err instanceof HttpError && err.cause.status === 401);
});

test('inventory.save sends the feed to the production endpoint by default and returns the transaction status', async (t) => {
    const status = { completedAt: null, errorCount: 0, errors: [], handle: 'handle-1', itemCount: 0, status: 'PROCESSING', submittedAt: '2026-10-23 09:13:57.4257 +00:00' };
    const calls = mockWayfair(t, () => Response.json({ data: { inventory: { save: status } } }));
    const inventory = [{ quantityOnHand: 7, supplierId: 199492, supplierPartNumber: '272687' }];
    const wayfair = createClient();

    assert.deepEqual(await wayfair.inventory.save(inventory, { dryRun: true, feedKind: 'TRUE_UP' }), status);

    const token = (await wayfair.getAccessToken()).access_token;

    assert.equal(calls.token[0].body.audience, 'https://api.wayfair.com/');
    assert.equal(calls.graphql[0].url, 'https://api.wayfair.com/v1/graphql');
    assert.equal(calls.graphql[0].headers.get('authorization'), `Bearer ${token}`);
    assert.match(calls.graphql[0].body.query, /inventory\s*{\s*save\(inventory: \$inventory, feedKind: \$feedKind, dryRun: \$dryRun\)/);
    assert.deepEqual(calls.graphql[0].body.variables, { dryRun: true, feedKind: 'TRUE_UP', inventory });
});

test('GraphQL errors throw HttpError even though Wayfair responds 200', async (t) => {
    mockWayfair(t, () => Response.json({ errors: [{ message: 'You do not have access to inventory for any suppliers.' }] }));

    await assert.rejects(createClient().inventory.save([]), err => err instanceof HttpError && err.cause.status === 200 && err.message === 'You do not have access to inventory for any suppliers.');
});

test('a 401 drops the cached token so the next request gets a new one', async (t) => {
    let unauthorized = true;

    const calls = mockWayfair(t, () => {
        if (unauthorized) {
            unauthorized = false;

            return Response.json({ errors: [{ message: 'Unauthorized' }] }, { status: 401 });
        }

        return Response.json({ data: { inventory: { save: { status: 'PROCESSING' } } } });
    });

    const wayfair = createClient();

    await assert.rejects(wayfair.inventory.save([]), err => err.cause.status === 401);
    await wayfair.inventory.save([]);

    assert.equal(calls.token.length, 2);
    assert.notEqual(calls.graphql[0].headers.get('authorization'), calls.graphql[1].headers.get('authorization'));
});

test('getDropshipPurchaseOrders sends a Date fromDate in Wayfair\'s format and returns the purchase orders', async (t) => {
    const purchaseOrders = [{ poDate: '2026-05-13 23:24:02.000000 -05:00', poNumber: 'CS000000001', products: [{ partNumber: '272687', quantity: '1' }] }];
    const calls = mockWayfair(t, () => Response.json({ data: { getDropshipPurchaseOrders: purchaseOrders } }));

    const result = await createClient().getDropshipPurchaseOrders({ fromDate: new Date('2026-05-01T00:00:00.123Z'), hasResponse: false, limit: 5 });

    assert.deepEqual(result, purchaseOrders);
    assert.deepEqual(calls.graphql[0].body.variables, { fromDate: '2026-05-01 00:00:00.123000 +00:00', hasResponse: false, limit: 5 });
    assert.match(calls.graphql[0].body.query, /isCancelled/);
});

test('getDropshipPurchaseOrders leaves out isCancelled in the sandbox, which doesn\'t have it', async (t) => {
    const calls = mockWayfair(t, () => Response.json({ data: { getDropshipPurchaseOrders: [] } }));

    await createClient({ url: 'https://sandbox.api.wayfair.com' }).getDropshipPurchaseOrders();

    assert.doesNotMatch(calls.graphql[0].body.query, /isCancelled/);
});

test('getDropshipPurchaseOrders with autoPagination pages by poDate until a short page', async (t) => {
    const purchaseOrders = Array.from({ length: 28 }, (value, index) => ({ poDate: `2026-06-01 00:${String(index).padStart(2, '0')}:00.000000 +00:00`, poNumber: `CS${index}` }));

    const calls = mockWayfair(t, (call) => {
        const page = purchaseOrders.filter(po => po.poDate >= call.body.variables.fromDate).slice(0, call.body.variables.limit);

        return Response.json({ data: { getDropshipPurchaseOrders: page } });
    });

    const result = await createClient().getDropshipPurchaseOrders({ fromDate: '2026-06-01 00:00:00.000000 +00:00' }, { autoPagination: true });

    assert.deepEqual(result.map(po => po.poNumber), purchaseOrders.map(po => po.poNumber));
    assert.deepEqual(calls.graphql.map(call => call.body.variables), [
        { fromDate: '2026-06-01 00:00:00.000000 +00:00', limit: 25, sortOrder: 'ASC' },
        { fromDate: '2026-06-01 00:24:00.000000 +00:00', limit: 25, sortOrder: 'ASC' }
    ]);
});

test('getDropshipPurchaseOrders with autoPagination stops when a page brings no new purchase orders', async (t) => {
    const purchaseOrders = Array.from({ length: 26 }, (value, index) => ({ poDate: '2026-06-01 00:00:00.000000 +00:00', poNumber: `CS${index}` }));

    const calls = mockWayfair(t, call => Response.json({ data: { getDropshipPurchaseOrders: purchaseOrders.slice(0, call.body.variables.limit) } }));

    const result = await createClient().getDropshipPurchaseOrders({ fromDate: '2026-06-01 00:00:00.000000 +00:00' }, { autoPagination: true });

    assert.equal(result.length, 25);
    assert.equal(calls.graphql.length, 2);
});
