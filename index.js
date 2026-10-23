const timers = require('node:timers/promises');

const cache = require('memory-cache');

const HttpError = require('@stores.com/http-error');

// Fields Wayfair returns for an inventory feed
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
 * A client for Wayfair's supplier APIs. Method names follow Wayfair's GraphQL schema.
 *
 * @param {Object} args - Client options.
 * @param {string} args.client_id - Client ID of an application from Wayfair's Developer Portal (Application Management).
 * @param {string} args.client_secret - The application's client secret.
 * @param {number} [args.timeout=30000] - Request timeout in milliseconds.
 * @param {string} [args.url='https://api.wayfair.com'] - API base URL. Use https://sandbox.api.wayfair.com with a sandbox application.
 * @see https://developer.wayfair.io/posts/introduction
 * @example
 * const wayfair = new Wayfair({ client_id: process.env.WAYFAIR_CLIENT_ID, client_secret: process.env.WAYFAIR_CLIENT_SECRET });
 */
function Wayfair(args) {
    const _options = {
        timeout: 30000,
        url: 'https://api.wayfair.com',
        ...args
    };

    const baseUrl = _options.url.replace(/\/+$/, '');
    const accessTokenKey = `wayfair:${_options.client_id}:${baseUrl}`;

    /**
     * Send a GraphQL query or mutation to Wayfair's API with an access token.
     *
     * @private
     * @param {string} query - GraphQL query or mutation.
     * @param {Object} variables - GraphQL variables.
     * @param {Object} [options] - Per-call options.
     * @param {number} [options.timeout] - Override the client timeout in milliseconds.
     * @returns {Promise<Object>} The response's data.
     * @throws {HttpError} For non-success HTTP statuses, and for GraphQL errors, which Wayfair returns with a 200.
     */
    const request = async (query, variables, options = {}) => {
        const accessToken = await this.getAccessToken(options);

        const response = await fetch(`${baseUrl}/v1/graphql`, {
            body: JSON.stringify({ query, variables }),
            headers: {
                Authorization: `Bearer ${accessToken.access_token}`,
                'Content-Type': 'application/json'
            },
            method: 'POST',
            signal: AbortSignal.timeout(options.timeout || _options.timeout)
        });

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

    /**
     * Get dropship purchase orders. Leave out hasResponse to get open and accepted purchase orders alike.
     *
     * Wayfair returns at most 25 per call and allows one call every 3 seconds. With autoPagination, this pages through every purchase order from fromDate on, oldest first, 3 seconds apart. Wayfair has no paging cursor, so each page starts at the last page's newest poDate; if more than 25 purchase orders share one poDate, the ones after the 25th are missed.
     *
     * products.isCancelled is left out in the sandbox, which doesn't have it.
     *
     * @param {Object} [variables] - Query arguments.
     * @param {Date|string} [variables.fromDate] - Earliest purchase order date. A string must be in Wayfair's format, e.g. 2026-05-01 00:00:00.000000 +00:00.
     * @param {boolean} [variables.hasResponse] - false for open purchase orders, true for accepted ones.
     * @param {number} [variables.limit] - Purchase orders per call: Wayfair's default is 10, and 25 with autoPagination.
     * @param {Array.<string>} [variables.poNumbers] - Only these purchase orders.
     * @param {string} [variables.sortOrder] - 'ASC' or 'DESC' by poDate. Always 'ASC' with autoPagination.
     * @param {Object} [options] - Per-call options.
     * @param {boolean} [options.autoPagination=false] - Page through every purchase order from fromDate on.
     * @param {number} [options.timeout] - Override the client timeout in milliseconds.
     * @returns {Promise<Array.<Object>>} The purchase orders.
     * @throws {HttpError} If Wayfair responds with an error.
     * @see https://developer.wayfair.io/posts/docs/orders-api/reference/GraphQL/v1.0.0
     * @example
     * const purchaseOrders = await wayfair.getDropshipPurchaseOrders({ fromDate: new Date('2026-10-01') }, { autoPagination: true });
     */
    this.getDropshipPurchaseOrders = async (variables = {}, options = {}) => {
        const query = `query getDropshipPurchaseOrders($fromDate: IsoDateTime, $hasResponse: Boolean, $limit: Int32, $poNumbers: [String], $sortOrder: SortOrder) {
            getDropshipPurchaseOrders(fromDate: $fromDate, hasResponse: $hasResponse, limit: $limit, poNumbers: $poNumbers, sortOrder: $sortOrder) {
                billingInfo {
                    vatNumber
                }
                billTo {
                    address1
                    address2
                    address3
                    city
                    country
                    name
                    phoneNumber
                    postalCode
                    state
                }
                customerAddress1
                customerAddress2
                customerCity
                customerCountry
                customerEmail
                customerName
                customerPostalCode
                customerState
                deliveryMethodCode
                estimatedShipDate
                id
                orderId
                orderType
                packingSlipUrl
                poDate
                poNumber
                products {
                    customComment
                    estShipDate
                    event {
                        endDate
                        id
                        name
                        startDate
                        type
                    }
                    fillDate
                    ${baseUrl.includes('sandbox') ? '' : 'isCancelled'}
                    isTscaCompliant
                    name
                    partNumber
                    pieceCount
                    price
                    quantity
                    sku
                    totalCost
                    totalWeight
                    twoDayGuaranteeDeliveryDeadline
                    weight
                }
                salesChannelName
                scheduledDeliveryDate
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
                shipTo {
                    address1
                    address2
                    address3
                    city
                    country
                    name
                    phoneNumber
                    postalCode
                    state
                }
                storePrefix
                supplierAddress1
                supplierAddress2
                supplierAddress3
                supplierCity
                supplierId
                supplierName
                supplierPostalCode
                supplierState
                warehouse {
                    address {
                        address1
                        address2
                        address3
                        city
                        country
                        name
                        phoneNumber
                        postalCode
                        state
                    }
                    id
                    name
                    supplier {
                        currency
                        id
                        name
                        shortName
                        status
                        websiteURL
                    }
                }
            }
        }`;

        const pageVariables = { ...variables };

        // Wayfair's date format, e.g. 2026-05-01 00:00:00.123000 +00:00
        if (variables.fromDate instanceof Date) {
            pageVariables.fromDate = `${variables.fromDate.toISOString().replace('T', ' ').replace('Z', '')}000 +00:00`;
        }

        if (options.autoPagination) {
            pageVariables.limit = variables.limit || 25;
            pageVariables.sortOrder = 'ASC';
        }

        const purchaseOrders = new Map();

        // Wayfair has no paging cursor, so the next page starts at this page's newest poDate (which returns that purchase order again)
        const fetchPurchaseOrders = async (fromDate) => {
            const page = (await request(query, { ...pageVariables, fromDate }, options)).getDropshipPurchaseOrders;
            const count = purchaseOrders.size;

            page.forEach(po => purchaseOrders.set(po.poNumber, po));

            // A full page that brought new purchase orders may have more after it
            if (options.autoPagination && page.length === pageVariables.limit && purchaseOrders.size > count) {
                // Wayfair allows one request every 3 seconds
                await timers.setTimeout(3000);
                await fetchPurchaseOrders(page[page.length - 1].poDate);
            }
        };

        await fetchPurchaseOrders(pageVariables.fromDate);

        return Array.from(purchaseOrders.values());
    };

    this.inventory = {
        /**
         * Send a dropship inventory feed. A TRUE_UP feed is a complete listing and is required at least once every 24 hours; a DIFFERENTIAL feed (Wayfair's default) has only the products whose quantities changed, ideally every 30 minutes. The sandbox only takes TRUE_UP feeds, truncated at 500 rows.
         *
         * Wayfair processes the feed after responding. Rows it rejects come back in errors, and it still saves the rest.
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
         * const status = await wayfair.inventory.save([{ quantityOnHand: 7, supplierId: 199492, supplierPartNumber: '272687' }], { feedKind: 'TRUE_UP' });
         */
        save: async (inventory, options = {}) => {
            const mutation = `mutation saveInventory($dryRun: Boolean, $feedKind: inventoryFeedKind, $inventory: [inventoryInput]!) {
                inventory {
                    save(inventory: $inventory, feedKind: $feedKind, dryRun: $dryRun) {${transactionStatusFields}
                    }
                }
            }`;

            return (await request(mutation, { dryRun: options.dryRun, feedKind: options.feedKind, inventory }, options)).inventory.save;
        }
    };
}

module.exports = Wayfair;
