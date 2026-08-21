// @ts-check
import Alpine from 'alpinejs';
/** @type {any} */ (window).Alpine = Alpine;

import { showToast } from './toasts.js';
import { tagManager } from './tags.js';
import { ResolutionPost } from './resolution.js';
import { alpineHelpers } from './alpine_helpers.js';
import { openImageModal } from './image_modal.js';
import { WarningsManager } from './warnings.js';
import { getE621User } from './auth.js';

/**
 * @typedef {Object} RootData
 * @property {string} activeView
 */

/**
 * Alpine component factory for tag reconciliation and classification graphs.
 * @param {ResolutionManagerComponent} manager
 */
export function ReconciliationManager(manager) {
    return {
        isActive: false,
        isLoading: false,
        isSummary: false,
        isArtistWarningDismissed: false,

        /** @type {ResolutionManagerComponent} */
        resolutionManager: manager,

        warnings: new WarningsManager(),

        initWarnings() {
            this.warnings.registerRules([
                {
                    id: 'login-required-info',
                    type: 'info',
                    icon: '🧪',
                    title: 'Testing Mode',
                    message: "You can test the interface (and please provide feedback!), but you'll have to log in to apply changes.",
                    check: () => !getE621User()
                },
                {
                    id: 'rating-mismatch',
                    type: 'hard',
                    icon: '⚠️',
                    title: 'Rating Conflict Detected',
                    message: 'Rating conflict detected between posts in this duplicate graph. Please select an appropriate rating for the post using the selector below to advance.',
                    check: (ctx) => ctx.hasRatingConflict
                },
                {
                    id: 'artist-mismatch',
                    type: 'soft',
                    icon: '🎨',
                    title: 'Artist Tag Mismatch',
                    message: 'Artist tags between posts in this duplicate cluster do not match. Please verify the true artist, and file a <a href="https://e621.net/tag_alias_request/new" target="_blank" rel="noopener noreferrer" class="text-amber-200 underline hover:text-white font-bold">tag alias request</a> if appropriate.',
                    check: (ctx) => ctx.hasArtistMismatch
                }
            ]);
        },

        activeStepIndex: 0,
        activeRhsIndex: 0,

        /** @type {number|null} */
        selectedSuperiorId: null,
        /** @type {number|null} */
        selectedParentId: null,
        customParentId: '',
        /** @type {number|null} */
        lhsPostId: null,

        tagInput: '',
        hoveredImplicationData: null,

        /** @type {ResizeObserver|null} */
        _imageAlignObserver: null,

        /**
         * Filter resolution graphs for reconciliation tabs (duplicates first, then variants).
         * @returns {import('./resolution.js').ResolutionGraph[]}
         */
        get reconcileGraphs() {
            if (!this.resolutionManager?.graphs) return [];
            const dups = this.resolutionManager.graphs.filter(g => g.type === 'duplicate');
            const vars = this.resolutionManager.graphs.filter(g => g.type === 'variant');
            return [...dups, ...vars];
        },

        /**
         * Backward-compatible alias for duplicateGraphs.
         * @returns {import('./resolution.js').ResolutionGraph[]}
         */
        get duplicateGraphs() {
            return this.reconcileGraphs;
        },

        /**
         * Constructs the sequence of reconciliation steps:
         * - 1 step per duplicate graph (inferior posts -> superior post)
         * - N steps per variant graph (other variants -> variant post, for each post)
         * @returns {Array<{
         *   graph: import('./resolution.js').ResolutionGraph,
         *   graphIndex: number,
         *   type: import('./resolution.js').GraphType,
         *   targetId: number,
         *   sourceIds: number[],
         *   stepIndex: number,
         *   postIndexInGraph: number,
         *   totalPostsInGraph: number
         * }>}
         */
        get reconcileSteps() {
            /** @type {Array<{ graph: import('./resolution.js').ResolutionGraph, graphIndex: number, type: import('./resolution.js').GraphType, targetId: number, sourceIds: number[], stepIndex: number, postIndexInGraph: number, totalPostsInGraph: number }>} */
            const steps = [];
            const graphs = this.reconcileGraphs;
            for (let gIdx = 0; gIdx < graphs.length; gIdx++) {
                const graph = graphs[gIdx];
                const postIds = Array.from(graph.posts);

                if (graph.type === 'duplicate') {
                    let superiorId = graph.head;
                    if (!superiorId || !postIds.includes(superiorId)) {
                        const activeId = postIds.find(pId => {
                            const p = this.getLocalClusterPost(pId);
                            return p && !p.isDeleted && !p.isFlagged;
                        });
                        superiorId = activeId || postIds[0];
                        graph.head = superiorId;
                    }
                    const nonHeadIds = postIds.filter(id => id !== superiorId);
                    steps.push({
                        graph,
                        graphIndex: gIdx,
                        type: 'duplicate',
                        targetId: superiorId,
                        sourceIds: nonHeadIds,
                        stepIndex: steps.length,
                        postIndexInGraph: 0,
                        totalPostsInGraph: 1
                    });
                } else if (graph.type === 'variant') {
                    for (let pIdx = 0; pIdx < postIds.length; pIdx++) {
                        const targetId = postIds[pIdx];
                        const otherIds = postIds.filter(id => id !== targetId);
                        steps.push({
                            graph,
                            graphIndex: gIdx,
                            type: 'variant',
                            targetId: targetId,
                            sourceIds: otherIds,
                            stepIndex: steps.length,
                            postIndexInGraph: pIdx,
                            totalPostsInGraph: postIds.length
                        });
                    }
                }
            }
            return steps;
        },

        /**
         * Get current active reconciliation step.
         */
        get currentStep() {
            return this.reconcileSteps[this.activeStepIndex] || null;
        },

        /**
         * Get current active ResolutionGraph.
         * @returns {import('./resolution.js').ResolutionGraph|null}
         */
        get currentGraph() {
            return this.currentStep?.graph || null;
        },

        /**
         * Get active graph index among reconcileGraphs.
         * @returns {number}
         */
        get activeGraphIndex() {
            return this.currentStep?.graphIndex ?? 0;
        },

        /**
         * Retrieves the editable working state ResolutionPost for the active LHS post.
         * @returns {ResolutionPost|undefined}
         */
        get lhsResolutionPost() {
            if (!this.lhsPostId) return undefined;
            return this.resolutionManager.getPost(this.lhsPostId);
        },

        /**
         * @param {number} postId
         * @returns {ClusterPost | null}
         */
        getLocalClusterPost(postId) {
            return this.resolutionManager?.getPost?.(postId)?.original || null;
        },

        /** @type {Record<number, boolean>} */
        collapsedPostIds: {},

        /**
         * @param {number} postId
         * @returns {boolean}
         */
        isPostCollapsed(postId) {
            return !!this.collapsedPostIds[postId];
        },

        /**
         * @param {number} postId
         */
        togglePostCollapse(postId) {
            this.collapsedPostIds[postId] = !this.collapsedPostIds[postId];
            this.$nextTick(() => this.alignLhsImage());
        },

        /**
         * @param {number} postId
         * @returns {boolean}
         */
        isPostDeleted(postId) {
            return !!this.getLocalClusterPost(postId)?.isDeleted;
        },

        /**
         * @param {number} postId
         * @returns {boolean}
         */
        isPostFlagged(postId) {
            return !!this.getLocalClusterPost(postId)?.isFlagged;
        },

        get lhsPost() {
            return this.lhsResolutionPost?.original || null;
        },

        get lhsTags() {
            return this.lhsResolutionPost?.tags || [];
        },

        get originalLhsTagNames() {
            const resPost = this.lhsResolutionPost;
            if (!resPost) return new Set();
            return new Set(resPost.original.tags || []);
        },

        get newTags() {
            const resPost = this.lhsResolutionPost;
            if (!resPost) return new Set();
            const origSet = this.originalLhsTagNames;
            return new Set(resPost.tags.filter(t => !origSet.has(t)));
        },

        get removedLhsTags() {
            const resPost = this.lhsResolutionPost;
            if (!resPost) return [];
            const currentSet = new Set(resPost.tags);
            const originalTags = resPost.original.tags || [];
            return originalTags.filter(t => !currentSet.has(t));
        },

        get activeRating() {
            return this.lhsResolutionPost?.rating || null;
        },

        set activeRating(val) {
            if (this.lhsResolutionPost) {
                // Toggle off back to null if clicking already active rating
                this.lhsResolutionPost.rating = (this.lhsResolutionPost.rating === val) ? null : val;
            }
        },

        get originalRating() {
            return this.lhsResolutionPost?.original.rating || null;
        },

        getEffectiveLhsRating() {
            return this.activeRating || this.lhsPost?.rating || null;
        },

        get orderedPostIds() {
            if (!this.currentGraph) return [];
            const postIds = Array.from(this.currentGraph.posts);
            if (!this.lhsPostId) return postIds;
            const remaining = postIds.filter(id => id !== this.lhsPostId);
            return [this.lhsPostId, ...remaining];
        },

        /**
         * Get remaining source post IDs for the current step.
         * @returns {number[]}
         */
        get rhsPostIds() {
            return this.currentStep?.sourceIds || [];
        },

        /**
         * Get currently active RHS comparison post ID.
         * @returns {number|null}
         */
        get currentRhsPostId() {
            return this.rhsPostIds[this.activeRhsIndex] ?? null;
        },

        /**
         * Get all source post objects for current step.
         * @returns {ClusterPost[]}
         */
        get rhsPosts() {
            return this.rhsPostIds
                .map(id => this.getLocalClusterPost(id))
                .filter(/** @type {(p: ClusterPost|null) => p is ClusterPost} */ (p => p !== null));
        },

        /**
         * Computes the set union of all tags across all source posts in current step.
         * @returns {string[]}
         */
        get allRhsUnionTagNames() {
            if (!this.rhsPosts.length) return [];
            const tagSet = new Set();
            for (const post of this.rhsPosts) {
                if (!post || !Array.isArray(post.tags)) continue;
                for (const tag of post.tags) {
                    tagSet.add(tag);
                }
            }
            return Array.from(tagSet);
        },

        /**
         * Finds the inferior/source post object that contains a specific tag name.
         * @param {string} tagName
         * @returns {ClusterPost | null}
         */
        getRhsSourcePost(tagName) {
            if (!tagName || !this.rhsPosts.length) return null;
            return this.rhsPosts.find(p => Array.isArray(p.tags) && p.tags.includes(tagName)) || this.rhsPosts[0] || null;
        },

        /**
         * Dynamic button label based on retagging and navigation progress.
         * @returns {string}
         */
        get nextButtonLabel() {
            if (this.activeStepIndex < this.reconcileSteps.length - 1) {
                const nextStep = this.reconcileSteps[this.activeStepIndex + 1];
                if (this.currentStep?.type === 'variant' && nextStep?.type === 'variant' && nextStep.graph === this.currentStep.graph) {
                    return 'Next Post';
                }
                return 'Next Graph';
            }
            return 'Summary';
        },

        get isRatingChanged() {
            return this.activeRating !== null && this.activeRating !== this.originalRating;
        },

        get hasRatingConflict() {
            if (!this.currentGraph || this.currentGraph.type !== 'duplicate') return false;

            const graphPosts = Array.from(this.currentGraph.posts)
                .map(id => this.getLocalClusterPost(id))
                .filter(Boolean);

            const initialRatings = graphPosts.map(p => p?.rating).filter(Boolean);
            const hasMismatch = new Set(initialRatings).size > 1;

            // Rating conflict exists if original ratings differ and no rating is chosen yet
            return hasMismatch && !this.activeRating;
        },

        get hasArtistMismatch() {
            if (!this.currentGraph || this.currentGraph.type !== 'duplicate') return false;

            const graphPosts = Array.from(this.currentGraph.posts)
                .map(id => this.getLocalClusterPost(id))
                .filter(Boolean);

            if (graphPosts.length < 2) return false;

            const artistTagSets = graphPosts.map(post => {
                const sortedTags = this.getSortedTags(post);
                const artistTags = sortedTags
                    .filter(t => t.category === 'ARTIST')
                    .map(t => t.name);
                return new Set(artistTags);
            });

            const firstSet = artistTagSets[0];
            for (let i = 1; i < artistTagSets.length; i++) {
                const currentSet = artistTagSets[i];
                if (firstSet.size !== currentSet.size) return true;
                for (const tag of firstSet) {
                    if (!currentSet.has(tag)) return true;
                }
            }

            return false;
        },

        dismissArtistWarning() {
            this.isArtistWarningDismissed = true;
        },

        /**
         * Opens current post in full single-image expanded modal.
         * @param {ClusterPost | null} [post=null]
         */
        openModal(post = null) {
            if (!post || !post.fileUrl) return;

            openImageModal({
                src: post.fileUrl,
                mode: 'single',
                title: `Post #${post.postId}`,
                dimensions: this.getPostDimensions(post)
            });
        },

        /**
         * Helper to safely extract a flat array of tag strings from a target.
         * @param {any} target
         * @returns {{ flatTags: string[], post: ClusterPost | null }}
         */
        extractFlatTagsAndPost(target) {
            if (!target) return { flatTags: [], post: null };

            if (Array.isArray(target)) {
                return { flatTags: target, post: null };
            }

            const postId = target.postId || target.original?.postId;
            const localPost = postId ? this.getLocalClusterPost(postId) : null;
            const rawTags = target.tags || localPost?.tags || [];

            let flatTags = [];
            if (Array.isArray(rawTags)) {
                flatTags = rawTags;
            } else if (rawTags && typeof rawTags === 'object') {
                flatTags = Object.values(rawTags).flat();
            }

            return { flatTags, post: localPost || null };
        },

        /**
         * Delegate sorting directly to TagManager singleton.
         * @param {any} target
         */
        getSortedTags(target) {
            const { flatTags, post } = this.extractFlatTagsAndPost(target);
            return tagManager.getSortedTags(flatTags, post);
        },

        /**
         * Check if a tag is implied using TagManager instance.
         * @param {string} tagName
         * @param {any} target
         */
        isImpliedTag(tagName, target) {
            const { flatTags } = this.extractFlatTagsAndPost(target);
            return tagManager.isImpliedTag(tagName, flatTags);
        },

        /**
         * Get implication chain using TagManager instance.
         * @param {number|null} postId
         * @param {string} tagName
         * @param {any} target
         */
        getImplicationChain(postId, tagName, target) {
            const targetId = postId || target?.postId || target?.original?.postId || null;
            let flatTags = [];

            if (targetId && targetId === this.lhsPostId) {
                flatTags = this.lhsTags;
            } else {
                flatTags = this.extractFlatTagsAndPost(target).flatTags;
            }

            return tagManager.getImplicationChain(targetId, tagName, flatTags);
        },

        /**
         * @param {ClusterPost|null} post
         */
        getPostDimensions(post) {
            if (!post) return 'N/A';
            const w = post.imageWidth;
            const h = post.imageHeight;
            return (w && h) ? `${w}×${h}` : 'N/A';
        },

        /**
         * @param {string} tagName
         */
        isTagOnLhs(tagName) {
            return this.lhsTags.includes(tagName);
        },

        /**
         * Traverses implications graph directly on TagManager instance.
         * @param {string} initialTag
         */
        getAllImpliedTags(initialTag) {
            const result = new Set();
            const queue = [initialTag];

            while (queue.length > 0) {
                const current = queue.shift();
                if (!current) continue;
                const directImplied = tagManager.tagInfoMap[current]?.implies || [];

                for (const imp of directImplied) {
                    if (!result.has(imp)) {
                        result.add(imp);
                        queue.push(imp);
                    }
                }
            }
            return Array.from(result);
        },

        async startReconciliation() {
            if (this.resolutionManager) {
                this.resolutionManager.activeReconciliation = this;
            }
            this.isLoading = true;
            this.isSummary = false;
            this.initWarnings();

            try {
                if (this.resolutionManager) {
                    this.resolutionManager.initializePosts();
                }

                if (this.reconcileSteps.length === 0) {
                    this.proceedToSummary(/** @type {any} */ (this.$data));
                    return;
                }

                this.activeStepIndex = 0;
                this.setupCurrentStep();
                this.isActive = true;
            } catch (err) {
                console.error('[ReconciliationManager] Initiation error:', err);
                const message = err instanceof Error ? err.message : 'Unknown error';
                showToast(`Reconciliation error: ${message}`, 'error');
                this.closeReconciliation();
            } finally {
                this.isLoading = false;
            }
        },

        /**
         * Selects a specific reconciliation step by index.
         * @param {number} idx
         */
        selectStep(idx) {
            if (idx < 0 || idx >= this.reconcileSteps.length) return;
            this.activeStepIndex = idx;
            this.setupCurrentStep();
        },

        /**
         * Selects the first step of a graph by graph index.
         * @param {number} gIdx
         */
        selectGraph(gIdx) {
            if (gIdx < 0 || gIdx >= this.reconcileGraphs.length) return;
            const targetGraph = this.reconcileGraphs[gIdx];
            const stepIdx = this.reconcileSteps.findIndex(s => s.graph === targetGraph);
            if (stepIdx !== -1) {
                this.selectStep(stepIdx);
            }
        },

        /**
         * Selects a specific post within a graph (for manual image switching via tab dots).
         * @param {import('./resolution.js').ResolutionGraph} graph
         * @param {number} postId
         */
        selectGraphPost(graph, postId) {
            const stepIdx = this.reconcileSteps.findIndex(
                s => s.graph === graph && s.targetId === postId
            );
            if (stepIdx !== -1) {
                this.selectStep(stepIdx);
            } else {
                const gIdx = this.reconcileGraphs.indexOf(graph);
                if (gIdx !== -1) {
                    this.selectGraph(gIdx);
                }
            }
        },

        /**
         * Dynamic tab style classes depending on graph type (Amber for duplicate, Purple for variant).
         * @param {import('./resolution.js').ResolutionGraph} graph
         * @param {number} idx
         * @returns {string}
         */
        getGraphTabClass(graph, idx) {
            const isActive = this.activeGraphIndex === idx;
            const type = graph?.type || 'duplicate';

            if (type === 'variant') {
                return isActive
                    ? 'bg-purple-900/90 text-purple-200 border-purple-400 ring-1 ring-purple-400/50 shadow-md'
                    : 'bg-purple-950/40 text-purple-400/80 border-purple-900/60 hover:bg-purple-900/50 hover:text-purple-300';
            }
            // Default: Duplicate (Amber)
            return isActive
                ? 'bg-amber-900/90 text-amber-200 border-amber-400 ring-1 ring-amber-400/50 shadow-md'
                : 'bg-amber-950/40 text-amber-400/80 border-amber-900/60 hover:bg-amber-900/50 hover:text-amber-300';
        },

        /**
         * Dynamic tab label depending on graph type.
         * @param {import('./resolution.js').ResolutionGraph} graph
         * @param {number} idx
         * @returns {string}
         */
        getGraphTabLabel(graph, idx) {
            const type = graph?.type || 'duplicate';
            if (type === 'variant') return `Variant #${idx + 1}`;
            return `Dupe #${idx + 1}`;
        },

        /**
         * Prepares state for the current reconciliation step.
         * Starts all RHS image cards but the lowest non-deleted one as collapsed.
         */
        setupCurrentStep() {
            const step = this.currentStep;
            if (!step) return;

            this.lhsPostId = step.targetId;
            this.selectedSuperiorId = step.targetId;
            this.selectedParentId = null;
            this.customParentId = '';
            this.isSummary = false;
            this.isArtistWarningDismissed = false;

            // Start all RHS image cards but the lowest non-deleted one as collapsed
            this.collapsedPostIds = {};
            const rhsIds = step.sourceIds || [];
            const nonDeletedRhsIds = rhsIds.filter(id => !this.isPostDeleted(id));
            if (nonDeletedRhsIds.length > 1) {
                const lowestId = nonDeletedRhsIds[nonDeletedRhsIds.length - 1];
                for (const id of nonDeletedRhsIds) {
                    if (id !== lowestId) {
                        this.collapsedPostIds[id] = true;
                    }
                }
            }

            // Re-align after Alpine re-renders the new graph content
            this.$nextTick(() => this.alignLhsImage());
        },

        /**
         * Sets up a ResizeObserver on the RHS and LHS columns to keep the LHS image
         * viewport bottom-edge-aligned with the lowest open RHS image viewport.
         * Called via x-init on the RHS column element.
         * @param {HTMLElement} rhsEl
         */
        setupImageAlignment(rhsEl) {
            if (this._imageAlignObserver) {
                this._imageAlignObserver.disconnect();
            }

            this._imageAlignObserver = new ResizeObserver(() => {
                this.alignLhsImage();
            });
            this._imageAlignObserver.observe(rhsEl);
            if (this.$refs?.lhsColumn) {
                this._imageAlignObserver.observe(this.$refs.lhsColumn);
                const lhsCard = this.$refs.lhsColumn.querySelector('[data-lhs-card]');
                if (lhsCard) {
                    this._imageAlignObserver.observe(lhsCard);
                }
            }

            // Initial alignment after first render
            this.$nextTick(() => this.alignLhsImage());
        },

        /**
         * Aligns the LHS image viewport with the lowest open RHS image viewport
         * by computing a bidirectional bottom offset (margin-bottom on LHS or padding-bottom on RHS)
         * within their bottom-justified flex containers.
         */
        alignLhsImage() {
            const lhsCol = this.$refs?.lhsColumn;
            const rhsCol = this.$refs?.rhsColumn;
            if (!lhsCol || !rhsCol) return;

            const lhsCard = lhsCol.querySelector('[data-lhs-card]');
            const lhsViewport = lhsCol.querySelector('[data-image-viewport]');
            if (!lhsCard || !lhsViewport) {
                return;
            }

            if (this._imageAlignObserver && !lhsCard.__observed) {
                this._imageAlignObserver.observe(lhsCard);
                lhsCard.__observed = true;
            }

            // Reset any legacy top padding
            lhsCol.style.paddingTop = '0px';

            // Find all active/open RHS post IDs (not deleted and not collapsed)
            const openRhsPostIds = (this.rhsPostIds || []).filter(pId => !this.isPostDeleted(pId) && !this.isPostCollapsed(pId));

            // If no images on the right are open, everything unconditionally bottom aligns!
            if (!openRhsPostIds.length) {
                lhsCard.style.marginBottom = '0px';
                rhsCol.style.paddingBottom = '0px';
                return;
            }

            const lowestOpenPostId = openRhsPostIds[openRhsPostIds.length - 1];
            const lowestRhsViewport = rhsCol.querySelector(`[data-post-viewport="${lowestOpenPostId}"]`);

            if (!lowestRhsViewport) {
                lhsCard.style.marginBottom = '0px';
                rhsCol.style.paddingBottom = '0px';
                return;
            }

            const currentRhsPadding = parseFloat(rhsCol.style.paddingBottom) || 0;
            const rhsColRect = rhsCol.getBoundingClientRect();
            const lowestRhsRect = lowestRhsViewport.getBoundingClientRect();
            // Measure the unpadded natural trailing height below the lowest RHS viewport
            const rhsTrailingHeight = Math.max(0, (rhsColRect.bottom - currentRhsPadding) - lowestRhsRect.bottom);

            const lhsCardRect = lhsCard.getBoundingClientRect();
            const lhsViewportRect = lhsViewport.getBoundingClientRect();
            // Trailing height below the LHS viewport (e.g. open Description / Sources)
            const lhsTrailingHeight = Math.max(0, lhsCardRect.bottom - lhsViewportRect.bottom);

            if (rhsTrailingHeight >= lhsTrailingHeight) {
                // RHS has more trailing content (e.g. collapsed cards below lowest open image)
                const lhsOffset = rhsTrailingHeight - lhsTrailingHeight;
                lhsCard.style.marginBottom = `${lhsOffset}px`;
                rhsCol.style.paddingBottom = '0px';
            } else {
                // LHS has more trailing content (e.g. LHS description/sources are open)
                // RHS column receives bottom padding so its content moves up to match the LHS image
                const rhsOffset = lhsTrailingHeight - rhsTrailingHeight;
                lhsCard.style.marginBottom = '0px';
                rhsCol.style.paddingBottom = `${rhsOffset}px`;
            }
        },

        /**
         * @param {string} tagName
         */
        addTagWithImplications(tagName) {
            const resPost = this.lhsResolutionPost;
            if (!resPost) return;

            const fullImpliedChain = this.getAllImpliedTags(tagName);
            const tagsToAdd = [tagName, ...fullImpliedChain];

            tagsToAdd.forEach(t => {
                if (!resPost.tags.includes(t)) {
                    resPost.tags.push(t);
                }
            });
        },

        /**
         * @param {TagObj|string} tagObj
         */
        removeTagWithImplicators(tagObj) {
            const resPost = this.lhsResolutionPost;
            if (!resPost) return;

            const tagName = typeof tagObj === 'string' ? tagObj : tagObj.name;

            if (alpineHelpers.tagpill.isTagLocked(tagName, resPost.original)) {
                console.warn(`Cannot remove tag '${tagName}' because it is locked.`);
                return;
            }

            const chain = this.getImplicationChain(this.lhsPostId, tagName, resPost.tags);

            const toRemove = new Set([tagName]);
            if (chain) {
                chain.directImplicators?.forEach(t => toRemove.add(t));
                chain.indirectImplicators?.forEach(t => toRemove.add(t));
            }

            const hasLockedImplication = Array.from(toRemove).some(t =>
                alpineHelpers.tagpill.isTagLocked(t, resPost.original)
            );

            if (hasLockedImplication) {
                console.warn(`Cannot remove tag '${tagName}' because its deletion would cascade to a locked tag.`);
                return;
            }

            resPost.tags = resPost.tags.filter(t => !toRemove.has(t));
        },

        addCustomTag() {
            const cleaned = this.tagInput.trim().toLowerCase().replace(/\s+/g, '_');
            if (cleaned) {
                this.addTagWithImplications(cleaned);
            }
            this.tagInput = '';
        },

        /**
         * Advances reconciliation through steps (duplicate graphs, variant post steps), or to Summary.
         * @param {RootData} rootData
         */
        advance(rootData) {
            if (this.warnings.isBlocked(this.activeStepIndex, this)) return;

            if (this.activeStepIndex < this.reconcileSteps.length - 1) {
                this.selectStep(this.activeStepIndex + 1);
            } else {
                this.proceedToSummary(rootData);
            }
        },

        closeReconciliation() {
            this.isActive = false;
            this.isLoading = false;

            if (this.resolutionManager && this.resolutionManager.activeReconciliation === this) {
                this.resolutionManager.activeReconciliation = null;
            }
        },

        /**
         * @param {RootData | null} [rootData]
         */
        proceedToSummary(rootData) {
            this.closeReconciliation();
            if (rootData) {
                setTimeout(() => {
                    rootData.activeView = 'summary';
                }, 0);
            }
        },
    };
}

