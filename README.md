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

Create an application in Wayfair's Developer Portal (Application Management) for a client ID and secret. By default the client targets the production endpoint (`https://api.wayfair.com`). A sandbox application uses the sandbox endpoint:

```javascript
const wayfair = new Wayfair({
    client_id: 'your_sandbox_client_id',
    client_secret: 'your_sandbox_client_secret',
    url: 'https://sandbox.api.wayfair.com'
});
```

Wayfair unlocks each production permission only after it's used in the sandbox.

Errors are thrown as [`HttpError`](https://github.com/stores-com/http-error). That includes GraphQL errors, which Wayfair returns with a 200.

## Documentation

- https://developer.wayfair.io/posts/introduction

## Methods

### getAccessToken(options)

Get an OAuth access token using the `client_credentials` grant. Tokens last 24 hours; each is cached in memory for 12, as Wayfair recommends. Every other method calls this for you.

See: https://developer.wayfair.io/posts/api-access-tokens

```javascript
const accessToken = await wayfair.getAccessToken();
```

### inventory.save(inventory, options)

Send a dropship inventory feed. A `TRUE_UP` feed is a complete listing and is required at least once every 24 hours. A `DIFFERENTIAL` feed (Wayfair's default) has only the products whose quantities changed, ideally every 30 minutes. The sandbox only takes `TRUE_UP` feeds, truncated at 500 rows.

Wayfair processes the feed after responding. Rows it rejects come back in `errors`, and it still saves the rest.

See: https://developer.wayfair.io/posts/dropship-inventory

```javascript
const status = await wayfair.inventory.save([
    { quantityOnHand: 7, supplierId: 199492, supplierPartNumber: '272687' }
], { feedKind: 'TRUE_UP' });
```

### getDropshipPurchaseOrders(variables, options)

Get dropship purchase orders: `hasResponse: false` for open ones, `true` for accepted ones, or leave it out for both. Wayfair returns at most 25 per call and allows one call every 3 seconds. With `autoPagination`, this pages through every purchase order from `fromDate` on, oldest first, 3 seconds apart.

See: https://developer.wayfair.io/posts/docs/orders-api/reference/GraphQL/v1.0.0

```javascript
const purchaseOrders = await wayfair.getDropshipPurchaseOrders({ fromDate: new Date('2026-10-01'), hasResponse: false }, { autoPagination: true });
```

### purchaseOrders.accept(variables, options)

Accept a purchase order's line items, with the purchase order's part numbers, prices and ship speed. Wayfair processes it after responding; line items it rejects, such as ones already accepted, come back in `errors`. Backorders are done in Partner Home.

See: https://developer.wayfair.io/posts/dropship-orders-asn

```javascript
const status = await wayfair.purchaseOrders.accept({
    lineItems: [{ estimatedShipDate: new Date('2026-11-05'), partNumber: 'WL12436', quantity: 1, unitPrice: 181.76 }],
    poNumber: 'CS690310954',
    shipSpeed: 'FEDEX_HOME'
});
```

### purchaseOrders.shipment(notice, options)

Send a ship notice (ASN) once a purchase order leaves the warehouse. Wayfair takes the same notice again without an error, so send each one once.

See: https://developer.wayfair.io/posts/dropship-orders-asn

```javascript
const status = await wayfair.purchaseOrders.shipment({
    carrierCode: 'FDEG',
    destinationAddress: { city: 'Boston', country: 'US', name: 'Jane Doe', postalCode: '02116', state: 'MA', streetAddress1: '4 Copley Place' },
    packageCount: 1,
    poNumber: 'CS690310954',
    shipDate: new Date(),
    shipSpeed: 'FEDEX_HOME',
    smallParcelShipments: [{ items: [{ partNumber: 'WL12436', quantity: 1 }], package: { code: { type: 'TRACKING_NUMBER', value: '794600000000' }, weight: 42 } }],
    sourceAddress: { city: 'Carrollton', country: 'US', name: 'Stores.com', postalCode: '75010', state: 'TX', streetAddress1: '1950 Parker Road' },
    supplierId: 457479,
    trackingNumber: '794600000000'
});
```

Every method takes `options.timeout` to override the client's timeout (30 seconds by default).

## Tests

The tests run against Wayfair's sandbox (`https://sandbox.api.wayfair.com`), never production. They need a sandbox application's `WAYFAIR_CLIENT_ID` and `WAYFAIR_CLIENT_SECRET`, and the sandbox `WAYFAIR_SUPPLIER_ID`.

```
$ WAYFAIR_CLIENT_ID=... WAYFAIR_CLIENT_SECRET=... WAYFAIR_SUPPLIER_ID=... npm test
```
