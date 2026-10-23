# wayfair

[![Test](https://github.com/stores-com/wayfair/actions/workflows/test.yml/badge.svg)](https://github.com/stores-com/wayfair/actions/workflows/test.yml)
[![npm version](https://img.shields.io/npm/v/@stores.com/wayfair)](https://www.npmjs.com/package/@stores.com/wayfair)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A Node.js client for Wayfair's dropship inventory API.

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

Every method takes `options.timeout` to override the client's timeout (30 seconds by default).
