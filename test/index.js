const assert = require('node:assert');
const test = require('node:test');

const cache = require('memory-cache');

const HttpError = require('@stores.com/http-error');

const Wayfair = require('../index');

// Wayfair's sandbox only counts an inventory feed toward production access when it has at least 20 rows
const partNumbers = ['227217', '227218', '227219', '227221', '227223', '227224', '227226', '227227', '227228', '227229', '227230', '227232', '227234', '227235', '227240', '227242', '227244', '267204', '272686', '272687'];

test('getAccessToken', { concurrency: true }, async (t) => {
    t.test('should return an access token and cache it', async () => {
        const wayfair = new Wayfair({ client_id: process.env.WAYFAIR_CLIENT_ID, client_secret: process.env.WAYFAIR_CLIENT_SECRET, sandbox: true });

        const accessToken = await wayfair.getAccessToken();

        assert.ok(accessToken.access_token);
        assert.strictEqual(await wayfair.getAccessToken(), accessToken);
    });

    t.test('should throw HttpError for invalid credentials', async () => {
        const wayfair = new Wayfair({ client_id: 'invalid', client_secret: 'invalid', sandbox: true });

        await assert.rejects(wayfair.getAccessToken(), err => err instanceof HttpError && err.cause.status === 400 && err.json.error === 'invalid_client');
    });
});

test('inventory.save', { concurrency: true }, async (t) => {
    t.test('should save a TRUE_UP feed and return the transaction status', async () => {
        const wayfair = new Wayfair({ client_id: process.env.WAYFAIR_CLIENT_ID, client_secret: process.env.WAYFAIR_CLIENT_SECRET, sandbox: true });

        const status = await wayfair.inventory.save(partNumbers.map(partNumber => ({ quantityOnHand: 0, supplierId: Number(process.env.WAYFAIR_SUPPLIER_ID), supplierPartNumber: partNumber })), { feedKind: 'TRUE_UP' });

        assert.strictEqual(typeof status.handle, 'string');
        assert.ok(Array.isArray(status.errors));
    });

    t.test('should validate a feed without saving it when dryRun is true', async () => {
        const wayfair = new Wayfair({ client_id: process.env.WAYFAIR_CLIENT_ID, client_secret: process.env.WAYFAIR_CLIENT_SECRET, sandbox: true });

        const status = await wayfair.inventory.save([{ quantityOnHand: 0, supplierId: Number(process.env.WAYFAIR_SUPPLIER_ID), supplierPartNumber: '272687' }], { dryRun: true, feedKind: 'TRUE_UP' });

        assert.strictEqual(typeof status.handle, 'string');
        assert.ok(Array.isArray(status.errors));
    });

    t.test('should return the rows Wayfair rejects in errors and still resolve', async () => {
        const wayfair = new Wayfair({ client_id: process.env.WAYFAIR_CLIENT_ID, client_secret: process.env.WAYFAIR_CLIENT_SECRET, sandbox: true });

        // supplierId is required on every row
        const status = await wayfair.inventory.save([{ quantityOnHand: 0, supplierPartNumber: '272687' }], { dryRun: true, feedKind: 'TRUE_UP' });

        assert.ok(status.errors.length > 0);
    });

    t.test('should throw HttpError for GraphQL errors, which Wayfair returns with a 200', async () => {
        const wayfair = new Wayfair({ client_id: process.env.WAYFAIR_CLIENT_ID, client_secret: process.env.WAYFAIR_CLIENT_SECRET, sandbox: true });

        // Wayfair rejects the whole request when there's no inventory
        await assert.rejects(wayfair.inventory.save([], { dryRun: true, feedKind: 'TRUE_UP' }), err => err instanceof HttpError && err.cause.status === 200 && err.json.errors.length > 0);
    });
});

