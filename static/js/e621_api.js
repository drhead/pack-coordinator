// @ts-check

import { getE621User } from './auth.js';

/**
 * Simple Token Bucket / Queue Rate Limiter to throttle API requests.
 */
class RateLimiter {
    /**
     * @param {number} maxTokens Maximum burst tokens available in bucket.
     * @param {number} refillIntervalMs Time in ms to add 1 token (e.g. 1000ms = 1 req/sec).
     */
    constructor(maxTokens = 1, refillIntervalMs = 1000) {
        this.maxTokens = maxTokens;
        this.tokens = maxTokens;
        this.refillIntervalMs = refillIntervalMs;
        this.lastRefill = Date.now();
        /** @type {Array<() => void>} */
        this.queue = [];
        this.timer = null;
    }

    /**
     * Refills tokens based on elapsed time.
     */
    _refill() {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        const tokensToAdd = Math.floor(elapsed / this.refillIntervalMs);

        if (tokensToAdd > 0) {
            this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
            this.lastRefill = now;
        }
    }

    /**
     * Processes any queued requests if tokens are available.
     */
    _processQueue() {
        this._refill();

        while (this.queue.length > 0 && this.tokens > 0) {
            this.tokens--;
            const resolveNext = this.queue.shift();
            if (resolveNext) resolveNext();
        }

        // If items remain in queue, schedule the next refill check
        if (this.queue.length > 0 && !this.timer) {
            this.timer = setTimeout(() => {
                this.timer = null;
                this._processQueue();
            }, this.refillIntervalMs);
        }
    }

    /**
     * Acquires a token, resolving when it's safe to proceed with the request.
     * @returns {Promise<void>}
     */
    acquire() {
        return new Promise(resolve => {
            this.queue.push(resolve);
            this._processQueue();
        });
    }
}

// Global instance: 1 request per second capacity
const e621RateLimiter = new RateLimiter(1, 1000);

/**
 * Rate-limited fetch wrapper that queues requests to comply with e621 rate limits.
 * 
 * @param {string | URL | Request} input
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
async function rateLimitedFetch(input, init) {
    await e621RateLimiter.acquire();
    return fetch(input, init);
}

/**
 * Builds standard e621 headers including User-Agent and Basic Auth.
 * @param {{ username?: string, apiKey?: string }} [overrideAuth] Optional explicit credentials (e.g. during login verification)
 * @returns {Record<string, string>}
 */
function getApiHeaders(overrideAuth) {
    const appAuthor = import.meta.env.VITE_E621_APP_AUTHOR || 'anonymous';
    const user = overrideAuth || getE621User();

    /** @type {Record<string, string>} */
    const headers = {
        'User-Agent': `E621CleanupCoordinator/1.0 (by ${appAuthor})`
    };

    if (user?.username && user?.apiKey) {
        const authString = btoa(`${user.username}:${user.apiKey}`);
        headers['Authorization'] = `Basic ${authString}`;
    }

    return headers;
}

/**
 * @typedef {Object} E621UserProfile
 * @property {number} id - The e621 user ID.
 * @property {string} name - The username on e621.
 * @property {string} [blacklisted_tags] - The user's blacklisted tags string (newline/space delimited).
 */

/**
 * Fetches the user profile info (including blacklisted_tags).
 * Can use logged-in user credentials or explicit credentials passed directly.
 * 
 * @param {{ username?: string, apiKey?: string }} [credentials]
 * @returns {Promise<E621UserProfile>} The raw user profile JSON object from e621.
 */
export async function fetchCurrentUserProfile(credentials) {
    const headers = getApiHeaders(credentials);
    
    // Check if auth header was set
    if (!headers['Authorization']) {
        throw new Error('You must provide credentials to fetch user profile data.');
    }

    const res = await rateLimitedFetch('https://e621.net/users/me.json', { headers });

    if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
            throw new Error('Invalid username or API key.');
        }
        throw new Error(`e621 API returned HTTP ${res.status}`);
    }

    return await res.json();
}

/**
 * Ensures a list of ClusterPost objects have their e621 metadata (fileUrl, description, sources) populated.
 * Posts that already have `fileUrl` set are skipped to avoid redundant API queries.
 * Modifies post objects in-place.
 * 
 * @param {Array<ClusterPost>} clusterPosts
 * @returns {Promise<void>}
 */
