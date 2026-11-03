const timers = require('node:timers/promises');

const cache = require('memory-cache');

const HttpError = require('@stores.com/http-error');

// Fields of a PostalAddress. Without the orders:read-dropship-orders-pii permission, Wayfair nulls all but city, country and state.
const postalAddressFields = `
    address1
    address2
    address3
    city
    country
    email
    name
    phoneNumber
    postalCode
    state`;

// Fields of a SupplierDropshipOrder, which dropshipOrders and acceptDropshipOrder both return
const dropshipOrderFields = `
    billingAddress {${postalAddressFields}
    }
    createdAt
    customer {${postalAddressFields}
    }
    customerOrderId
    lineItems {
        actualShipDate
        customComment
        deliveryDate
        event {
            endDate
            id
            name
            startDate
            type
        }
        isTscaCompliant
        listingId
        name
        orderValue {
            amount
            currencyCode
        }
        pieceCount
        quantity
        status
        supplierPartNumber
        tasks {
            requestedShippingAddress {${postalAddressFields}
            }
            requestedShipSpeed
            status
            taskType
        }
        totalWeight {
            unit
            value
        }
        unitPrice {
            amount
            currencyCode
        }
        weight {
            unit
            value
        }
    }
    mustShipByDate
    origin {
        displayName
        marketContext {
            brand
            channel
            country
            locale
            segment
        }
    }
    purchaseOrderNumber
    shippingAddress {${postalAddressFields}
    }
    shippingInfo {
        carrierCode
        crossDockAgent {
            id
            name
        }
        deliveryAgent {
            id
            name
        }
        poolPointAgent {
            id
            name
        }
        shipSpeed
    }
    status
    tasks {
        requestedShippingAddress {${postalAddressFields}
        }
        requestedShipSpeed
        status
        taskType
    }
    warehouseDetails {
        address {${postalAddressFields}
        }
        id
    }`;

// Fields Wayfair returns for an inventory feed or a ship notice
const transactionStatusFields = `
    completedAt
    errorCount
    errors {
        key
        message
    }
    handle
    itemCount
    status
    submittedAt`;

/**
 * A client for the Wayfair API. Method names follow Wayfair's GraphQL schema.
 *
 * @param {Object} args - Client options.
 * @param {string} args.client_id - Client ID of an application from Wayfair's Developer Portal (Application Management).
 * @param {string} args.client_secret - The application's client secret.
 * @param {boolean} [args.sandbox=false] - Use Wayfair's sandbox, with a sandbox application.
 * @param {number} [args.supplierId] - Your supplier ID, sent as the WF-Supplier-Id header, which the 2026-09 APIs need when the access token carries no supplier claim.
 * @param {number} [args.timeout=30000] - Request timeout in milliseconds.
 * @see https://developer.wayfair.io/posts/introduction
 * @example
 * const wayfair = new Wayfair({ client_id: process.env.WAYFAIR_CLIENT_ID, client_secret: process.env.WAYFAIR_CLIENT_SECRET });
 */
