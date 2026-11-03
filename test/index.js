const assert = require('node:assert');
const test = require('node:test');

const cache = require('memory-cache');

const HttpError = require('@stores.com/http-error');

const Wayfair = require('../index');

// Tests run against Wayfair's sandbox, never production
const url = 'https://sandbox.api.wayfair.com';

// Wayfair's sandbox only counts an inventory feed toward production access when it has at least 20 rows
const partNumbers = ['227217', '227218', '227219', '227221', '227223', '227224', '227226', '227227', '227228', '227229', '227230', '227232', '227234', '227235', '227240', '227242', '227244', '267204', '272686', '272687'];

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

        const status = await wayfair.inventory.save(partNumbers.map(partNumber => ({ quantityOnHand: 0, supplierId: Number(process.env.WAYFAIR_SUPPLIER_ID), supplierPartNumber: partNumber })), { feedKind: 'TRUE_UP' });

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

test('getDropshipPurchaseOrders', async (t) => {
    const wayfair = new Wayfair({ client_id: process.env.WAYFAIR_CLIENT_ID, client_secret: process.env.WAYFAIR_CLIENT_SECRET, url });

    // The sandbox's two newest purchase orders
    const purchaseOrders = await wayfair.getDropshipPurchaseOrders({ limit: 2, sortOrder: 'DESC' });

    await t.test('should return purchase orders with their products', () => {
        assert.strictEqual(purchaseOrders.length, 2);
        assert.ok(purchaseOrders.every(po => po.poNumber && po.products.length));
    });

    await t.test('should return only the purchase orders in poNumbers', async () => {
        const result = await wayfair.getDropshipPurchaseOrders({ poNumbers: [purchaseOrders[1].poNumber] });

        assert.deepStrictEqual(result.map(po => po.poNumber), [purchaseOrders[1].poNumber]);
    });

    await t.test('should take a Date for fromDate', async () => {
        assert.deepStrictEqual(await wayfair.getDropshipPurchaseOrders({ fromDate: new Date(Date.now() + 86400000) }), []);
    });

    await t.test('should page through every purchase order from fromDate with autoPagination', async () => {
        // A full first page from the older one, so a second page starts at the newer one
        const result = await wayfair.getDropshipPurchaseOrders({ fromDate: purchaseOrders[1].poDate, limit: 2 }, { autoPagination: true });

        assert.ok(purchaseOrders.every(po => result.some(r => r.poNumber === po.poNumber)));
    });
});

test('purchaseOrders', async (t) => {
    const wayfair = new Wayfair({ client_id: process.env.WAYFAIR_CLIENT_ID, client_secret: process.env.WAYFAIR_CLIENT_SECRET, url });

    // An open purchase order if the sandbox has one, else the newest
    const purchaseOrder = (await wayfair.getDropshipPurchaseOrders({ hasResponse: false, limit: 1 }))[0] || (await wayfair.getDropshipPurchaseOrders({ limit: 1, sortOrder: 'DESC' }))[0];

    await t.test('accept should accept a purchase order and return the transaction status', async () => {
        const status = await wayfair.purchaseOrders.accept({
            lineItems: purchaseOrder.products.map(p => ({ estimatedShipDate: new Date(Date.now() + 86400000), partNumber: p.partNumber, quantity: Number(p.quantity), unitPrice: p.price })),
            poNumber: purchaseOrder.poNumber,
            shipSpeed: purchaseOrder.shippingInfo.shipSpeed
        });

        assert.strictEqual(typeof status.handle, 'string');
        assert.ok(Array.isArray(status.errors));
    });

    await t.test('shipment should send a ship notice and return the transaction status', async () => {
        const status = await wayfair.purchaseOrders.shipment({
            carrierCode: 'FDEG',
            destinationAddress: { city: purchaseOrder.shipTo.city, country: purchaseOrder.shipTo.country, name: purchaseOrder.shipTo.name, postalCode: purchaseOrder.shipTo.postalCode, state: purchaseOrder.shipTo.state, streetAddress1: purchaseOrder.shipTo.address1, streetAddress2: purchaseOrder.shipTo.address2 },
            packageCount: 1,
            poNumber: purchaseOrder.poNumber,
            shipDate: new Date(),
            shipSpeed: purchaseOrder.shippingInfo.shipSpeed,
            smallParcelShipments: [{ items: purchaseOrder.products.map(p => ({ partNumber: p.partNumber, quantity: Number(p.quantity) })), package: { code: { type: 'TRACKING_NUMBER', value: '999999999999' }, weight: 1 } }],
            sourceAddress: { city: purchaseOrder.warehouse.address.city, country: purchaseOrder.warehouse.address.country, name: purchaseOrder.warehouse.address.name, postalCode: purchaseOrder.warehouse.address.postalCode, state: purchaseOrder.warehouse.address.state, streetAddress1: purchaseOrder.warehouse.address.address1 },
            supplierId: purchaseOrder.supplierId,
            trackingNumber: '999999999999'
        });

        assert.strictEqual(typeof status.handle, 'string');
        assert.ok(Array.isArray(status.errors));
    });
});
