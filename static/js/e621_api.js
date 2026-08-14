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

    // 1. Filter out posts that already have fileUrl defined (null indicates it was fetched but post is deleted/has no image URL)
    const missingPosts = clusterPosts.filter(post =>
        post.fileUrl === undefined && post.post_id
    );
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
                    // Assign properties directly in-place; set fileUrl to apiPost.file?.url or null if deleted/missing
                    targetPost.fileUrl = apiPost.file?.url || null;
                    targetPost.description = apiPost.description || '';
                    targetPost.sources = Array.isArray(apiPost.sources) ? apiPost.sources : [];
                    targetPost.locked_tags = Array.isArray(apiPost.locked_tags) ? apiPost.locked_tags : [];
                    if (apiPost.flags?.deleted || apiPost.is_deleted) {
                        targetPost.is_deleted = true;
                    }
                }
            }

            // For any requested post IDs that e621 API did not return or returned without URL,
            // set fileUrl to null so we don't re-query them.
            for (const id of idsToFetch) {
                const targetPost = missingMap.get(id);
                if (targetPost && targetPost.fileUrl === undefined) {
                    targetPost.fileUrl = null;
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

    const text = await response.text();
    if (!text || text.trim() === '') {
        return { success: true, poolId };
    }

    try {
        return JSON.parse(text);
    } catch (_) {
        return { success: true, poolId };
    }
}

/**
 * Submits an "inferior" duplicate flag for a post to e621.
 * 
 * @param {number} postId The post ID being flagged.
 * @param {number} parentId The ID of the superior/kept post.
 * @param {string} [note] Optional note detailing the flag context.
 * @returns {Promise<Object>} Response object from e621.
 */
async function _flagPostInferior(postId, parentId, note = '') {
    if (!postId || !parentId) {
        throw new Error('Both postId and parentId are required to flag a post as inferior.');
    }

    const headers = getApiHeaders();
    headers['Content-Type'] = 'application/x-www-form-urlencoded';

    const params = new URLSearchParams({
        'post_flag[post_id]': String(postId),
        'post_flag[reason_name]': 'inferior',
        'post_flag[parent_id]': String(parentId)
    });

    if (note && note.trim().length > 0) {
        params.append('post_flag[note]', note.trim());
    }

    const response = await rateLimitedFetch('https://e621.net/post_flags.json', {
        method: 'POST',
        headers,
        body: params
    });

    if (!response.ok) {
        let errDetail = `HTTP ${response.status}`;
        try {
            const errData = await response.json();
            if (errData?.errors) {
                if (Array.isArray(errData.errors)) {
                    errDetail = errData.errors.join(', ');
                } else if (typeof errData.errors === 'object') {
                    const messages = [];
                    for (const [key, val] of Object.entries(errData.errors)) {
                        messages.push(`${key}: ${Array.isArray(val) ? val.join(', ') : val}`);
                    }
                    if (messages.length > 0) errDetail = messages.join('; ');
                }
            } else if (errData?.message) {
                errDetail = errData.message;
            }
        } catch (_) {
            // fallback
        }
        if (response.status === 429) {
            errDetail = `Rate limit reached (20 flags/hour max). ${errDetail}`;
        }
        throw new Error(errDetail);
    }

    return await response.json();
}

/**
 * Sends a PATCH request to e621 to update post metadata using old/new comparison fields.
 * 
 * @param {number} postId ID of the post to update.
 * @param {Object} edits Object containing parameter changes.
 * @param {string} [edits.tag_string] New space-delimited tags string.
 * @param {string} [edits.old_tag_string] Previous space-delimited tags string.
 * @param {string} [edits.source] New newline-delimited sources string.
 * @param {string} [edits.old_source] Previous newline-delimited sources string.
 * @param {string} [edits.description] New description string.
 * @param {string} [edits.old_description] Previous description string.
 * @param {string} [edits.rating] New rating ('s', 'q', 'e').
 * @param {string} [edits.old_rating] Previous rating.
 * @param {number|string} [edits.parent_id] New parent post ID.
 * @param {number|string} [edits.old_parent_id] Previous parent post ID.
 * @param {string} [edits.edit_reason] Reason for edits.
 * @returns {Promise<Object>} Updated post object returned by e621.
 */
async function _updatePost(postId, edits) {
    if (!postId) {
        throw new Error('Post ID is required to update a post.');
    }

    const headers = getApiHeaders();
    headers['Content-Type'] = 'application/x-www-form-urlencoded';

    const params = new URLSearchParams();

    // Map provided parameters to e621 post form keys
    const fieldMap = {
        tag_string: 'post[tag_string]',
        old_tag_string: 'post[old_tag_string]',
        source: 'post[source]',
        old_source: 'post[old_source]',
        description: 'post[description]',
        old_description: 'post[old_description]',
        rating: 'post[rating]',
        old_rating: 'post[old_rating]',
        parent_id: 'post[parent_id]',
        old_parent_id: 'post[old_parent_id]',
        edit_reason: 'post[edit_reason]'
    };

    let hasChanges = false;
    for (const [key, formKey] of Object.entries(fieldMap)) {
        if (edits[key] !== undefined && edits[key] !== null) {
            const val = String(edits[key]);
            // Omit blank old_* comparison parameters to match e621 web form behavior
            if (key.startsWith('old_') && val.trim() === '') {
                continue;
            }
            params.append(formKey, val);
            hasChanges = true;
        }
    }

    if (!hasChanges) {
        throw new Error(`No change fields provided for post #${postId}.`);
    }

    const response = await rateLimitedFetch(`https://e621.net/posts/${postId}.json`, {
        method: 'PATCH',
        headers,
        body: params
    });

    if (!response.ok) {
        throw new Error(`Failed to update post #${postId}: HTTP ${response.status}`);
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

/**
 * Submits an inferior duplicate flag for a non-canonical ResolutionPost.
 * 
 * @param {ResolutionPost} resPost The resolution post state containing flag details.
 * @param {number} superiorPostId The post ID to mark as superior/parent in the flag.
 * @returns {Promise<Object>} Response object from e621.
 */
export async function flagResolutionPostInferior(resPost, superiorPostId) {
    if (!resPost || !resPost.original?.post_id) {
        throw new Error('Invalid ResolutionPost provided for flagging.');
    }

    const postId = Number(resPost.original.post_id);
    return await _flagPostInferior(postId, superiorPostId, resPost.flag_note);
}

/**
 * Evaluates changes on a ResolutionPost and submits a PATCH update to e621 if edits exist.
 * 
 * @param {ResolutionPost} resPost The resolution post containing proposed changes.
 * @param {string} [editReason='Edited from P.A.C.K. Editor'] Audit message for the edit.
 * @returns {Promise<Object|null>} Updated e621 response object, or `null` if no changes were detected.
 */
export async function applyResolutionPostEdits(resPost, editReason = 'Edited from P.A.C.K. Editor') {
    if (!resPost || !resPost.original?.post_id) {
        throw new Error('Invalid ResolutionPost provided for edit submission.');
    }

    const original = resPost.original;
    const postId = Number(original.post_id);
    /** @type {Record<string, any>} */
    const edits = {};

    // 1. Tags Diff
    const origTags = Array.isArray(original.tags) ? original.tags : [];
    const currentTags = Array.isArray(resPost.tags) ? resPost.tags : [];
    if (origTags.join(' ') !== currentTags.join(' ')) {
        const oldTagStr = origTags.join(' ').trim();
        if (oldTagStr) edits.old_tag_string = oldTagStr;
        edits.tag_string = currentTags.join(' ');
    }

    // 2. Sources Diff (Use \r\n CRLF to match e621 web form behavior)
    const origSources = Array.isArray(original.sources) ? original.sources : [];
    const currentSources = Array.isArray(resPost.sources) ? resPost.sources : [];
    if (origSources.join('\r\n') !== currentSources.join('\r\n')) {
        const oldSourceStr = origSources.join('\r\n').trim();
        if (oldSourceStr) edits.old_source = oldSourceStr;
        edits.source = currentSources.join('\r\n');
    }

    // 3. Description Diff (Omit old_description if blank)
    const origDesc = original.description ?? '';
    const currentDesc = resPost.description ?? '';
    if (origDesc !== currentDesc) {
        const oldDescStr = origDesc.trim();
        if (oldDescStr) edits.old_description = oldDescStr;
        edits.description = currentDesc;
    }

    // 4. Rating Diff (Omit old_rating if blank)
    if (resPost.rating !== null && resPost.rating !== original.rating) {
        if (original.rating) edits.old_rating = original.rating;
        edits.rating = resPost.rating;
    }

    // 5. Parent ID Diff (Omit old_parent_id if blank)
    const origParent = original.parent_id ?? null;
    const currentParent = resPost.parent_id ?? null;
    if (origParent !== currentParent) {
        if (origParent !== null && String(origParent).trim() !== '') {
            edits.old_parent_id = origParent;
        }
        edits.parent_id = currentParent !== null ? currentParent : '';
    }

    // If no fields changed, skip unnecessary HTTP call
    if (Object.keys(edits).length === 0) {
        return null;
    }

    edits.edit_reason = editReason;
    return await _updatePost(postId, edits);
}