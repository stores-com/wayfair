# wayfair

[![Test](https://github.com/stores-com/wayfair/actions/workflows/test.yml/badge.svg)](https://github.com/stores-com/wayfair/actions/workflows/test.yml)
[![Coverage Status](https://coveralls.io/repos/github/stores-com/wayfair/badge.svg?branch=main)](https://coveralls.io/github/stores-com/wayfair?branch=main)
[![npm version](https://img.shields.io/npm/v/@stores.com/wayfair)](https://www.npmjs.com/package/@stores.com/wayfair)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A Node.js client for the Wayfair API.

## Installation

```
$ npm install @stores.com/wayfair
```

## Usage

```javascript
const Wayfair = require('@stores.com/wayfair');

const wayfair = new Wayfair({
    client_id: 'your_client_id',
    client_secret: 'your_client_secret'
});
```

Create an application in Wayfair's Developer Portal (Application Management) for a client ID and secret. By default the client uses Wayfair's production endpoints. A sandbox application uses the sandbox:

```javascript
const wayfair = new Wayfair({
    client_id: 'your_sandbox_client_id',
    client_secret: 'your_sandbox_client_secret',
    sandbox: true
});
```

Wayfair unlocks each production permission only after it's used in the sandbox.

`dropshipOrders` and `acceptDropshipOrder` need `supplierId` (e.g. `457479`), sent as the `WF-Supplier-Id` header: Wayfair's access tokens carry no supplier claim, and without one the 2026-09 APIs refuse the request as `UNAUTHENTICATED`.

`dropshipOrders` and `acceptDropshipOrder` use Wayfair's 2026-09 APIs (`https://api.wayfair.io/2026-09/dropship-orders/graphql`). `inventory.save` and `purchaseOrders.shipment` use its v1 API (`https://api.wayfair.com/v1/graphql`), because Wayfair has no newer version of either. One access token works for both.

Errors are thrown as [`HttpError`](https://github.com/stores-com/http-error). That includes GraphQL errors, which Wayfair returns with a 200; `err.json` holds Wayfair's response. When Wayfair responds to a GraphQL request with a 429, the client waits as many seconds as the `Retry-After` header says (1 if it's missing) and sends the same request again.

## Documentation

- https://developer.wayfair.io/posts/introduction
- Dropship Orders API (2026-09): [guide](https://developer.wayfair.io/posts/dropship-orders-api-2026-09), [GraphQL specification](https://developer.wayfair.io/posts/docs/dropship-orders-api/reference/GraphQL/2026-09)
- Accept Dropship Order API (2026-09): [guide](https://developer.wayfair.io/posts/accept-dropship-order-api-2026-09), [GraphQL specification](https://developer.wayfair.io/posts/docs/accept-dropship-order-api/reference/GraphQL/2026-09)

## Methods

### getAccessToken(options)

Get an OAuth access token using the `client_credentials` grant. Tokens last 24 hours; each is cached in memory for 12, as Wayfair recommends. Every other method calls this for you.

See: https://developer.wayfair.io/posts/api-access-tokens

```javascript
const accessToken = await wayfair.getAccessToken();
```

### inventory.save(inventory, options)

Send a dropship inventory feed. A `TRUE_UP` feed is a complete listing and is required at least once every 24 hours. A `DIFFERENTIAL` feed (Wayfair's default) has only the products whose quantities changed, ideally every 30 minutes. The sandbox only takes `TRUE_UP` feeds, truncated at 500 rows.

Wayfair processes the feed after responding. Rows it rejects come back in `errors`, and it still saves the rest. This is Wayfair's v1 API, which has no newer version.

See: https://developer.wayfair.io/posts/dropship-inventory

```javascript
const status = await wayfair.inventory.save([
    { quantityOnHand: 7, supplierId: 457479, supplierPartNumber: '272687' }
], { feedKind: 'TRUE_UP' });
```

### dropshipOrders(variables, options)

Get dropship purchase orders, newest first by default. `variables` are the query's arguments: `filter`, `first` and `after` to page forward, `last` and `before` to page back, and `sort`. The result is Wayfair's connection: `{ edges: [{ cursor, node }], pageInfo }`. Each `node` is a `SupplierDropshipOrder`, or a `SupplierDropshipOrderIssue` for a purchase order Wayfair couldn't return, such as an unknown one in `filter.purchaseOrderNumbers` (`NOT_FOUND`). Check `__typename`; an issue doesn't fail the page.

Wayfair returns up to 250 orders a page (50 by default) and allows 2 requests a second and 120 a minute per supplier (5 a second and 20 a minute in the sandbox), shared by `acceptDropshipOrder` and any other application for the same supplier. A `createdAt` window can be at most 30 days wide and start at most 180 days ago, and `filter.purchaseOrderNumbers` takes up to 100. Cursors expire after 24 hours and only work with the filter and sort that issued them.

With `autoPagination`, this pages forward, following `pageInfo.endCursor` to the last page, 250 orders at a time unless `first` says otherwise, and returns every page's `edges` with the last page's `pageInfo`. It can't be combined with `last` or `before`.

Every field is selected, addresses included. All address fields but `city`, `state` and `country` need the `orders:read-dropship-orders-pii` permission. Without it, Wayfair nulls them and adds a `FORBIDDEN_SCOPE` error, so this throws; `err.json.data.dropshipOrders` still holds the page. With `autoPagination`, it throws on the first page, so that's the only page it holds.

See: https://developer.wayfair.io/posts/dropship-orders-api-2026-09

```javascript
const dropshipOrders = await wayfair.dropshipOrders({
    filter: { orderStatus: ['NEW'] },
    sort: { direction: 'ASC', field: 'CREATED_AT' }
}, { autoPagination: true });

const orders = dropshipOrders.edges.map(edge => edge.node).filter(node => node.__typename === 'SupplierDropshipOrder');
```

### acceptDropshipOrder(input, options)

Accept a whole purchase order at its ordered quantities: Partner Home's Acknowledge, through the API. `shipSpeed` is optional; when it's given, it must match the purchase order's. On success, `purchaseOrder` has the same fields `dropshipOrders` returns, with `status` typically `PROCESSING`, and `errors` is empty. Wayfair's rate limit is shared with `dropshipOrders`.

A refusal is returned, not thrown: Wayfair responds with a 200, `purchaseOrder: null` and `errors`. Check each error's `__typename`, since three refusals share the `CONFLICT` code:

| `__typename` | `code` | Refused because the purchase order |
|---|---|---|
| `AcceptDropshipOrderStatusNotNewError` | `CONFLICT` | isn't `NEW`, e.g. it's already accepted |
| `AcceptDropshipOrderPurchaseOrderCancelledError` | `CONFLICT` | is cancelled |
| `AcceptDropshipOrderOrderIsReplacementPartError` | `CONFLICT` | is for a replacement part |
| `AcceptDropshipOrderInvalidShipSpeedError` | `BAD_USER_INPUT` | has a different ship speed than `shipSpeed` |
| `AcceptDropshipOrderNotFoundError` | `NOT_FOUND` | doesn't exist for this supplier |
| `AcceptDropshipOrderInvalidOrderNumberError` | `BAD_USER_INPUT` | number is malformed |

Without the `orders:read-dropship-orders-pii` permission, Wayfair nulls `purchaseOrder`'s address fields but `city`, `state` and `country` and adds a `FORBIDDEN_SCOPE` error, so this throws even though the order was accepted; `err.json.data.acceptDropshipOrder` still holds the result.

See: https://developer.wayfair.io/posts/accept-dropship-order-api-2026-09

```javascript
const result = await wayfair.acceptDropshipOrder({ purchaseOrderNumber: 'CS690310954', shipSpeed: 'GROUND' });

if (result.errors.length) {
    console.log(result.errors[0].__typename, result.errors[0].message);
}
```

### purchaseOrders.shipment(notice, options)

Send a ship notice (ASN) once a purchase order leaves the warehouse. Wayfair takes the same notice again without an error, so send each one once. It allows one ship notice every 3 seconds, with up to 10 line items each. This is Wayfair's v1 API, which has no newer version.

From a `dropshipOrders` order: `poNumber` is `purchaseOrderNumber`, `supplierId` is `warehouseDetails.id` (the warehouse it ships from), `shipSpeed` is `shippingInfo.shipSpeed` (which can be null, or `EXPRESS` or a `BIG_AND_BULKY_*` speed v1 doesn't have), `destinationAddress` is `shippingAddress`, `sourceAddress` is `warehouseDetails.address` (`address1` and `address2` become `streetAddress1` and `streetAddress2`), and each item's `partNumber` is a line item's `supplierPartNumber`.

See: https://developer.wayfair.io/posts/dropship-orders-asn

```javascript
const status = await wayfair.purchaseOrders.shipment({
    carrierCode: 'FDEG',
    destinationAddress: { city: 'Boston', country: 'USA', name: 'Jane Doe', postalCode: '02116', state: 'MA', streetAddress1: '4 Copley Place' },
    packageCount: 1,
    poNumber: 'CS690310954',
    shipDate: new Date(),
    shipSpeed: 'GROUND',
    smallParcelShipments: [{ items: [{ partNumber: 'WL12436', quantity: 1 }], package: { code: { type: 'TRACKING_NUMBER', value: '794600000000' }, weight: 42 } }],
    sourceAddress: { city: 'Carrollton', country: 'USA', name: 'Stores.com', postalCode: '75010', state: 'TX', streetAddress1: '1950 Parker Road' },
    supplierId: 457479,
    trackingNumber: '794600000000'
});
```

Every method takes `options.timeout` to override the client's timeout (30 seconds by default).

## Tests

The tests run against Wayfair's sandbox, never production. They include the mandatory and recommended sandbox certification scenarios for the 2026-09 APIs, which Wayfair requires before it unlocks them in production, except the PII-off half of the redacted PII scenario: it needs an application without the `orders:read-dropship-orders-pii` permission, and a sandbox application has every permission. They need a sandbox application's `WAYFAIR_CLIENT_ID` and `WAYFAIR_CLIENT_SECRET`, and the sandbox `WAYFAIR_SUPPLIER_ID`.

```
$ WAYFAIR_CLIENT_ID=... WAYFAIR_CLIENT_SECRET=... WAYFAIR_SUPPLIER_ID=... npm test
```