// Runs on its own: it puts a bad token in the cache that every client with these credentials shares
test('a 401 should drop the cached access token so the next request gets a new one', async () => {
    const wayfair = new Wayfair({ client_id: process.env.WAYFAIR_CLIENT_ID, client_secret: process.env.WAYFAIR_CLIENT_SECRET, sandbox: true });

    // HACK: put an access token Wayfair won't accept in the cache, under the client's key
    cache.put(`wayfair:${process.env.WAYFAIR_CLIENT_ID}:https://sandbox.api.wayfair.com`, { access_token: 'invalid', expires_in: 86400, token_type: 'Bearer' });

    await assert.rejects(wayfair.inventory.save([{ quantityOnHand: 0, supplierId: Number(process.env.WAYFAIR_SUPPLIER_ID), supplierPartNumber: '272687' }], { dryRun: true, feedKind: 'TRUE_UP' }), err => err instanceof HttpError && err.cause.status === 401);

    const status = await wayfair.inventory.save([{ quantityOnHand: 0, supplierId: Number(process.env.WAYFAIR_SUPPLIER_ID), supplierPartNumber: '272687' }], { dryRun: true, feedKind: 'TRUE_UP' });

    assert.strictEqual(typeof status.handle, 'string');
});

// Wayfair's sandbox certification scenarios for the 2026-09 APIs, with the sandbox's fixed purchase orders. The sandbox allows 20 requests a minute on the 2026-09 route, which both APIs share; the tests below make 12 there, plus one per 100 orders in the sandbox.
test('dropshipOrders', async (t) => {
    const wayfair = new Wayfair({ client_id: process.env.WAYFAIR_CLIENT_ID, client_secret: process.env.WAYFAIR_CLIENT_SECRET, sandbox: true, supplierId: 457479 });

    await t.test('should page forward through every order without duplicates, then back', async () => {
        const sort = { direction: 'DESC', field: 'CREATED_AT' };

        // 100 a page, as in the guide
        const dropshipOrders = await wayfair.dropshipOrders({ first: 100, sort }, { autoPagination: true });
        const purchaseOrderNumbers = dropshipOrders.edges.map(edge => edge.node.purchaseOrderNumber);

        assert.strictEqual(new Set(purchaseOrderNumbers).size, purchaseOrderNumbers.length);
        assert.strictEqual(dropshipOrders.pageInfo.hasNextPage, false);

        // The page before the last page should be the 100 orders just before it
        const lastPageIndex = dropshipOrders.edges.findIndex(edge => edge.cursor === dropshipOrders.pageInfo.startCursor);

        assert.ok(lastPageIndex > 0);

        const previousPage = await wayfair.dropshipOrders({ before: dropshipOrders.pageInfo.startCursor, last: 100, sort });

        assert.deepStrictEqual(previousPage.edges.map(edge => edge.node.purchaseOrderNumber), purchaseOrderNumbers.slice(lastPageIndex - 100, lastPageIndex));
    });

    await t.test('should return only the orders matching order status, line item status and task at once', async () => {
        const dropshipOrders = await wayfair.dropshipOrders({ filter: { lineItemStatus: ['NEW'], orderStatus: ['NEW'], orderTasks: ['PENDING_CANCELLATION', 'SHIP_ADDRESS_CHANGE', 'SHIP_SPEED_CHANGE'] }, first: 100 });
        const orders = dropshipOrders.edges.map(edge => edge.node);

        assert.ok(orders.length > 0);
        assert.ok(orders.every(order => order.status === 'NEW' && order.lineItems.some(lineItem => lineItem.status === 'NEW') && [order, ...order.lineItems].some(item => item.tasks?.length)));
    });

    // Only the PII-on half of the scenario: a sandbox application has every permission, so it can't get a token without orders:read-dropship-orders-pii
    await t.test('should return every address field with the PII permission', async () => {
        const order = (await wayfair.dropshipOrders({ filter: { purchaseOrderNumbers: ['CS10001081'] } })).edges[0].node;

        // The sandbox leaves this order's billingAddress empty, city and country included
        const addresses = { customer: order.customer, shippingAddress: order.shippingAddress, 'warehouseDetails.address': order.warehouseDetails.address };
        const missing = Object.keys(addresses).flatMap(key => ['address1', 'city', 'country', 'name', 'postalCode', 'state'].filter(field => !addresses[key][field]).map(field => `${key}.${field}`));

        assert.deepStrictEqual(missing, []);
    });

    await t.test('purchaseOrderNumbers', async (t) => {
        const statusPurchaseOrderNumbers = ['CS10001001', 'CS10001002', 'CS10001003', 'CS10001004', 'CS10001005', 'CS10001006', 'CS10001007', 'CS10001008', 'CS10001009'];

        // The sandbox's order with multiple line items, sparse order, order with other line item statuses, date window orders, order status orders, and a purchase order it doesn't have
        const dropshipOrders = await wayfair.dropshipOrders({ filter: { purchaseOrderNumbers: ['CS10000002', 'CS10000003', 'CS10000005', 'CS10001034', 'CS10001062', ...statusPurchaseOrderNumbers, 'CS99999999'] } });

        await t.test('should return a NOT_FOUND issue, with no cursor, for an unknown purchase order', () => {
            const edge = dropshipOrders.edges.find(edge => edge.node.purchaseOrderNumber === 'CS99999999');

            assert.strictEqual(edge.cursor, null);
            assert.strictEqual(edge.node.__typename, 'SupplierDropshipOrderIssue');
            assert.strictEqual(edge.node.code, 'NOT_FOUND');
            assert.strictEqual(edge.node.retryable, false);
        });

        await t.test('should read a sparse order', () => {
            const order = dropshipOrders.edges.find(edge => edge.node.purchaseOrderNumber === 'CS10000003').node;

            assert.strictEqual(order.__typename, 'SupplierDropshipOrder');
            assert.ok(Array.isArray(order.lineItems));
        });

        await t.test('should read an order with multiple line items', () => {
            const order = dropshipOrders.edges.find(edge => edge.node.purchaseOrderNumber === 'CS10000002').node;

            assert.ok(order.lineItems.length > 1);
        });

        await t.test('should read an order whose line items have other statuses than the order', () => {
            const order = dropshipOrders.edges.find(edge => edge.node.purchaseOrderNumber === 'CS10000005').node;

            assert.ok(order.lineItems.some(lineItem => lineItem.status !== order.status));
        });

        await t.test('should filter by order status', async () => {
            const orders = dropshipOrders.edges.map(edge => edge.node).filter(node => statusPurchaseOrderNumbers.includes(node.purchaseOrderNumber));
            const status = orders.find(order => order.purchaseOrderNumber === 'CS10001001').status;

            const result = await wayfair.dropshipOrders({ filter: { orderStatus: [status], purchaseOrderNumbers: statusPurchaseOrderNumbers } });

            assert.deepStrictEqual(result.edges.map(edge => edge.node).filter(node => node.__typename === 'SupplierDropshipOrder').map(order => order.purchaseOrderNumber), orders.filter(order => order.status === status).map(order => order.purchaseOrderNumber));
        });

        await t.test('should filter by a createdAt window', async () => {
            const orders = dropshipOrders.edges.map(edge => edge.node).filter(node => ['CS10001034', 'CS10001062'].includes(node.purchaseOrderNumber));

            // The sandbox's creation dates move with the calendar, so the window is the UTC day CS10001062 was created
            const from = new Date(orders.find(order => order.purchaseOrderNumber === 'CS10001062').createdAt.slice(0, 10));
            const to = new Date(from.getTime() + 86400000);

            const result = await wayfair.dropshipOrders({ filter: { createdAt: { from: from.toISOString(), to: to.toISOString() }, purchaseOrderNumbers: ['CS10001034', 'CS10001062'] } });

            assert.deepStrictEqual(result.edges.map(edge => edge.node.purchaseOrderNumber).sort(), orders.filter(order => new Date(order.createdAt) >= from && new Date(order.createdAt) < to).map(order => order.purchaseOrderNumber).sort());
        });
    });
});