function Wayfair(args) {
    const _options = {
        timeout: 30000,
        ...args
    };

    const baseUrl = _options.sandbox ? 'https://sandbox.api.wayfair.com' : 'https://api.wayfair.com';
    const accessTokenKey = `wayfair:${_options.client_id}:${baseUrl}`;
    // The 2026-09 GraphQL endpoint dropshipOrders and acceptDropshipOrder share
    const dropshipOrdersUrl = `https://api.wayfair.io/${_options.sandbox ? 'sandbox/' : ''}2026-09/dropship-orders/graphql`;

    /**
     * Send a GraphQL query or mutation to one of Wayfair's GraphQL endpoints with an access token. When Wayfair responds with a 429, this waits as many seconds as Retry-After says (1 if it's missing) and sends the same request again.
     *
     * @private
     * @param {string} url - The GraphQL endpoint: v1 or 2026-09.
     * @param {string} query - GraphQL query or mutation.
     * @param {Object} variables - GraphQL variables.
     * @param {Object} [options] - Per-call options.
     * @param {number} [options.timeout] - Override the client timeout in milliseconds.
     * @returns {Promise<Object>} The response's data.
     * @throws {HttpError} For non-success HTTP statuses, and for GraphQL errors, which Wayfair returns with a 200. That includes a FORBIDDEN_SCOPE advisory for PII fields selected without the PII permission; err.json.data still holds the data.
     */
    const request = async (url, query, variables, options = {}) => {
        const accessToken = await this.getAccessToken(options);

        const response = await fetch(url, {
            body: JSON.stringify({ query, variables }),
            headers: {
                Authorization: `Bearer ${accessToken.access_token}`,
                'Content-Type': 'application/json',
                ...(_options.supplierId && { 'WF-Supplier-Id': _options.supplierId })
            },
            method: 'POST',
            signal: AbortSignal.timeout(options.timeout || _options.timeout)
        });

        if (response.status === 429) {
            await timers.setTimeout((Number(response.headers.get('Retry-After')) || 1) * 1000);

            return request(url, query, variables, options);
        }

        if (!response.ok) {
            // The token was revoked or expired early, so the next request gets a new one
            if (response.status === 401) {
                cache.del(accessTokenKey);
            }

            throw await HttpError.from(response);
        }

        const json = await response.json();

        if (json.errors?.length) {
            throw await HttpError.from(response, json);
        }

        return json.data;
    };

    /**
     * Accept a whole dropship purchase order at its ordered quantities: the API's version of Acknowledge in Partner Home. shipSpeed, when given, must match the purchase order's; it never changes it.
     *
     * Wayfair answers a refusal with a 200, purchaseOrder null and errors, which this returns rather than throws. Branch on errors[].__typename: AcceptDropshipOrderStatusNotNewError (already accepted), AcceptDropshipOrderPurchaseOrderCancelledError and AcceptDropshipOrderOrderIsReplacementPartError all have the CONFLICT code; AcceptDropshipOrderInvalidShipSpeedError and AcceptDropshipOrderInvalidOrderNumberError are BAD_USER_INPUT; AcceptDropshipOrderNotFoundError is NOT_FOUND.
     *
     * Wayfair allows 2 calls a second and 120 a minute per supplier (5 a second and 20 a minute in the sandbox), shared by dropshipOrders and any other application for the same supplier. The sandbox answers from a fixed table of purchase order numbers.
     *
     * Every field of purchaseOrder is selected. Without the orders:read-dropship-orders-pii permission, Wayfair nulls every address field but city, country and state and adds a FORBIDDEN_SCOPE error, so this throws even though the order was accepted; err.json.data.acceptDropshipOrder still holds the result.
     *
     * @param {Object} input - The AcceptDropshipOrderInput.
     * @param {string} input.purchaseOrderNumber - The purchase order number, e.g. 'CS690310954'.
     * @param {string} [input.shipSpeed] - The purchase order's ship speed, e.g. 'GROUND', to confirm it.
     * @param {Object} [options] - Per-call options.
     * @param {number} [options.timeout] - Override the client timeout in milliseconds.
     * @returns {Promise<Object>} The AcceptDropshipOrderPayload: { errors: [{ __typename, classification, code, message, path, purchaseOrderNumber, requestId, retryable }], purchaseOrder }. On success, purchaseOrder has the same fields as a dropshipOrders order, with status typically PROCESSING, and errors is empty.
     * @throws {HttpError} If Wayfair rejects the request, such as for invalid input, fails it, or adds a FORBIDDEN_SCOPE error.
     * @see https://developer.wayfair.io/posts/accept-dropship-order-api-2026-09
     * @example
     * const result = await wayfair.acceptDropshipOrder({ purchaseOrderNumber: 'CS690310954' });
     */
    this.acceptDropshipOrder = async (input, options = {}) => {
        const mutation = `mutation AcceptDropshipOrder($input: AcceptDropshipOrderInput!) {
            acceptDropshipOrder(input: $input) {
                errors {
                    __typename
                    ... on AcceptDropshipOrderInvalidOrderNumberError {
                        purchaseOrderNumber
                    }
                    ... on AcceptDropshipOrderInvalidShipSpeedError {
                        purchaseOrderNumber
                    }
                    ... on AcceptDropshipOrderNotFoundError {
                        purchaseOrderNumber
                    }
                    ... on AcceptDropshipOrderOrderIsReplacementPartError {
                        purchaseOrderNumber
                    }
                    ... on AcceptDropshipOrderPurchaseOrderCancelledError {
                        purchaseOrderNumber
                    }
                    ... on AcceptDropshipOrderStatusNotNewError {
                        purchaseOrderNumber
                    }
                    ... on SupplierStandardError {
                        classification
                        code
                        message
                        path
                        requestId
                        retryable
                    }
                }
                purchaseOrder {${dropshipOrderFields}
                }
            }
        }`;

        return (await request(dropshipOrdersUrl, mutation, { input }, options)).acceptDropshipOrder;
    };

    /**
     * Get dropship purchase orders, newest first unless sort says otherwise. Each edge's node is a SupplierDropshipOrder, or a SupplierDropshipOrderIssue for a purchase order Wayfair couldn't return, such as NOT_FOUND for an unknown one in filter.purchaseOrderNumbers; __typename tells them apart, and an issue doesn't fail the page.
     *
     * Wayfair returns at most 250 orders per call and allows 2 calls a second and 120 a minute per supplier (5 a second and 20 a minute in the sandbox), shared by acceptDropshipOrder and any other application for the same supplier. A createdAt window can be at most 30 days wide and start at most 180 days ago. Cursors expire after 24 hours and only work with the filter and sort that issued them.
     *
     * Every field is selected. Without the orders:read-dropship-orders-pii permission, Wayfair nulls every address field but city, country and state and adds a FORBIDDEN_SCOPE error, so this throws; err.json.data.dropshipOrders still holds the page. With autoPagination, it throws on the first page, so that's the only page it holds.
     *
     * @param {Object} [variables] - Query arguments.
     * @param {string} [variables.after] - Page forward from this pageInfo.endCursor.
     * @param {string} [variables.before] - Page backward from this pageInfo.startCursor, with last.
     * @param {Object} [variables.filter] - The SupplierDropshipOrderFilterInput: { createdAt: { from, to }, lineItemStatus, orderStatus, orderTasks, purchaseOrderNumbers }. Fields combine with AND, and the values in each with OR.
     * @param {number} [variables.first] - Orders per page, paging forward: 1 to 250. Wayfair's default is 50, and 250 with autoPagination.
     * @param {number} [variables.last] - Orders per page, paging backward: 1 to 250.
     * @param {Object} [variables.sort] - { direction: 'ASC' or 'DESC', field: 'CREATED_AT' }. Wayfair's default is CREATED_AT DESC.
     * @param {Object} [options] - Per-call options.
     * @param {boolean} [options.autoPagination=false] - Page forward through every page, following pageInfo.endCursor. Can't be combined with last or before.
     * @param {number} [options.timeout] - Override the client timeout in milliseconds.
     * @returns {Promise<Object>} The SupplierDropshipOrderConnection: { edges: [{ cursor, node }], pageInfo: { endCursor, hasNextPage, hasPreviousPage, startCursor } }. With autoPagination, edges has every page's edges and pageInfo is the last page's.
     * @throws {HttpError} If Wayfair responds with an error, including FORBIDDEN_SCOPE.
     * @see https://developer.wayfair.io/posts/dropship-orders-api-2026-09
     * @example
     * const dropshipOrders = await wayfair.dropshipOrders({ filter: { orderStatus: ['NEW'] } }, { autoPagination: true });
     */
    this.dropshipOrders = async (variables = {}, options = {}) => {
        const query = `query GetDropshipOrders($after: String, $before: String, $filter: SupplierDropshipOrderFilterInput, $first: Int, $last: Int, $sort: SupplierDropshipOrderSortInput) {
            dropshipOrders(after: $after, before: $before, filter: $filter, first: $first, last: $last, sort: $sort) {
                edges {
                    cursor
                    node {
                        __typename
                        ... on SupplierDropshipOrder {${dropshipOrderFields}
                        }
                        ... on SupplierDropshipOrderIssue {
                            classification
                            code
                            message
                            path
                            purchaseOrderNumber
                            remediation
                            requestId
                            retryable
                        }
                    }
                }
                pageInfo {
                    endCursor
                    hasNextPage
                    hasPreviousPage
                    startCursor
                }
            }
        }`;

        const fetchPages = async (pageVariables) => {
            const page = (await request(dropshipOrdersUrl, query, pageVariables, options)).dropshipOrders;

            if (!options.autoPagination || !page.pageInfo.hasNextPage) {
                return page;
            }

            const nextPages = await fetchPages({ ...pageVariables, after: page.pageInfo.endCursor });

            return { edges: page.edges.concat(nextPages.edges), pageInfo: nextPages.pageInfo };
        };

        return fetchPages(options.autoPagination ? { ...variables, first: variables.first || 250 } : variables);
    };

    /**
     * Get an OAuth access token using the client_credentials grant. Tokens last 24 hours; each is cached in memory (memory-cache) for 12, as Wayfair recommends, so repeat calls return the same token until then.
     *
     * @param {Object} [options] - Per-call options.
     * @param {number} [options.timeout] - Override the client timeout in milliseconds.
     * @returns {Promise<{ access_token: string, expires_in: number, token_type: string }>} The token response.
     * @throws {HttpError} If Wayfair refuses the credentials.
     * @see https://developer.wayfair.io/posts/api-access-tokens
     * @example
     * const accessToken = await wayfair.getAccessToken();
     */
    this.getAccessToken = async (options = {}) => {
        const accessToken = cache.get(accessTokenKey);

        if (accessToken) {
            return accessToken;
        }

        const response = await fetch('https://sso.auth.wayfair.com/oauth/token', {
            body: JSON.stringify({
                audience: `${baseUrl}/`,
                client_id: _options.client_id,
                client_secret: _options.client_secret,
                grant_type: 'client_credentials'
            }),
            headers: {
                'Content-Type': 'application/json'
            },
            method: 'POST',
            signal: AbortSignal.timeout(options.timeout || _options.timeout)
        });

        if (!response.ok) {
            throw await HttpError.from(response);
        }

        const json = await response.json();

        cache.put(accessTokenKey, json, Number(json.expires_in) * 1000 / 2);

        return json;
    };

    this.inventory = {
        /**
         * Send a dropship inventory feed. A TRUE_UP feed is a complete listing and is required at least once every 24 hours; a DIFFERENTIAL feed (Wayfair's default) has only the products whose quantities changed, ideally every 30 minutes. The sandbox only takes TRUE_UP feeds, truncated at 500 rows.
         *
         * Wayfair processes the feed after responding. Rows it rejects come back in errors, and it still saves the rest. This is Wayfair's v1 API, which has no newer version.
         *
         * @param {Array.<Object>} inventory - Rows: { quantityOnHand, supplierId, supplierPartNumber } plus any optional inventoryInput fields (discontinued, itemNextAvailabilityDate, productNameAndOptions, quantityBackordered, quantityOnOrder).
         * @param {Object} [options] - Feed and per-call options.
         * @param {boolean} [options.dryRun] - Validate the feed without saving it.
         * @param {string} [options.feedKind] - 'DIFFERENTIAL' or 'TRUE_UP'.
         * @param {number} [options.timeout] - Override the client timeout in milliseconds.
         * @returns {Promise<Object>} The transaction status ({ completedAt, errorCount, errors: [{ key, message }], handle, itemCount, status, submittedAt }).
         * @throws {HttpError} If Wayfair rejects the whole feed.
         * @see https://developer.wayfair.io/posts/dropship-inventory
         * @example
         * const status = await wayfair.inventory.save([{ quantityOnHand: 7, supplierId: 457479, supplierPartNumber: '272687' }], { feedKind: 'TRUE_UP' });
         */
        save: async (inventory, options = {}) => {
            const mutation = `mutation saveInventory($dryRun: Boolean, $feedKind: inventoryFeedKind, $inventory: [inventoryInput]!) {
                inventory {
                    save(inventory: $inventory, feedKind: $feedKind, dryRun: $dryRun) {${transactionStatusFields}
                    }
                }
            }`;

            return (await request(`${baseUrl}/v1/graphql`, mutation, { dryRun: options.dryRun, feedKind: options.feedKind, inventory }, options)).inventory.save;
        }
    };

    this.purchaseOrders = {
        /**
         * Send a ship notice (ASN) for a dropship purchase order, as soon as it leaves the warehouse. shipDate can be up to 10 days in the past and 1 day in the future.
         *
         * Wayfair processes the notice after responding, and takes the same notice again without an error, so send each one once. It allows one notice every 3 seconds, with up to 10 line items each. This is Wayfair's v1 API, which has no newer version. From a dropshipOrders order: poNumber is purchaseOrderNumber, supplierId is warehouseDetails.id (the warehouse it ships from), shipSpeed is shippingInfo.shipSpeed (which can be null, or EXPRESS or a BIG_AND_BULKY_* speed v1 doesn't have), destinationAddress is shippingAddress, sourceAddress is warehouseDetails.address (address1 and address2 become streetAddress1 and streetAddress2), and each item's partNumber is a line item's supplierPartNumber.
         *
         * @param {Object} notice - The ShipNoticeInput: carrierCode, destinationAddress, packageCount, poNumber, shipDate, shipSpeed, sourceAddress, supplierId, trackingNumber, and smallParcelShipments or largeParcelShipments.
         * @param {Object} [options] - Per-call options.
         * @param {number} [options.timeout] - Override the client timeout in milliseconds.
         * @returns {Promise<Object>} The transaction status.
         * @throws {HttpError} If Wayfair responds with an error.
         * @see https://developer.wayfair.io/posts/dropship-orders-asn
         * @example
         * const status = await wayfair.purchaseOrders.shipment({ carrierCode: 'FDEG', poNumber: 'CS690310954', supplierId: 457479, trackingNumber: '794600000000', ... });
         */
        shipment: async (notice, options = {}) => {
            const mutation = `mutation shipment($notice: ShipNoticeInput!) {
                purchaseOrders {
                    shipment(notice: $notice) {${transactionStatusFields}
                    }
                }
            }`;

            return (await request(`${baseUrl}/v1/graphql`, mutation, { notice }, options)).purchaseOrders.shipment;
        }
    };
}

module.exports = Wayfair;
