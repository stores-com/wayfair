const cache = require('memory-cache');

const HttpError = require('@stores.com/http-error');

/**
 * A client for Wayfair's dropship inventory API. Method names follow Wayfair's GraphQL schema.
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
                    save(inventory: $inventory, feedKind: $feedKind, dryRun: $dryRun) {
                        completedAt
                        errorCount
                        errors {
                            key
                            message
                        }
                        handle
                        itemCount
                        status
                        submittedAt
                    }
                }
            }`;

            return (await request(mutation, { dryRun: options.dryRun, feedKind: options.feedKind, inventory }, options)).inventory.save;
        }
    };
}

module.exports = Wayfair;
