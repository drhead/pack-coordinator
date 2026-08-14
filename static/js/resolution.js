import { ensureClusterPostsInfo } from './e621_api.js';

import './summary.js'

/**
 * @typedef {'duplicate' | 'variant' | 'unrelated' | 'unknown'} GraphType
 */

/**
 * @typedef {Object} ResolutionGraph
 * @property {GraphType} type
 * @property {Set<number>} posts
 * @property {number} [head]
 */

/**
 * @typedef {Object} GraphRelation
 * @property {number} a
 * @property {number} b
 * @property {GraphType} type
 */

/**
 * Encapsulates editable working state for a single post during resolution.
 */
export class ResolutionPost {
    /**
     * @param {ClusterPost} original
     */
    constructor(original) {
        /** @type {ClusterPost} */
        this.original = original;

        /** @type {string[]} */
        this.tags = Array.isArray(original.tags) ? [...original.tags] : [];

        /** @type {PostRating|null} */
        this.rating = null;

        /** @type {number|null} */
        this.parent_id = original.parent_id ?? null;

        /** @type {number[]} */
        this.pool_ids = Array.isArray(original.pool_ids) ? [...original.pool_ids] : [];

        /** @type {string[]|null} */
        this._sources = null;

        /** @type {string|null} */
        this._description = null;

        /** @type {boolean} */
        this.flag = false;

        /** @type {string} */
        this.flag_note = "";

        /** @type {boolean} */
        this.is_applied = false;

        /** @type {boolean} */
        this.is_flagged = Boolean(original.is_flagged);
    }

    /**
     * Marks the post as flagged permanently in local state.
     */
    markFlagged() {
        this.is_flagged = true;
        this.flag = true;
        if (this.original) {
            this.original.is_flagged = true;
        }
    }

    /**
     * @returns {string[]}
     */
    get sources() {
        if (this._sources !== null) {
            return this._sources;
        }
        return Array.isArray(this.original.sources) ? [...this.original.sources] : [];
    }

    /**
     * @param {string[]|null} val
     */
    set sources(val) {
        this._sources = Array.isArray(val) ? [...val] : null;
    }

    /**
     * @returns {string}
     */
    get description() {
        if (this._description !== null) {
            return this._description;
        }
        return this.original.description ?? "";
    }

    /**
     * @param {string|null} val
     */
    set description(val) {
        this._description = val;
    }

    /**
     * Updates post.original with current values (or API response) and marks the post as applied,
     * clearing diff overrides so green highlights disappear and UI reflects applied state.
     * @param {Object} [updatedApiPost]
     */
    markApplied(updatedApiPost) {
        let finalTags = Array.isArray(this.tags) ? [...this.tags] : [];
        let finalSources = Array.isArray(this.sources) ? [...this.sources] : [];
        let finalDesc = this.description;
        let finalRating = this.getEffectiveRating();
        let finalParent = this.parent_id;

        if (updatedApiPost && typeof updatedApiPost === 'object') {
            const apiObj = updatedApiPost.post || updatedApiPost;
            if (apiObj.post_id || apiObj.id) {
                if (Array.isArray(apiObj.tags)) finalTags = [...apiObj.tags];
                else if (typeof apiObj.tag_string === 'string') finalTags = apiObj.tag_string.split(' ').filter(Boolean);
                if (Array.isArray(apiObj.sources)) finalSources = [...apiObj.sources];
                if (typeof apiObj.description === 'string') finalDesc = apiObj.description;
                if (apiObj.rating) finalRating = apiObj.rating;
                if (apiObj.parent_id !== undefined) finalParent = apiObj.parent_id;
            }
        }

        const pAny = /** @type {any} */ (this);

        // Deep copy final state into both working properties and original snapshot
        this.tags = [...finalTags];
        if (!this.original) this.original = /** @type {any} */ ({});
        this.original.tags = [...finalTags];

        this.sources = [...finalSources];
        this.original.sources = [...finalSources];

        this.description = finalDesc;
        this.original.description = finalDesc;

        this.rating = null;
        this.original.rating = finalRating;

        this.parent_id = null;
        this.original.parent_id = finalParent;

        this._sources = null;
        this._description = null;
        pAny._removedSources = [];
        pAny._poolSubstitutions = [];

        this.is_applied = true;
    }