test('acceptDropshipOrder', { concurrency: true }, async (t) => {
    const wayfair = new Wayfair({ client_id: process.env.WAYFAIR_CLIENT_ID, client_secret: process.env.WAYFAIR_CLIENT_SECRET, sandbox: true, supplierId: 457479 });

    t.test('should accept a new purchase order and return it', async () => {
        const result = await wayfair.acceptDropshipOrder({ purchaseOrderNumber: 'CS10002001' });

        assert.strictEqual(result.purchaseOrder.purchaseOrderNumber, 'CS10002001');
        assert.strictEqual(result.purchaseOrder.status, 'PROCESSING');
        assert.deepStrictEqual(result.errors, []);
    });

    // The sandbox refuses each of these purchase orders
    [
        { __typename: 'AcceptDropshipOrderStatusNotNewError', code: 'CONFLICT', purchaseOrderNumber: 'CS10002002' },
        { __typename: 'AcceptDropshipOrderOrderIsReplacementPartError', code: 'CONFLICT', purchaseOrderNumber: 'CS10002003-R-99' },
        { __typename: 'AcceptDropshipOrderInvalidShipSpeedError', code: 'BAD_USER_INPUT', purchaseOrderNumber: 'CS10002004', shipSpeed: 'SECOND_DAY_AIR' },
        { __typename: 'AcceptDropshipOrderPurchaseOrderCancelledError', code: 'CONFLICT', purchaseOrderNumber: 'CS10002005' }
    ].forEach(refusal => {
        t.test(`should return ${refusal.__typename} for ${refusal.purchaseOrderNumber}, not throw it`, async () => {
            const result = await wayfair.acceptDropshipOrder({ purchaseOrderNumber: refusal.purchaseOrderNumber, shipSpeed: refusal.shipSpeed });
            const error = result.errors[0];

            assert.strictEqual(result.purchaseOrder, null);
            assert.deepStrictEqual([error.__typename, error.code, error.purchaseOrderNumber, error.retryable], [refusal.__typename, refusal.code, refusal.purchaseOrderNumber, false]);
        });
    });
});

