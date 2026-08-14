import { WarningsManager } from './warnings.js';
import { showToast } from './toasts.js';
import { getE621User } from './auth.js';
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

            submittingMap: {},

            /**
             * Checks if a post is currently submitting changes/flag
             * @param {number} postId
             * @returns {boolean}
             */
            isSubmitting(postId) {
                return !!this.submittingMap[postId];
            },

            init() {
                this.warnings.registerRules([
                    {
                        id: 'login-required-blocker',
                        type: 'hard',
                        icon: '🔑',
                        title: 'Login Required',
                        message: 'You can review proposed changes in test mode, but you must log in with your e621 credentials to apply changes.',
                        check: () => !getE621User()
                    },
                    {
                        id: 'review-summary',
                        type: 'info',
                        icon: '💡',
                        title: 'Summary Instructions',
                        message: 'Review proposed changes below, then click the action buttons to publish your changes to E621. All changes will be attributed to you.',
                        check: (ctx) => {
                            if (!getE621User()) return false;
                            if (!ctx || !ctx.graph || !ctx.graph.posts) return true;

                            const posts = Array.from(ctx.graph.posts)
                                .map(id => this.resMgr?.getPost(id))
                                .filter(Boolean);

                            if (posts.length === 0) return true;

                            const allResolved = posts.every(post => {
                                const isCanonicalPost = ctx.graph.head ? Number(post.original?.post_id) === Number(ctx.graph.head) : false;
                                const isApplyButton = ctx.graph.type === 'unrelated' || isCanonicalPost || ctx.graph.type === 'variant';

                                if (isApplyButton) {
                                    return Boolean(post.is_applied);
                                } else {
                                    return Boolean(post.is_flagged || post.original?.is_flagged || post.original?.is_deleted || post.flag);
                                }
                            });

                            return !allResolved;
                        }
                    },
                    {
                        id: 'uncopied-metadata',
                        type: 'soft',
                        icon: '📋',
                        title: 'Untransferred Metadata Available',
                        message: (ctx) => {
                            const details = ctx.getUncopiedMetadataDetails(ctx.graph);
                            const headId = ctx.graph?.head;
                            return `Other posts in this graph contain metadata (${details.join(', ')}) that could be transferred over to the superior post #${headId}.`;
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

                // Parent (Check against current headPost.parent_id, ignoring self-referential parents pointing to superior post)
                const hasParent = otherPosts.some(p => {
                    const parentId = p.parent_id ?? p.original?.parent_id ?? null;
                    return parentId && Number(parentId) !== Number(graph.head) && !headPost.parent_id;
                });
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
                    if (Number(parentId) === Number(graph.head)) {
                        showToast('Cannot transfer parent ID: Parent ID is the superior post itself.', 'warning');
                        return;
                    }
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
                return Number(headPost.parent_id) === Number(parentId) || Number(parentId) === Number(graph.head);
            },

            isParentEdited(post) {
                if (!post) return false;
                const current = post.parent_id ?? null;
                const original = post.original.parent_id ?? null;
                return current !== original;
            },

            // --- Pools Controls ---
            copyPoolToHead(graph, poolId, sourcePostId) {
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

                if (sourcePostId && Number(sourcePostId) !== Number(graph.head)) {
                    const pAny = /** @type {any} */ (headPost);
                    if (!Array.isArray(pAny._poolSubstitutions)) {
                        pAny._poolSubstitutions = [];
                    }
                    const origId = Number(sourcePostId);
                    const newId = Number(headPost.original?.post_id || graph.head);
                    const existingIdx = pAny._poolSubstitutions.findIndex((/** @type {any} */ s) => s.poolId === pId);
                    const subRecord = { poolId: pId, origId, newId };
                    if (existingIdx >= 0) {
                        pAny._poolSubstitutions[existingIdx] = subRecord;
                    } else {
                        pAny._poolSubstitutions.push(subRecord);
                    }
                }
            },

            removePoolFromHead(graph, poolId) {
                const headPost = this.resMgr.getPost(graph.head);
                if (!headPost || !poolId) return;

                const pId = Number(poolId);
                const currentPools = Array.isArray(headPost.pool_ids) ? headPost.pool_ids : [];
                headPost.pool_ids = currentPools.filter(id => id !== pId);

                const pAny = /** @type {any} */ (headPost);
                if (Array.isArray(pAny._poolSubstitutions)) {
                    pAny._poolSubstitutions = pAny._poolSubstitutions.filter((/** @type {any} */ s) => s.poolId !== pId);
                }

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

            restorePoolToHead(graph, poolId, sourcePostId) {
                this.copyPoolToHead(graph, poolId, sourcePostId);
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
                if (!post || post.is_applied) return [];
                return post.tags.filter(t => !post.original.tags?.includes(t));
            },

            /**
             * Computes removed tags against original post
             * @param {ResolutionPost} post
             * @returns {string[]}
             */
            getRemovedTags(post) {
                if (!post || post.is_applied || !Array.isArray(post.original.tags)) return [];
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
             * Evaluates whether a ResolutionPost has any pending modifications to apply.
             * @param {ResolutionPost} post
             * @returns {boolean}
             */
            hasChangesToApply(post) {
                if (!post) return false;
                /** @type {any} */
                const original = post.original || {};
                const pAny = /** @type {any} */ (post);

                // 1. Tags diff
                const origTags = Array.isArray(original.tags) ? original.tags : [];
                const currentTags = Array.isArray(post.tags) ? post.tags : [];
                if (origTags.join(' ') !== currentTags.join(' ')) return true;

                // 2. Sources diff
                const origSources = Array.isArray(original.sources) ? original.sources : [];
                const currentSources = Array.isArray(post.sources) ? post.sources : [];
                if (origSources.join('\r\n') !== currentSources.join('\r\n')) return true;

                // 3. Description diff
                const origDesc = original.description ?? '';
                const currentDesc = post.description ?? '';
                if (origDesc !== currentDesc) return true;

                // 4. Rating diff
                if (post.rating !== null && post.rating !== original.rating) return true;

                // 5. Parent ID diff
                const origParent = original.parent_id ?? null;
                const currentParent = post.parent_id ?? null;
                if (origParent !== currentParent) return true;

                // 6. Pool substitutions
                if (Array.isArray(pAny._poolSubstitutions) && pAny._poolSubstitutions.length > 0) return true;

                return false;
            },

            /**
             * Applies changes for a post
             * @param {number} postId
             */
            async applyChanges(postId) {
                const post = this.resMgr.getPost(postId);
                if (!post || this.isSubmitting(postId) || post.is_applied) return;

                if (!getE621User()) {
                    showToast('You must be logged in to apply changes.', 'error');
                    return;
                }

                this.submittingMap[postId] = true;

                // Construct dynamic edit_reason including active project title if available
                const batchesStore = /** @type {any} */ (window.Alpine?.store('batches'));
                const activeProject = batchesStore?.activeProject;
                const projectName = activeProject?.title || activeProject?.name || activeProject?.project_id;
                const editReason = projectName
                    ? `Edited from P.A.C.K. Editor, part of "${projectName}" project.`
                    : 'Edited from P.A.C.K. Editor.';

                // Construct debug payload object for silent console logging
                const original = post.original || {};
                /** @type {Record<string, any>} */
                const edits = {};
                const origTags = Array.isArray(original.tags) ? original.tags : [];
                const currentTags = Array.isArray(post.tags) ? post.tags : [];
                if (origTags.join(' ') !== currentTags.join(' ')) {
                    const oldTagStr = origTags.join(' ').trim();
                    if (oldTagStr) edits.old_tag_string = oldTagStr;
                    edits.tag_string = currentTags.join(' ');
                }
                const origSources = Array.isArray(original.sources) ? original.sources : [];
                const currentSources = Array.isArray(post.sources) ? post.sources : [];
                if (origSources.join('\r\n') !== currentSources.join('\r\n')) {
                    const oldSourceStr = origSources.join('\r\n').trim();
                    if (oldSourceStr) edits.old_source = oldSourceStr;
                    edits.source = currentSources.join('\r\n');
                }
                const origDesc = original.description ?? '';
                const currentDesc = post.description ?? '';
                if (origDesc !== currentDesc) {
                    const oldDescStr = origDesc.trim();
                    if (oldDescStr) edits.old_description = oldDescStr;
                    edits.description = currentDesc;
                }
                if (post.rating !== null && post.rating !== original.rating) {
                    if (original.rating) edits.old_rating = original.rating;
                    edits.rating = post.rating;
                }
                const origParent = original.parent_id ?? null;
                const currentParent = post.parent_id ?? null;
                if (origParent !== currentParent) {
                    if (origParent !== null && String(origParent).trim() !== '') {
                        edits.old_parent_id = origParent;
                    }
                    edits.parent_id = currentParent !== null ? currentParent : '';
                }
                edits.edit_reason = editReason;

                console.log('[LIVE API] Sending applyResolutionPostEdits:', {
                    postId: Number(postId),
                    edits: edits,
                    poolSubstitutions: post._poolSubstitutions || []
                });

                try {
                    const response = await applyResolutionPostEdits(post, editReason);
                    console.log('Successfully applied post updates to e621:', response);

                    // If pool substitutions were queued:
                    if (Array.isArray(post._poolSubstitutions) && post._poolSubstitutions.length > 0) {
                        for (const sub of post._poolSubstitutions) {
                            await substitutePoolPosts(sub.poolId, [{ originalPostId: sub.origId, replacementPostId: sub.newId }]);
                        }
                    }

                    // Update local post.original and mark as applied to eliminate green highlights instantly
                    post.markApplied(response);

                    showToast(`Successfully applied updates for post #${postId} to e621!`, 'success');
                } catch (err) {
                    console.error('Failed to apply post edits to e621:', err);
                    const msg = err instanceof Error ? err.message : String(err);
                    showToast(`Failed to apply updates for post #${postId}: ${msg}`, 'error');
                } finally {
                    this.submittingMap[postId] = false;
                }
            },

            /**
             * Flags a duplicate post
             * @param {number} postId
             * @param {number} [superiorPostId]
             */
            async submitFlag(postId, superiorPostId) {
                const post = this.resMgr.getPost(postId);
                const pAny = /** @type {any} */ (post);
                if (!post || this.isSubmitting(postId) || pAny.is_flagged || post.original?.is_flagged) return;

                if (!getE621User()) {
                    showToast('You must be logged in to submit flags.', 'error');
                    return;
                }

                this.submittingMap[postId] = true;

                let headId = superiorPostId;
                if (!headId && this.resMgr?.graphs) {
                    const containingGraph = this.resMgr.graphs.find(g => g.posts && g.posts.has(Number(postId)));
                    if (containingGraph && containingGraph.head) {
                        headId = containingGraph.head;
                    }
                }
                if (!headId) {
                    headId = Number(postId);
                }

                console.log('[LIVE API] Sending flagResolutionPostInferior:', {
                    postId: Number(postId),
                    superiorPostId: Number(headId),
                    flagNote: post.flag_note
                });

                try {
                    const response = await flagResolutionPostInferior(post, Number(headId));
                    if (typeof pAny.markFlagged === 'function') {
                        pAny.markFlagged();
                    } else {
                        post.flag = true;
                        if (post.original) post.original.is_flagged = true;
                    }
                    console.log('Successfully submitted inferior flag to e621:', response);
                    showToast(`Successfully submitted inferior flag for post #${postId}!`, 'success');
                } catch (err) {
                    console.error('Failed to submit inferior flag to e621:', err);
                    let msg = err instanceof Error ? err.message : String(err);
                    showToast(`Failed to flag post #${postId}: ${msg}`, 'error');
                } finally {
                    this.submittingMap[postId] = false;
                }
            }
        };
    });
});