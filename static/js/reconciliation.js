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

/** @type {any} */
let globalActiveReconciliation = null;

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

        activeGraphIndex: 0,
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
         * Filter resolution graphs for reconciliation tabs (duplicates, variants, unrelated).
         * @returns {import('./resolution.js').ResolutionGraph[]}
         */
        get reconcileGraphs() {
            if (!this.resolutionManager?.graphs) return [];
            return this.resolutionManager.graphs.filter(g => g.type === 'duplicate' || g.type === 'variant' || g.type === 'unrelated');
        },

        /**
         * Backward-compatible alias for duplicateGraphs.
         * @returns {import('./resolution.js').ResolutionGraph[]}
         */
        get duplicateGraphs() {
            return this.reconcileGraphs;
        },

        /**
         * Get current active ResolutionGraph.
         * @returns {import('./resolution.js').ResolutionGraph|null}
         */
        get currentGraph() {
            return this.reconcileGraphs[this.activeGraphIndex] || null;
        },

        /**
         * Retrieves the editable working state ResolutionPost for the active LHS post.
         * @returns {ResolutionPost|undefined}
         */
        get lhsResolutionPost() {
            if (!this.currentGraph || !this.lhsPostId) return undefined;
            return this.resolutionManager.getPost(this.lhsPostId);
        },

        /**
         * @param {number} postId
         * @returns {ClusterPost | null}
         */
        getLocalClusterPost(postId) {
            return this.resolutionManager?.getPost?.(postId)?.original || null;
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
         * Get remaining post IDs in current graph excluding the kept superior post.
         * @returns {number[]}
         */
        get rhsPostIds() {
            if (!this.currentGraph || !this.selectedSuperiorId) return [];
            return Array.from(this.currentGraph.posts).filter(id => id !== this.selectedSuperiorId);
        },

        /**
         * Get currently active RHS comparison post ID.
         * @returns {number|null}
         */
        get currentRhsPostId() {
            return this.rhsPostIds[this.activeRhsIndex] ?? null;
        },

        /**
         * Get all inferior post objects in current graph.
         * @returns {ClusterPost[]}
         */
        get rhsPosts() {
            if (!this.currentGraph || !this.selectedSuperiorId) return [];
            return this.rhsPostIds
                .map(id => this.getLocalClusterPost(id))
                .filter(/** @type {(p: ClusterPost|null) => p is ClusterPost} */ (p => p !== null));
        },

        /**
         * Computes the set union of all tags across all inferior posts in current graph.
         * @returns {string[]}
         */
        get allRhsUnionTagNames() {
            if (!this.currentGraph || !this.selectedSuperiorId) return [];
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
         * Finds the inferior source post object that contains a specific tag name.
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
            if (this.activeGraphIndex < this.duplicateGraphs.length - 1) {
                return 'Next Graph';
            }
            return 'Summary';
        },

        get isRatingChanged() {
            return this.activeRating !== null && this.activeRating !== this.originalRating;
        },

        get hasRatingConflict() {
            if (!this.currentGraph) return false;

            const graphPosts = Array.from(this.currentGraph.posts)
                .map(id => this.getLocalClusterPost(id))
                .filter(Boolean);

            const initialRatings = graphPosts.map(p => p?.rating).filter(Boolean);
            const hasMismatch = new Set(initialRatings).size > 1;

            // Rating conflict exists if original ratings differ and no rating is chosen yet
            return hasMismatch && !this.activeRating;
        },

        get hasArtistMismatch() {
            if (!this.currentGraph) return false;

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
            if (globalActiveReconciliation && globalActiveReconciliation !== this) {
                globalActiveReconciliation.closeReconciliation();
            }
            globalActiveReconciliation = this;
            if (this.resolutionManager) {
                this.resolutionManager.activeReconciliation = this;
            }
            this.isLoading = true;
            this.isSummary = false;
            this.initWarnings();

            try {
                if (this.resolutionManager) {
                    this.resolutionManager.initializePosts();
                    this.resolutionManager.ensureDefaultDuplicateGraph();
                }

                if (this.duplicateGraphs.length === 0) {
                    if ((this.resolutionManager?.graphs?.length || 0) > 0) {
                        this.proceedToSummary(/** @type {any} */ (this.$data));
                        return;
                    }
                    throw new Error('No duplicate graphs found in ResolutionManager to reconcile.');
                }

                this.activeGraphIndex = 0;
                this.setupCurrentGraph();
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
         * @param {number} idx
         */
        selectGraph(idx) {
            if (idx < 0 || idx >= this.duplicateGraphs.length) return;
            this.activeGraphIndex = idx;
            this.setupCurrentGraph();
        },

        /**
         * Dynamic tab style classes depending on graph type (Amber, Purple, Gray).
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
            if (type === 'unrelated') {
                return isActive
                    ? 'bg-gray-800 text-gray-100 border-gray-400 ring-1 ring-gray-400/50 shadow-md'
                    : 'bg-gray-900/60 text-gray-400 border-gray-800 hover:bg-gray-800 hover:text-gray-200';
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
            if (type === 'unrelated') return `Unrelated #${idx + 1}`;
            return `Dupe #${idx + 1}`;
        },

        /**
         * Automatically binds superior post from graph.head and prepares graph state.
         */
        setupCurrentGraph() {
            if (!this.currentGraph) return;

            const graphPostIds = Array.from(this.currentGraph.posts);

            // Find first active (undeleted & unflagged) post in the graph
            const activePostId = graphPostIds.find(pId => {
                const post = this.getLocalClusterPost(pId);
                return post && !post.isDeleted && !post.isFlagged;
            });

            // Retrieve superior post: validate existing graph.head or select remaining active post
            let superiorId = this.currentGraph.head;
            if (superiorId) {
                const headPost = this.getLocalClusterPost(superiorId);
                if (!headPost || headPost.isDeleted || headPost.isFlagged) {
                    superiorId = activePostId || graphPostIds[0];
                }
            } else {
                superiorId = activePostId || graphPostIds[0];
            }

            this.currentGraph.head = superiorId;
            this.selectedSuperiorId = superiorId;
            this.lhsPostId = superiorId;
            this.selectedParentId = null;
            this.customParentId = '';
            this.activeRhsIndex = 0;
            this.isSummary = false;
            this.isArtistWarningDismissed = false;

            // Only mark non-head posts for deletion/flagging if graph is duplicate
            if (this.currentGraph.type === 'duplicate') {
                for (const pId of this.currentGraph.posts) {
                    const resPost = this.resolutionManager.getPost(pId);
                    if (resPost) {
                        resPost.flag = (pId !== superiorId);
                    }
                }
                // Collapse graph and update referencing variant graphs
                this.resolutionManager.resolveDuplicateGraph(this.currentGraph);
            }

            // Re-align after Alpine re-renders the new graph content
            this.$nextTick(() => this.alignLhsImage());
        },

        /**
         * Sets up a ResizeObserver on the RHS column to keep the LHS image
         * viewport bottom-edge-aligned with the last RHS image viewport.
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

            // Initial alignment after first render
            this.$nextTick(() => this.alignLhsImage());
        },

        /**
         * Aligns the LHS image viewport bottom edge with the last RHS image
         * viewport bottom edge by computing padding-top on the LHS column.
         *
         * Uses incremental math: newPadding = max(0, currentPadding + (rhsBottom - lhsBottom)).
         * The currentPadding cancels out algebraically, so this converges in one step
         * regardless of existing padding state.
         */
        alignLhsImage() {
            const lhsCol = this.$refs?.lhsColumn;
            const rhsCol = this.$refs?.rhsColumn;
            if (!lhsCol || !rhsCol) return;

            const lhsViewport = lhsCol.querySelector('[data-image-viewport]');
            const rhsViewports = rhsCol.querySelectorAll('[data-image-viewport]');

            if (!lhsViewport || !rhsViewports.length) {
                lhsCol.style.paddingTop = '0px';
                return;
            }

            const lastRhsViewport = rhsViewports[rhsViewports.length - 1];
            const lhsBottom = lhsViewport.getBoundingClientRect().bottom;
            const rhsBottom = lastRhsViewport.getBoundingClientRect().bottom;
            const currentPadding = parseFloat(lhsCol.style.paddingTop) || 0;
            const newPadding = Math.max(0, currentPadding + (rhsBottom - lhsBottom));

            lhsCol.style.paddingTop = newPadding + 'px';
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
         * Advances reconciliation through RHS posts, duplicate graphs, or to Summary.
         * @param {RootData} rootData
         */
        advance(rootData) {
            if (this.warnings.isBlocked(this.activeGraphIndex, this)) return;

            if (this.activeGraphIndex < this.duplicateGraphs.length - 1) {
                this.selectGraph(this.activeGraphIndex + 1);
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

            if (globalActiveReconciliation === this) {
                globalActiveReconciliation = null;
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