test('purchaseOrders', async (t) => {
    const wayfair = new Wayfair({ client_id: process.env.WAYFAIR_CLIENT_ID, client_secret: process.env.WAYFAIR_CLIENT_SECRET, sandbox: true, supplierId: 457479 });

    // The sandbox order with every address field filled in, which a ship notice needs
    const order = (await wayfair.dropshipOrders({ filter: { purchaseOrderNumbers: ['CS10001081'] } })).edges[0].node;

    // The v1 sandbox doesn't have the 2026-09 sandbox's orders, so it refuses the purchase order number, after checking the notice's types. In production both APIs read the same purchase orders.
    await t.test('shipment should send a ship notice built from a dropshipOrders order', async () => {
        await assert.rejects(wayfair.purchaseOrders.shipment({
            carrierCode: 'FDEG',
            destinationAddress: { city: order.shippingAddress.city, country: order.shippingAddress.country, name: order.shippingAddress.name, postalCode: order.shippingAddress.postalCode, state: order.shippingAddress.state, streetAddress1: order.shippingAddress.address1, streetAddress2: order.shippingAddress.address2 },
            packageCount: 1,
            poNumber: order.purchaseOrderNumber,
            shipDate: new Date(),
            // shippingInfo.shipSpeed can be null, or a 2026-09 speed v1 doesn't have
            shipSpeed: 'GROUND',
            smallParcelShipments: [{ items: order.lineItems.map(lineItem => ({ partNumber: lineItem.supplierPartNumber, quantity: lineItem.quantity })), package: { code: { type: 'TRACKING_NUMBER', value: '999999999999' }, weight: 1 } }],
            sourceAddress: { city: order.warehouseDetails.address.city, country: order.warehouseDetails.address.country, name: order.warehouseDetails.address.name, postalCode: order.warehouseDetails.address.postalCode, state: order.warehouseDetails.address.state, streetAddress1: order.warehouseDetails.address.address1 },
            // A ship notice's supplierId is the warehouse the order ships from
            supplierId: order.warehouseDetails.id,
            trackingNumber: '999999999999'
        }), err => err instanceof HttpError && err.json.errors[0].message === 'Invalid purchase order number provided');
    });
});
