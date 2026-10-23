# wayfair

[![Test](https://github.com/stores-com/wayfair/actions/workflows/test.yml/badge.svg)](https://github.com/stores-com/wayfair/actions/workflows/test.yml)
[![npm version](https://img.shields.io/npm/v/@stores.com/wayfair)](https://www.npmjs.com/package/@stores.com/wayfair)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A Node.js client for Wayfair's supplier APIs: dropship inventory feeds, dropship purchase orders, accepting purchase orders, and ship notices.

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

### getDropshipPurchaseOrders(variables, options)

Get dropship purchase orders. Leave out `hasResponse` to get open and accepted purchase orders alike. `fromDate` can be a `Date`.

Wayfair returns at most 25 per call and allows one call every 3 seconds. With `autoPagination`, the client pages through every purchase order from `fromDate` on, oldest first, 3 seconds apart. Wayfair has no paging cursor, so each page starts at the last page's newest `poDate`. If more than 25 purchase orders share one `poDate`, the ones after the 25th are missed.

`products.isCancelled` is left out in the sandbox, which doesn't have it.

See: https://developer.wayfair.io/posts/dropship-orders-asn

```javascript
const purchaseOrders = await wayfair.getDropshipPurchaseOrders({ fromDate: new Date('2026-10-01') }, { autoPagination: true });
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

### purchaseOrders.accept(variables, options)

Accept a dropship purchase order's line items. Backorders can't be sent through the API; they're done on Partner Home's Dropship Orders page.

See: https://developer.wayfair.io/posts/dropship-orders-asn

```javascript
const status = await wayfair.purchaseOrders.accept({
    lineItems: [{ estimatedShipDate: '2026-10-24 00:00:00.000000 +00:00', partNumber: '272687', quantity: 1, unitPrice: 10.99 }],
    poNumber: 'CS000000001',
    shipSpeed: 'GROUND'
});
```

### purchaseOrders.shipment(notice, options)

Send a ship notice (ASN) for a dropship purchase order, as soon as it leaves the warehouse.

See: https://developer.wayfair.io/posts/dropship-orders-asn

```javascript
const status = await wayfair.purchaseOrders.shipment({
    carrierCode: 'FDEG',
    destinationAddress: { city: 'Springfield', country: 'US', name: 'Jane Customer', postalCode: '62701', state: 'IL', streetAddress1: '100 Main Street' },
    packageCount: 1,
    poNumber: 'CS000000001',
    shipDate: '2026-10-23 15:00:00.000000 +00:00',
    shipSpeed: 'GROUND',
    smallParcelShipments: [{ items: [{ partNumber: '272687', quantity: 1 }], package: { code: { type: 'TRACKING_NUMBER', value: '999999999999' }, weight: 4 } }],
    sourceAddress: { city: 'Carrollton', country: 'US', name: 'Stores.com TX 75010', postalCode: '75010', state: 'TX', streetAddress1: '1950 Parker Road' },
    supplierId: 199492,
    trackingNumber: '999999999999'
});
```

Every method takes `options.timeout` to override the client's timeout (30 seconds by default).