    /**
     * Gets the effective rating, falling back to original if no override is set.
     * Use this for UI displays, badges, or tag logic that requires a concrete rating.
     * 
     * @returns {PostRating}
     */
    getEffectiveRating() {
        return this.rating ?? this.original.rating;
    }
}

document.addEventListener('alpine:init', () => {
    if (!window.Alpine) return;

    /**
     * Component factory for managing shared state during a cluster resolution session.
     * @param {Cluster} cluster
     */
    window.Alpine.data('resolutionManager', (cluster) => ({
        /** @type {Cluster} */
        // @ts-expect-error
        cluster: cluster,

        /** @type {ResolutionGraph[]} */
        graphs: [],

        /** @type {Map<string, GraphRelation>} Map formatted "minId:maxId" -> GraphRelation */
        relations: new Map(),

        /** @type {Map<number, ResolutionPost>} */
        posts: new Map(),

        initializePosts() {
            if (!this.cluster || !Array.isArray(this.cluster.posts)) {
                return;
            }

            for (const post of this.cluster.posts) {
                if (!this.posts.has(post.post_id)) {
                    this.posts.set(post.post_id, new ResolutionPost(post));
                }
            }

            // Asynchronously fetch missing e621 metadata in background
            ensureClusterPostsInfo(this.cluster.posts).catch(err => {
                console.warn('[ResolutionManager] Background metadata fetch warning:', err);
            });
        },

        /**
         * Ensures a default duplicate graph exists for the cluster if no duplicate graph has been constructed yet.
         */
        ensureDefaultDuplicateGraph() {
            if (!this.cluster || !Array.isArray(this.cluster.posts) || this.cluster.posts.length === 0) {
                return;
            }
            const hasDuplicate = this.graphs.some(g => g.type === 'duplicate');
            if (!hasDuplicate) {
                const postIds = this.cluster.posts.map(p => p.post_id);
                const activePost = this.cluster.posts.find(p => !p.is_deleted && !p.is_flagged);
                const headId = activePost ? activePost.post_id : postIds[0];
                this.graphs.push({
                    type: 'duplicate',
                    posts: new Set(postIds),
                    head: headId
                });
            }
        },

        /**
         * Retrieves a ResolutionPost by ID.
         * @param {number} postId
         * @returns {ResolutionPost|undefined}
         */
        getPost(postId) {
            return this.posts.get(postId);
        },

        /**
         * Collapses a duplicate graph down to a single canonical post ID
         * and updates any variant graphs referencing those duplicate posts.
         * @param {ResolutionGraph} graph
         * @returns {void}
         */
        resolveDuplicateGraph(graph) {
            if (graph.type !== 'duplicate') {
                throw new Error(`Cannot resolve graph: Expected type 'duplicate', got '${graph.type}'`);
            }

            if (!graph.head) {
                throw new Error(`Cannot resolve duplicate graph: No head set.`);
            }

            if (!graph.posts.has(graph.head)) {
                throw new Error(`Cannot resolve duplicate graph: Head '${graph.head}' not present in graph.`);
            }

            // For all 'variant' graphs containing any of graph.posts:
            // Remove graph.posts from them, and add the canonical `id`
            for (const vGraph of this.graphs) {
                if (vGraph.type === 'variant') {
                    let matched = false;

                    for (const postId of graph.posts) {
                        if (vGraph.posts.has(postId)) {
                            vGraph.posts.delete(postId);
                            matched = true;
                        }
                    }

                    if (matched) {
                        vGraph.posts.add(graph.head);
                    }
                }
            }
        },

        /**
         * Helper to get standard key for pairwise relationships.
         * @private
         * @param {number} a
         * @param {number} b
         * @returns {string}
         */
        _getRelationKey(a, b) {
            return a < b ? `${a}:${b}` : `${b}:${a}`;
        },

        /**
         * Marks a post as unknown (e.g., missing fileUrl).
         * @param {number} id
         * @returns {void}
         */
        markUnknown(id) {
            this.graphs.push({
                type: 'unknown',
                posts: new Set([id])
            });
        },

        /**
         * Signals a relation of a specific type between two post IDs.
         * @param {GraphType} type
         * @param {number} a
         * @param {number} b
         * @param {number | null} [superiorId]
         * @returns {void}
         */
        addGraphEdge(type, a, b, superiorId = null) {
            if (type === 'unrelated') {
                // Check if ANY graph contains A or B
                if (!this.graphs.some(g => g.posts.has(a))) {
                    this.graphs.push({ type: 'unrelated', posts: new Set([a]) });
                }
                if (!this.graphs.some(g => g.posts.has(b))) {
                    this.graphs.push({ type: 'unrelated', posts: new Set([b]) });
                }
                const key = this._getRelationKey(a, b);
                const [minId, maxId] = a < b ? [a, b] : [b, a];
                this.relations.set(key, { a: minId, b: maxId, type: 'unrelated' });
                return;
            }

            // Handle 'duplicate' or 'variant'
            if (type === 'duplicate' || type === 'variant') {
                // 1. Remove 'unrelated' graphs containing A or B
                this.graphs = this.graphs.filter(g => {
                    if (g.type === 'unrelated') {
                        return !g.posts.has(a) && !g.posts.has(b);
                    }
                    return true;
                });

                const graphA = this.graphs.find(g => g.type === type && g.posts.has(a));
                const graphB = this.graphs.find(g => g.type === type && g.posts.has(b));

                // Case 1: Neither A nor B exist in a $type graph -> Create new graph with both
                if (!graphA && !graphB) {
                    /** @type {ResolutionGraph} */
                    const newGraph = { type, posts: new Set([a, b]) };
                    if (type === 'duplicate' && superiorId) {
                        newGraph.head = superiorId;
                    }
                    this.graphs.push(newGraph);
                }
                // Case 2: Exactly one exists -> Add missing node & update head if superior
                else if (graphA && !graphB) {
                    graphA.posts.add(b);
                    if (type === 'duplicate' && superiorId) {
                        graphA.head = superiorId;
                    }
                }
                else if (!graphA && graphB) {
                    graphB.posts.add(a);
                    if (type === 'duplicate' && superiorId) {
                        graphB.head = superiorId;
                    }
                }
                // Case 3: Both exist in separate $type graphs -> Merge graphB into graphA
                else if (graphA && graphB && graphA !== graphB) {
                    for (const postId of graphB.posts) {
                        graphA.posts.add(postId);
                    }
                    if (type === 'duplicate' && superiorId) {
                        graphA.head = superiorId;
                    }
                    // Remove the merged graphB from graphs list
                    this.graphs = this.graphs.filter(g => g !== graphB);
                }
            }
        },

        /**
         * Recalculates transitive connections (duplicates/variants) and replicates
         * unrelated links across connected components into `this.relations`.
         * @returns {void}
         */
        recalculateDerivedRelations() {
            /**
             * Helper to safely record/upgrade a relation
             * @param {number} x
             * @param {number} y
             * @param {GraphType} relType
             */
            const recordRelation = (x, y, relType) => {
                if (x === y) return;
                const key = this._getRelationKey(x, y);
                const [minId, maxId] = x < y ? [x, y] : [y, x];

                const existing = this.relations.get(key);
                if (!existing) {
                    this.relations.set(key, { a: minId, b: maxId, type: relType });
                } else if (existing.type === 'variant' && relType === 'duplicate') {
                    existing.type = 'duplicate';
                }
            };

            // 1. Process explicit duplicate/variant graphs and build connected components
            /** @type {Map<number, Set<number>>} */
            const clusterComponents = new Map();

            /**
             * @param {number} id
             * @returns {Set<number>}
             */
            const getComponent = (id) => {
                let comp = clusterComponents.get(id);
                if (!comp) {
                    comp = new Set([id]);
                    clusterComponents.set(id, comp);
                }
                return comp;
            };

            for (const graph of this.graphs) {
                if (graph.type === 'duplicate' || graph.type === 'variant') {
                    const postsList = Array.from(graph.posts);
                    if (postsList.length === 0) continue;

                    // Derive pairwise relations directly within this graph
                    for (let i = 0; i < postsList.length; i++) {
                        for (let j = i + 1; j < postsList.length; j++) {
                            recordRelation(postsList[i], postsList[j], graph.type);
                        }
                    }

                    // Merge component sets
                    const mergedComponent = new Set();
                    for (const postId of postsList) {
                        const comp = getComponent(postId);
                        for (const id of comp) {
                            mergedComponent.add(id);
                        }
                    }

                    for (const postId of mergedComponent) {
                        clusterComponents.set(postId, mergedComponent);
                    }
                }
            }

            // 2. Pairwise transitive relations within merged components
            /** @type {Set<Set<number>>} */
            const processedComponents = new Set();
            for (const comp of clusterComponents.values()) {
                if (processedComponents.has(comp)) continue;
                processedComponents.add(comp);

                const postsArr = Array.from(comp);
                for (let i = 0; i < postsArr.length; i++) {
                    for (let j = i + 1; j < postsArr.length; j++) {
                        // Default transitive relation within a component is 'variant' unless recorded higher
                        recordRelation(postsArr[i], postsArr[j], 'variant');
                    }
                }
            }

            // 3. Replicate existing 'unrelated' relations across connected components
            const currentUnrelateds = Array.from(this.relations.values()).filter(r => r.type === 'unrelated');
            for (const rel of currentUnrelateds) {
                const compA = getComponent(rel.a);
                const compB = getComponent(rel.b);

                for (const x of compA) {
                    for (const y of compB) {
                        recordRelation(x, y, 'unrelated');
                    }
                }
            }
        },

        /**
         * Finds the next pair of post IDs needing comparison to resolve relationships.
         * @returns {[number, number] | false} Pair of post IDs [a, b] or false if fully mapped.
         */
        getNextPair() {
            this.recalculateDerivedRelations();
            const unknowns = new Set();
            const unrelateds = new Set();

            for (const graph of this.graphs) {
                if (graph.type === 'unknown') {
                    for (const id of graph.posts) unknowns.add(id);
                } else if (graph.type === 'unrelated') {
                    for (const id of graph.posts) unrelateds.add(id);
                }
            }

            const unrelatedOrUnknown = new Set([...unknowns, ...unrelateds]);
            /** @param {number} id */
            const getHeadIfDuplicate = (id) => {
                const dupGraph = this.graphs.find(g => g.type === 'duplicate' && g.posts.has(id));
                return dupGraph?.head ?? id;
            };

            /**
             * Check if pair (a, b) already has an established relation in stored relations
             * @param {number} a
             * @param {number} b
             * @returns {boolean}
             */
            const hasRelation = (a, b) => {
                const key = this._getRelationKey(a, b);
                return this.relations.has(key);
            };

            const allPostIds = Array.from(this.posts.keys());

            // Phase 1: Evaluate posts not in unrelated or unknown
            const phase1Posts = allPostIds.filter(id => !unrelatedOrUnknown.has(id));
            for (let i = 0; i < phase1Posts.length; i++) {
                for (let j = i + 1; j < phase1Posts.length; j++) {
                    const a = phase1Posts[i];
                    const b = phase1Posts[j];
                    if (!hasRelation(a, b)) {
                        return [getHeadIfDuplicate(a), getHeadIfDuplicate(b)];
                    }
                }
            }

            // Phase 2: Evaluate posts not in unknown (attempting leftover unrelated comparisons)
            const phase2Posts = allPostIds.filter(id => !unknowns.has(id));
            for (let i = 0; i < phase2Posts.length; i++) {
                for (let j = i + 1; j < phase2Posts.length; j++) {
                    const a = phase2Posts[i];
                    const b = phase2Posts[j];
                    if (!hasRelation(a, b)) {
                        return [getHeadIfDuplicate(a), getHeadIfDuplicate(b)];
                    }
                }
            }

            return false;
        },

        /**
         * Clears all recorded graphs and relations.
         * @returns {void}
         */
        clearGraphs() {
            this.graphs = [];
            this.relations.clear();
        },

        /**
         * Clears working graph state and resets all post instances back to original values.
         * @returns {void}
         */
        resetClusterWork() {
            this.clearGraphs();
            for (const [, resPost] of this.posts.entries()) {
                resPost.tags = Array.isArray(resPost.original.tags) ? [...resPost.original.tags] : [];
                resPost.rating = null;
                resPost.parent_id = resPost.original.parent_id ?? null;
                resPost.pool_ids = Array.isArray(resPost.original.pool_ids) ? [...resPost.original.pool_ids] : [];
                resPost._sources = null;
                resPost._description = null;
                resPost.flag = false;
                resPost.flag_note = "";
            }
        }
    }));
});