export function ensureClusterPostsInfo(clusterPosts) {
    if (!clusterPosts || clusterPosts.length === 0) return Promise.resolve();

    // 1. Filter out posts that already have fileUrl populated
    const missingPosts = clusterPosts.filter(post => !post.fileUrl && post.post_id);
    if (missingPosts.length === 0) return Promise.resolve();

    // 2. Map missing posts by ID for O(1) in-place mutation upon response
    /** @type {Map<number, ClusterPost>} */
    const missingMap = new Map();
    const idsToFetch = [];

    for (const post of missingPosts) {
        const numId = Number(post.post_id);
        if (!isNaN(numId)) {
            missingMap.set(numId, post);
            idsToFetch.push(numId);
        }
    }

    if (idsToFetch.length === 0) return Promise.resolve();

    const idsQuery = idsToFetch.join(',');
    const headers = getApiHeaders();

    // 3. Fetch missing details from e621
    return rateLimitedFetch(`https://e621.net/posts.json?tags=id:${idsQuery} status:any`, { headers })
        .then(res => {
            if (!res.ok) {
                throw new Error(`e621 API returned HTTP ${res.status}`);
            }
            return res.json();
        })
        .then(data => {
            for (const apiPost of (data.posts || [])) {
                const targetPost = missingMap.get(apiPost.id);
                if (targetPost) {
                    // Assign properties directly in-place
                    targetPost.fileUrl = apiPost.file?.url || '';
                    targetPost.description = apiPost.description || '';
                    targetPost.sources = Array.isArray(apiPost.sources) ? apiPost.sources : [];
                    targetPost.locked_tags = Array.isArray(apiPost.locked_tags) ? apiPost.locked_tags : [];
                }
            }
        });
}

/**
 * Fetches a single pool object from e621 by ID.
 * 
 * @param {number} poolId
 * @returns {Promise<Object>} The raw e621 pool object.
 */
async function _getPool(poolId) {
    const headers = getApiHeaders();
    const response = await rateLimitedFetch(`https://e621.net/pools.json?search[id]=${poolId}`, { headers });

    if (!response.ok) {
        throw new Error(`Failed to fetch pool #${poolId}: HTTP ${response.status}`);
    }

    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0) {
        throw new Error(`Pool #${poolId} not found.`);
    }

    return data[0];
}

/**
 * Sends a PUT request to e621 to update a pool's ordered list of post IDs.
 * 
 * @param {number} poolId
 * @param {Array<number>} postIds Space-delimited target post ID order.
 * @returns {Promise<Object>} The updated pool object returned by e621.
 */
async function _updatePoolPostIds(poolId, postIds) {
    const headers = getApiHeaders();
    headers['Content-Type'] = 'application/x-www-form-urlencoded';

    // Space-delimited string as required by e621 spec
    const postIdsString = postIds.join(' ');
    const body = new URLSearchParams({
        'pool[post_ids]': postIdsString
    });

    const response = await rateLimitedFetch(`https://e621.net/pools/${poolId}.json`, {
        method: 'PUT',
        headers,
        body
    });

    if (!response.ok) {
        throw new Error(`Failed to update pool #${poolId}: HTTP ${response.status}`);
    }

    return await response.json();
}

/**
 * @typedef {Object} PoolSubstitution
 * @property {number} originalPostId - The post ID expected to currently be in the pool.
 * @property {number} replacementPostId - The post ID to swap into its place.
 */

/**
 * Replaces specific post IDs within an existing e621 pool while maintaining ordering.
 * 
 * @param {number} poolId
 * @param {Array<PoolSubstitution>} substitutions List of objects with `{ originalPostId, replacementPostId }`
 * @returns {Promise<Object>} The updated pool response from e621.
 */
export async function substitutePoolPosts(poolId, substitutions) {
    if (!substitutions || substitutions.length === 0) {
        throw new Error('No substitutions provided.');
    }

    // 1. Fetch current pool state to get exact post_ids array
    const pool = await _getPool(poolId);
    /** @type {Array<number>} */
    // @ts-expect-error
    const currentPostIds = pool.post_ids || [];

    // 2. Map substitutions for O(1) lookup
    /** @type {Map<number, number>} */
    const subMap = new Map();
    for (const sub of substitutions) {
        subMap.set(sub.originalPostId, sub.replacementPostId);
    }

    // 3. Validate that ALL target original post IDs exist in the pool before proceeding
    for (const originalId of subMap.keys()) {
        if (!currentPostIds.includes(originalId)) {
            throw new Error(`Cannot substitute in pool #${poolId}: Post #${originalId} was not found in the pool.`);
        }
    }

    // 4. Perform in-place substitutions maintaining existing order
    const updatedPostIds = currentPostIds.map(id => {
        return subMap.has(id) ? /** @type {number} */ (subMap.get(id)) : id;
    });

    // 5. Submit updated list to e621 API
    return await _updatePoolPostIds(poolId, updatedPostIds);
}