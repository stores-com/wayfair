# Changelog

## 0.1.0

- Add Wayfair OAuth access tokens (`client_credentials`), cached in memory with memory-cache for 12 hours and dropped after a 401.
- Add `inventory.save(inventory, options)` for `DIFFERENTIAL` and `TRUE_UP` dropship inventory feeds, with `dryRun`.
- Throw `@stores.com/http-error` errors for non-success statuses and for GraphQL errors returned with a 200.
