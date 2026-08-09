import { WarningsManager } from './warnings.js';
// NOTE: KEEP API CALLS COMMENTED OUT UNTIL LAUNCH!
import { applyResolutionPostEdits, flagResolutionPostInferior, substitutePoolPosts } from './e621_api.js';

document.addEventListener('alpine:init', () => {
    if (!window.Alpine) return;

    /**
     * @typedef {import('./resolution.js').ResolutionGraph} ResolutionGraph
     * @typedef {import('./resolution.js').ResolutionPost} ResolutionPost
     */

    window.Alpine.data('summaryManager', (resMgr) => {
        /** @type {any} */
        const arg = resMgr;
        const manager = (arg && Array.isArray(arg.graphs)) ? arg : (arg && arg.resMgr) ? arg.resMgr : arg;
        return {
            resMgr: /** @type {ResolutionManagerComponent} */ (manager),
            warnings: new WarningsManager(),

            init() {
                this.warnings.registerRules([
                    {
                        id: 'review-summary',
                        type: 'info',
                        icon: '💡',
                        title: 'Summary Instructions',
                        message: 'Review proposed changes below, copy over descriptions or sources to the kept post if needed, then click the action buttons to finalize.',
                        check: () => true
                    },
                    {
                        id: 'uncopied-metadata',
                        type: 'soft',
                        icon: '💡',
                        title: 'Uncopied Metadata Available',
                        message: (ctx) => {
                            const details = ctx.getUncopiedMetadataDetails(ctx.graph);
                            const headId = ctx.graph?.head;
                            return `Other posts in this graph contain metadata (${details.join(', ')}) that could be copied over to kept post #${headId}.`;
                        },
                        check: (ctx) => ctx.hasUncopiedMetadata(ctx.graph)
                    }
                ]);
            },

            /**
             * Normalizes a URL for comparison (trims whitespace, strips trailing slashes, lowercases host/scheme)
             * @param {string} url
             * @returns {string}
             */
            normalizeUrl(url) {
                if (!url || typeof url !== 'string') return '';
                let cleaned = url.trim();
                if (!cleaned) return '';
                cleaned = cleaned.replace(/\/+$/, '');
                try {
                    const u = new URL(cleaned);
                    let path = u.pathname.replace(/\/+$/, '');
                    return `${u.protocol}//${u.hostname.toLowerCase()}${path}${u.search}${u.hash}`.toLowerCase();
                } catch (e) {
                    return cleaned.toLowerCase();
                }
            },

            getUncopiedMetadataDetails(graph) {
                if (!graph || !graph.head) return [];
                const headPost = this.resMgr.getPost(graph.head);
                if (!headPost) return [];

                const otherPosts = Array.from(graph.posts)
                    .filter(id => id !== graph.head)
                    .map(id => this.resMgr.getPost(id))
                    .filter(Boolean);

                const details = [];

                // Description
                const hasDesc = otherPosts.some(p => p.description && p.description.trim().length > 0);
                if (hasDesc && (!headPost.description || !headPost.description.trim().length)) {
                    details.push('Description');
                }

                // Sources (Normalized URL comparison)
                const headSourcesNorm = new Set((headPost.sources || []).map(s => this.normalizeUrl(s)));
                const hasNewSources = otherPosts.some(p =>
                    (p.sources || []).some(s => s && !headSourcesNorm.has(this.normalizeUrl(s)))
                );
                if (hasNewSources) {
                    details.push('Sources');
                }

                // Pools (Check against current headPost.pool_ids)
                const headPools = new Set(headPost.pool_ids || []);
                const hasNewPools = otherPosts.some(p => (p.original?.pool_ids || p.pool_ids || []).some(id => !headPools.has(id)));
                if (hasNewPools) {
                    details.push('Pools');
                }

                // Parent (Check against current headPost.parent_id)
                const hasParent = otherPosts.some(p => (p.parent_id || p.original?.parent_id) && !headPost.parent_id);
                if (hasParent) {
                    details.push('Parent Post');
                }

                return details;
            },

            hasUncopiedMetadata(graph) {
                return this.getUncopiedMetadataDetails(graph).length > 0;
            },

            /**
             * Checks if a post is the canonical/head post for the graph
             * @param {ResolutionGraph} graph
             * @param {number} postId
             * @returns {boolean}
             */
            isCanonical(graph, postId) {
                return graph?.head === postId;
            },

            /**
             * Copies description from a source post to the graph's head post
             * @param {ResolutionGraph} graph
             * @param {number} sourcePostId
             */
            copyDescriptionToHead(graph, sourcePostId) {
                const headPost = this.resMgr.getPost(graph.head);
                const sourcePost = this.resMgr.getPost(Number(sourcePostId));
                if (headPost && sourcePost) {
                    headPost.description = sourcePost.description || '';
                }
            },

            /**
             * Resets the head post description back to its original value
             * @param {ResolutionGraph} graph
             */
            resetHeadDescription(graph) {
                const headPost = this.resMgr.getPost(graph.head);
                if (headPost) {
                    headPost.description = null;
                }
            },

            /**
             * Adds a source URL to the graph's head post if not already present
             * @param {ResolutionGraph} graph
             * @param {string} sourceUrl
             */
            addSourceToHead(graph, sourceUrl) {
                const headPost = this.resMgr.getPost(graph.head);
                if (!headPost) return;

                if (!Array.isArray(headPost._removedSources)) {
                    headPost._removedSources = [];
                }

                const targetNorm = this.normalizeUrl(sourceUrl);
                headPost._removedSources = headPost._removedSources.filter(s => this.normalizeUrl(s) !== targetNorm);

                const currentSources = Array.isArray(headPost.sources) ? headPost.sources : [];
                const alreadyHas = currentSources.some(s => this.normalizeUrl(s) === targetNorm);
                if (!alreadyHas) {
                    headPost.sources = [...currentSources, sourceUrl];
                }
            },

            /**
             * Removes a source URL from the graph's head post and tracks it in _removedSources
             * @param {ResolutionGraph} graph
             * @param {string} sourceUrl
             */
            removeSourceFromHead(graph, sourceUrl) {
                const headPost = this.resMgr.getPost(graph.head);
                if (!headPost) return;

                const targetNorm = this.normalizeUrl(sourceUrl);
                const currentSources = Array.isArray(headPost.sources) ? headPost.sources : [];
                
                headPost.sources = currentSources.filter(s => this.normalizeUrl(s) !== targetNorm);

                // Only track in _removedSources if it was an ORIGINAL source on headPost
                const origSources = Array.isArray(headPost.original?.sources) ? headPost.original.sources : [];
                const wasOriginalSource = origSources.some(s => this.normalizeUrl(s) === targetNorm);

                if (wasOriginalSource) {
                    if (!Array.isArray(headPost._removedSources)) {
                        headPost._removedSources = [];
                    }
                    if (!headPost._removedSources.some(s => this.normalizeUrl(s) === targetNorm)) {
                        headPost._removedSources.push(sourceUrl);
                    }
                }
            },

            /**
             * Restores a previously removed source URL back to the graph's head post
             * @param {ResolutionGraph} graph
             * @param {string} sourceUrl
             */
            restoreSourceToHead(graph, sourceUrl) {
                this.addSourceToHead(graph, sourceUrl);
            },

            /**
             * Checks if the head post currently contains a specific source (using normalized URL matching)
             * @param {ResolutionGraph} graph
             * @param {string} sourceUrl
             * @returns {boolean}
             */
            headHasSource(graph, sourceUrl) {
                const headPost = this.resMgr.getPost(graph.head);
                if (!headPost || !Array.isArray(headPost.sources)) return false;
                const targetNorm = this.normalizeUrl(sourceUrl);
                return headPost.sources.some(s => this.normalizeUrl(s) === targetNorm);
            },

            // --- Parent Post Controls ---
            copyParentToHead(graph, parentId) {
                const headPost = this.resMgr.getPost(graph.head);
                if (headPost && parentId) {
                    headPost.parent_id = Number(parentId);
                }
            },

            resetHeadParent(graph) {
                const headPost = this.resMgr.getPost(graph.head);
                if (headPost) {
                    headPost.parent_id = headPost.original.parent_id ?? null;
                }
            },

            removeHeadParent(graph) {
                const headPost = this.resMgr.getPost(graph.head);
                if (headPost) {
                    headPost.parent_id = null;
                }
            },

            headHasParent(graph, parentId) {
                const headPost = this.resMgr.getPost(graph.head);
                if (!headPost) return false;
                return Number(headPost.parent_id) === Number(parentId);
            },

            isParentEdited(post) {
                if (!post) return false;
                const current = post.parent_id ?? null;
                const original = post.original.parent_id ?? null;
                return current !== original;
            },

            // --- Pools Controls ---
            copyPoolToHead(graph, poolId) {
                const headPost = this.resMgr.getPost(graph.head);
                if (!headPost || !poolId) return;

                const pId = Number(poolId);
                const currentPools = Array.isArray(headPost.pool_ids) ? headPost.pool_ids : [];
                if (!currentPools.includes(pId)) {
                    headPost.pool_ids = [...currentPools, pId];
                }

                if (Array.isArray(headPost._removedPools)) {
                    headPost._removedPools = headPost._removedPools.filter(id => id !== pId);
                }
            },

            removePoolFromHead(graph, poolId) {
                const headPost = this.resMgr.getPost(graph.head);
                if (!headPost || !poolId) return;

                const pId = Number(poolId);
                const currentPools = Array.isArray(headPost.pool_ids) ? headPost.pool_ids : [];
                headPost.pool_ids = currentPools.filter(id => id !== pId);

                // Only track in _removedPools if it was an ORIGINAL pool on headPost
                const wasOriginalHeadPool = Array.isArray(headPost.original?.pool_ids) && headPost.original.pool_ids.includes(pId);
                if (wasOriginalHeadPool) {
                    if (!Array.isArray(headPost._removedPools)) {
                        headPost._removedPools = [];
                    }
                    if (!headPost._removedPools.includes(pId)) {
                        headPost._removedPools.push(pId);
                    }
                }
            },

            getAvailableInferiorPools(graph, post) {
                if (!post || !graph || !graph.head) return [];
                const origPools = Array.isArray(post.original?.pool_ids) ? post.original.pool_ids : (post.pool_ids || []);
                const headPost = this.resMgr.getPost(graph.head);
                if (!headPost) return origPools;
                const headPools = new Set(headPost.pool_ids || []);
                return origPools.filter(id => !headPools.has(Number(id)));
            },

            restorePoolToHead(graph, poolId) {
                this.copyPoolToHead(graph, poolId);
            },

            resetHeadPools(graph) {
                const headPost = this.resMgr.getPost(graph.head);
                if (headPost) {
                    headPost.pool_ids = [...(headPost.original.pool_ids || [])];
                    headPost._removedPools = [];
                }
            },

            headHasPool(graph, poolId) {
                const headPost = this.resMgr.getPost(graph.head);
                if (!headPost || !Array.isArray(headPost.pool_ids)) return false;
                return headPost.pool_ids.includes(Number(poolId));
            },

            isPoolsEdited(post) {
                if (!post) return false;
                const current = (post.pool_ids || []).sort().join(',');
                const original = (post.original.pool_ids || []).sort().join(',');
                const removedCount = (post._removedPools || []).length;
                return current !== original || removedCount > 0;
            },

            /**
             * Computes added tags against original post
             * @param {ResolutionPost} post
             * @returns {string[]}
             */
            getAddedTags(post) {
                if (!post) return [];
                return post.tags.filter(t => !post.original.tags?.includes(t));
            },

            /**
             * Computes removed tags against original post
             * @param {ResolutionPost} post
             * @returns {string[]}
             */
            getRemovedTags(post) {
                if (!post || !Array.isArray(post.original.tags)) return [];
                return post.original.tags.filter(t => !post.tags.includes(t));
            },

            /**
             * Checks if description was edited
             * @param {ResolutionPost} post
             * @returns {boolean}
             */
            isDescriptionEdited(post) {
                if (!post) return false;
                return (post.description || '') !== (post.original.description || '');
            },

            /**
             * Applies changes for a post
             * @param {number} postId
             */
            async applyChanges(postId) {
                const post = this.resMgr.getPost(postId);
                if (!post) return;
                console.log('Applying resolution updates for post:', postId, post);

                /*
                // =========================================================================
                // NOTE: KEEP API CALLS COMMENTED OUT UNTIL LAUNCH!
                // DO NOT UNCOMMENT UNTIL PRODUCTION ROLLOUT IS READY.
                // =========================================================================
                try {
                    const response = await applyResolutionPostEdits(post, 'Cluster cleanup resolution');
                    console.log('Successfully applied post updates to e621:', response);
                    
                    // If pool substitutions were queued:
                    // if (Array.isArray(post._poolSubstitutions) && post._poolSubstitutions.length > 0) {
                    //     for (const sub of post._poolSubstitutions) {
                    //         await substitutePoolPosts(sub.poolId, [{ originalPostId: sub.origId, replacementPostId: sub.newId }]);
                    //     }
                    // }
                } catch (err) {
                    console.error('Failed to apply post edits to e621:', err);
                }
                */
            },

            /**
             * Flags a duplicate post
             * @param {number} postId
             * @param {number} [superiorPostId]
             */
            async submitFlag(postId, superiorPostId) {
                const post = this.resMgr.getPost(postId);
                if (!post) return;
                post.flag = true;
                console.log('Flagging post as inferior:', postId, 'Superior:', superiorPostId, 'Note:', post.flag_note);

                /*
                // =========================================================================
                // NOTE: KEEP API CALLS COMMENTED OUT UNTIL LAUNCH!
                // DO NOT UNCOMMENT UNTIL PRODUCTION ROLLOUT IS READY.
                // =========================================================================
                try {
                    const headId = superiorPostId || Number(postId);
                    const response = await flagResolutionPostInferior(post, headId);
                    console.log('Successfully submitted inferior flag to e621:', response);
                } catch (err) {
                    console.error('Failed to submit inferior flag to e621:', err);
                }
                */
            }
        };
    });
});