// Alpine Component Registration
document.addEventListener('alpine:init', () => {
    if (window.Alpine) {
        window.Alpine.data('ReconciliationManager', ReconciliationManager);
    }

    Alpine.data('tagAutocomplete', () => ({
        /** @type {TagSearchResult[]} */
        results: [],
        isOpen: false,
        selectedIndex: -1,
        /** @type {ReturnType<setTimeout>|undefined} */
        debounceTimer: undefined,

        /**
         * Debounced input handler (300ms delay)
         */
        onInput() {
            clearTimeout(this.debounceTimer);
            this.selectedIndex = -1;

            /** @type {string} */
            // @ts-expect-error - tagInput is inherited from parent scope in Alpine
            const inputVal = this.tagInput || '';

            if (!inputVal.trim()) {
                this.results = [];
                this.isOpen = false;
                return;
            }

            this.debounceTimer = setTimeout(() => {
                this.fetchResults(inputVal, 20);
            }, 300);
        },

        /**
         * Executes search using TagManager binary index
         * @param {string} query
         * @param {number} k
         */
        fetchResults(query, k = 10) {
            this.results = tagManager.searchTags(query, k);
            this.isOpen = this.results.length > 0;
        },

        /**
         * Keyboard navigation (Up / Down arrows)
         * @param {number} direction
         */
        navigate(direction) {
            if (!this.isOpen || this.results.length === 0) return;

            this.selectedIndex += direction;
            if (this.selectedIndex < 0) {
                this.selectedIndex = this.results.length - 1;
            } else if (this.selectedIndex >= this.results.length) {
                this.selectedIndex = 0;
            }
        },

        /**
         * Triggers when pressing Enter in input
         */
        selectCurrentOrAdd() {
            if (this.isOpen && this.selectedIndex >= 0 && this.results[this.selectedIndex]) {
                this.selectResult(this.results[this.selectedIndex]);
            } else {
                this.commitTag();
            }
        },

        /**
         * Selects a result item, updates input, and triggers add
         * @param {TagSearchResult} tagObj
         */
        selectResult(tagObj) {
            // @ts-expect-error - tagInput is inherited from parent scope
            this.tagInput = tagObj.name;
            this.isOpen = false;
            this.results = [];

            this.commitTag();
        },

        /**
         * Safe dispatcher to trigger tag addition on parent scope
         */
        commitTag() {
            /** @type {import('alpinejs').AlpineComponent<any>} */
            // @ts-ignore - $dispatch is an Alpine magic property
            const el = this;

            if (typeof el.$dispatch === 'function') {
                el.$dispatch('add-tag');
            } else if (typeof el.addCustomTag === 'function') {
                el.addCustomTag();
            }
        },

        /**
         * Formats large counts cleanly (e.g. 12500 -> 12.5k)
         * @param {number} count
         */
        formatCount(count) {
            if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
            if (count >= 1000) return (count / 1000).toFixed(1) + 'k';
            return count.toString();
        }
    }));
});