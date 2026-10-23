const assert = require('node:assert');
const test = require('node:test');

const cache = require('memory-cache');

const HttpError = require('@stores.com/http-error');

const Wayfair = require('../index');

// Tests run against Wayfair's sandbox, never production
const url = 'https://sandbox.api.wayfair.com';

test('getAccessToken', { concurrency: true }, async (t) => {
    t.test('should return an access token and cache it', async () => {
        const wayfair = new Wayfair({ client_id: process.env.WAYFAIR_CLIENT_ID, client_secret: process.env.WAYFAIR_CLIENT_SECRET, url });

        const accessToken = await wayfair.getAccessToken();

        assert.ok(accessToken.access_token);
        assert.strictEqual(await wayfair.getAccessToken(), accessToken);
    });

    t.test('should throw HttpError for invalid credentials', async () => {
        const wayfair = new Wayfair({ client_id: 'invalid', client_secret: 'invalid', url });

        await assert.rejects(wayfair.getAccessToken(), err => err instanceof HttpError && err.cause.status === 400 && err.json.error === 'invalid_client');
    });
});

test('inventory.save', { concurrency: true }, async (t) => {
    t.test('should save a TRUE_UP feed and return the transaction status', async () => {
        const wayfair = new Wayfair({ client_id: process.env.WAYFAIR_CLIENT_ID, client_secret: process.env.WAYFAIR_CLIENT_SECRET, url });

        const status = await wayfair.inventory.save([{ quantityOnHand: 0, supplierId: Number(process.env.WAYFAIR_SUPPLIER_ID), supplierPartNumber: '272687' }], { feedKind: 'TRUE_UP' });

        assert.strictEqual(typeof status.handle, 'string');
        assert.ok(Array.isArray(status.errors));
    });

    t.test('should validate a feed without saving it when dryRun is true', async () => {
        const wayfair = new Wayfair({ client_id: process.env.WAYFAIR_CLIENT_ID, client_secret: process.env.WAYFAIR_CLIENT_SECRET, url });

        const status = await wayfair.inventory.save([{ quantityOnHand: 0, supplierId: Number(process.env.WAYFAIR_SUPPLIER_ID), supplierPartNumber: '272687' }], { dryRun: true, feedKind: 'TRUE_UP' });

        assert.strictEqual(typeof status.handle, 'string');
        assert.ok(Array.isArray(status.errors));
    });

    t.test('should return the rows Wayfair rejects in errors and still resolve', async () => {
        const wayfair = new Wayfair({ client_id: process.env.WAYFAIR_CLIENT_ID, client_secret: process.env.WAYFAIR_CLIENT_SECRET, url });

        // supplierId is required on every row
        const status = await wayfair.inventory.save([{ quantityOnHand: 0, supplierPartNumber: '272687' }], { dryRun: true, feedKind: 'TRUE_UP' });

        assert.ok(status.errors.length > 0);
    });

    t.test('should throw HttpError for GraphQL errors, which Wayfair returns with a 200', async () => {
        const wayfair = new Wayfair({ client_id: process.env.WAYFAIR_CLIENT_ID, client_secret: process.env.WAYFAIR_CLIENT_SECRET, url });

        // Wayfair rejects the whole request when there's no inventory
        await assert.rejects(wayfair.inventory.save([], { dryRun: true, feedKind: 'TRUE_UP' }), err => err instanceof HttpError && err.cause.status === 200 && err.json.errors.length > 0);
    });
});

// Runs on its own: it puts a bad token in the cache that every client with these credentials shares
test('a 401 should drop the cached access token so the next request gets a new one', async () => {
    const wayfair = new Wayfair({ client_id: process.env.WAYFAIR_CLIENT_ID, client_secret: process.env.WAYFAIR_CLIENT_SECRET, url });

    // HACK: put an access token Wayfair won't accept in the cache, under the client's key
    cache.put(`wayfair:${process.env.WAYFAIR_CLIENT_ID}:${url}`, { access_token: 'invalid', expires_in: 86400, token_type: 'Bearer' });

    await assert.rejects(wayfair.inventory.save([{ quantityOnHand: 0, supplierId: Number(process.env.WAYFAIR_SUPPLIER_ID), supplierPartNumber: '272687' }], { dryRun: true, feedKind: 'TRUE_UP' }), err => err instanceof HttpError && err.cause.status === 401);

    const status = await wayfair.inventory.save([{ quantityOnHand: 0, supplierId: Number(process.env.WAYFAIR_SUPPLIER_ID), supplierPartNumber: '272687' }], { dryRun: true, feedKind: 'TRUE_UP' });

    assert.strictEqual(typeof status.handle, 'string');
});
