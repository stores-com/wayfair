# Changelog

## 0.3.0

- Add `getDropshipPurchaseOrders(variables, options)` back, on the v1 API, with `autoPagination` (100 a call unless `limit` says otherwise). Wayfair doesn't give the 2026-09 `dropshipOrders` to suppliers outside its beta.

## 0.2.0

- Breaking: replace the `url` option with `sandbox` (`true` for Wayfair's sandbox).
- Add `dropshipOrders(variables, options)`, with `autoPagination`, and `acceptDropshipOrder(input, options)` on Wayfair's 2026-09 Dropship Orders and Accept Dropship Order APIs.
- Add `purchaseOrders.shipment(notice, options)` for ship notices, on the v1 API: Wayfair has no newer version.
- Wait for `Retry-After` and send the request again when Wayfair responds with a 429.
- Add a `supplierId` option, sent as the `WF-Supplier-Id` header. The 2026-09 APIs need it, since Wayfair's access tokens carry no supplier claim.
- Test the mandatory and recommended sandbox certification scenarios for both 2026-09 APIs against Wayfair's sandbox, except the PII-off half of the redacted PII scenario, which needs a second sandbox application without the PII permission.

## 0.1.2

- Describe the package as a client for the Wayfair API, which it will grow to cover, not only its dropship inventory API.

## 0.1.1

- Publish from the Publish workflow with npm trusted publishing. No code changes.

## 0.1.0

- Add Wayfair OAuth access tokens (`client_credentials`), cached in memory with memory-cache for 12 hours and dropped after a 401.
- Add `inventory.save(inventory, options)` for `DIFFERENTIAL` and `TRUE_UP` dropship inventory feeds, with `dryRun`.
- Throw `@stores.com/http-error` errors for non-success statuses and for GraphQL errors returned with a 200.
