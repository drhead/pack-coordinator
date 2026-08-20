// @ts-check

import { showToast } from './toasts.js';
import { openImageModal } from './image_modal.js';
import { ensureClusterPostsInfo, fetchE621Post } from './e621_api.js';
import { WarningsManager } from './warnings.js';
import { batchManager } from './batches.js';

/**
 * @typedef {Object} RootData
 * @property {string} activeView
 */

/**
 * Alpine component factory for Stage 2: The Association Screen.
 * @param {ResolutionManagerComponent} resMgr
 */
export function AssociationManager(resMgr) {
    return {
        isActive: false,
        isLoading: false,
        activeGraphIndex: 0,

        warnings: new WarningsManager(),

        initWarnings() {
            this.warnings.registerRules([
                {
                    id: 'waiting-for-pool',
                    type: 'hard',
                    icon: '🛟',
                    title: 'Waiting for Pool Creation',
                    message: () => "Create the pool on e621, then click 'Check for Pool' to verify and proceed.",
                    check: (ctx) => Boolean(ctx.isPoolDelegated && !ctx.poolVerified)
                }
            ]);
        },

        /** @type {ResolutionManagerComponent} */
        resolutionManager: resMgr,

        /** @type {number|null} */
        selectedParentId: null,

        /** @type {string} */
        externalParentInput: '',

        /** @type {ClusterPost|null} */
        externalParentPost: null,
        isFetchingExternal: false,

        /** Pool Delegation State */
        isPoolDelegated: false,
        /** @type {ReturnType<typeof setInterval>|null} */
        poolPollingInterval: null,
        poolVerified: false,
        isPolling: false,
        isCheckingPool: false,

        /**
         * Filter resolution graphs down to variant graphs only.
         * @returns {import('./resolution.js').ResolutionGraph[]}
         */
        get variantGraphs() {
            if (!this.resolutionManager?.graphs) return [];
            return this.resolutionManager.graphs.filter(g => g.type === 'variant');
        },

        /**
         * Current active variant graph.
         * @returns {import('./resolution.js').ResolutionGraph|null}
         */
        get currentGraph() {
            return this.variantGraphs[this.activeGraphIndex] || null;
        },

        /**
         * Gets post object for a given post ID (from resolutionManager or external parent).
         * @param {number} postId
         * @returns {ClusterPost|null}
         */
        getPost(postId) {
            if (this.externalParentPost && this.externalParentPost.postId === postId) {
                return this.externalParentPost;
            }
            return this.resolutionManager?.getPost(postId)?.original || null;
        },

        /**
         * List of post IDs in current variant graph.
         * @returns {number[]}
         */
        get graphPostIds() {
            if (!this.currentGraph) return [];
            return Array.from(this.currentGraph.posts);
        },

        /**
         * List of child post IDs in current variant graph (all except selected parent).
         * @returns {number[]}
         */
        get childPostIds() {
            if (!this.currentGraph) return [];
            return this.graphPostIds.filter(id => id !== this.selectedParentId);
        },

        /**
         * Copyable space-separated post IDs for e621 pool creation helper (e.g. "101 102").
         * @returns {string}
         */
        get copyablePoolIds() {
            return this.graphPostIds.join(' ');
        },

        /**
         * Aborts pool delegation and restores standard variant structuring.
         */
        cancelPoolDelegation() {
            this.stopPoolPolling();
            this.isPoolDelegated = false;
            this.poolVerified = false;
        },

        /**
         * Initializes association view and selects initial candidate parent.
         */
        init() {
            this.initWarnings();
            this.setupCurrentGraph();
            this.isActive = true;
        },

        /**
         * Prepares state for active variant graph index.
         */
        setupCurrentGraph() {
            this.stopPoolPolling();
            this.isPoolDelegated = false;
            this.poolVerified = false;
            this.externalParentPost = null;
            this.externalParentInput = '';

            if (!this.currentGraph) return;

            const postIds = Array.from(this.currentGraph.posts);
            if (postIds.length === 0) return;

            // Determine best initial parent candidate:
            // 1. Existing graph.head if present
            // 2. Or post with existing parentId pointing to it from siblings
            // 3. Or first unflagged/undeleted post with lowest ID
            let candidateId = this.currentGraph.head ?? null;

            if (!candidateId || !postIds.includes(candidateId)) {
                const activePosts = postIds
                    .map(id => this.getPost(id))
                    .filter(/** @type {(p: ClusterPost|null) => p is ClusterPost} */ (p => Boolean(p && !p.isDeleted && !p.isFlagged)))
                    .sort((a, b) => a.postId - b.postId);

                candidateId = activePosts[0]?.postId || postIds[0];
            }

            this.selectedParentId = candidateId;
        },

        /**
         * Selects a specific graph index.
         * @param {number} idx
         */
        selectGraph(idx) {
            if (idx < 0 || idx >= this.variantGraphs.length) return;
            this.activeGraphIndex = idx;
            this.setupCurrentGraph();
        },

        /**
         * Selects a post within the cluster as Parent.
         * @param {number} postId
         */
        selectParent(postId) {
            this.externalParentPost = null;
            this.selectedParentId = postId;
        },

        async fetchExternalParent() {
            const raw = this.externalParentInput.trim().replace(/^#/, '');
            const extId = parseInt(raw, 10);

            if (isNaN(extId) || extId <= 0) {
                showToast('Please enter a valid numeric Post ID.', 'warning');
                return;
            }

            // If the post ID belongs to the current cluster, bypass e621 API
            const clusterPost = this.resolutionManager?.getPost(extId)?.original 
                || this.resolutionManager?.cluster?.posts?.find(p => p.postId === extId);

            if (clusterPost) {
                this.externalParentPost = null;
                this.selectedParentId = extId;
                showToast(`Selected #${extId} from cluster as parent candidate.`, 'success');
                return;
            }

            this.isFetchingExternal = true;
            try {
                this.externalParentPost = await fetchE621Post(extId);
                this.selectedParentId = extId;
                showToast(`Loaded external post #${extId} as parent candidate.`, 'success');
            } catch (err) {
                console.error('[AssociationManager] Error loading external parent:', err);
                const message = err instanceof Error ? err.message : 'Failed to fetch external post';
                showToast(message, 'error');
            } finally {
                this.isFetchingExternal = false;
            }
        },

        /**
         * Copies pool helper search string to clipboard.
         */
        async copyPoolSearchString() {
            try {
                await navigator.clipboard.writeText(this.copyablePoolIds);
                showToast('Post IDs copied to clipboard!', 'success');
            } catch {
                showToast('Failed to copy to clipboard.', 'error');
            }
        },

        /**
         * Starts background polling every 5s checking if all active variant posts share a pool.
         */
        startPoolPolling() {
            this.stopPoolPolling();
            this.isPoolDelegated = true;
            this.isPolling = true;

            const checkPools = async () => {
                try {
                    const posts = this.graphPostIds
                        .map(id => this.getPost(id))
                        .filter(/** @type {(p: ClusterPost|null) => p is ClusterPost} */ (p => Boolean(p)));

                    if (typeof ensureClusterPostsInfo === 'function') {
                        await ensureClusterPostsInfo(posts);
                    }

                    // Check if all active posts share at least 1 common pool ID
                    const activePosts = posts.filter(p => !p.isDeleted && !p.isFlagged);
                    if (activePosts.length >= 2) {
                        const firstPools = new Set(activePosts[0].poolIds || []);
                        const hasShared = Array.from(firstPools).some(pId =>
                            activePosts.every(p => (p.poolIds || []).includes(pId))
                        );

                        if (hasShared) {
                            this.poolVerified = true;
                            showToast('Pool membership verified on e621!', 'success');
                            this.stopPoolPolling();
                        }
                    }
                } catch (err) {
                    console.debug('[AssociationManager] Pool poll check:', err);
                }
            };

            checkPools();
            this.poolPollingInterval = setInterval(checkPools, 5000);
        },

        /**
         * Stops background pool polling.
         */
        stopPoolPolling() {
            if (this.poolPollingInterval) {
                clearInterval(this.poolPollingInterval);
                this.poolPollingInterval = null;
            }
            this.isPolling = false;
        },

        /**
         * Manually triggers a pool check and refreshes the batch.
         */
        async checkForPool() {
            if (this.isCheckingPool) return;
            this.isCheckingPool = true;
            try {
                // If activeBatch exists, trigger batch refresh
                if (batchManager.activeBatch) {
                    await batchManager.refreshBatch(batchManager.activeBatch);
                }

                // Check active variant posts for pool membership
                const posts = this.graphPostIds
                    .map(id => this.getPost(id))
                    .filter(/** @type {(p: ClusterPost|null) => p is ClusterPost} */ (p => Boolean(p)));

                if (typeof ensureClusterPostsInfo === 'function') {
                    await ensureClusterPostsInfo(posts);
                }

                const activePosts = posts.filter(p => !p.isDeleted && !p.isFlagged);
                if (activePosts.length >= 2) {
                    const firstPools = new Set(activePosts[0].poolIds || []);
                    const hasShared = Array.from(firstPools).some(pId =>
                        activePosts.every(p => (p.poolIds || []).includes(pId))
                    );

                    if (hasShared) {
                        this.poolVerified = true;
                        this.stopPoolPolling();
                        showToast('Pool membership verified on e621!', 'success');
                        return;
                    }
                }

                showToast('No shared pool detected yet. Check again once created on e621.', 'info');
            } catch (err) {
                console.error('[AssociationManager] Error checking pool:', err);
                showToast('Failed to check pool status.', 'error');
            } finally {
                this.isCheckingPool = false;
            }
        },

        /**
         * Opens image in modal preview.
         * @param {ClusterPost|null} post
         */
        openModal(post) {
            if (!post || !post.fileUrl) return;
            openImageModal({
                src: post.fileUrl,
                mode: 'single',
                title: `Post #${post.postId}`,
                dimensions: `${post.imageWidth || '?'}×${post.imageHeight || '?'}`
            });
        },

        /**
         * Confirms the parenting structure for the active variant graph and advances workflow.
         * @param {RootData} rootData
         */
        confirmAssociation(rootData) {
            if (this.currentGraph && this.selectedParentId) {
                this.resolutionManager.flattenVariantHierarchy(this.currentGraph, this.selectedParentId);
            }

            this.stopPoolPolling();

            // If more variant graphs exist, advance to next variant graph
            if (this.activeGraphIndex < this.variantGraphs.length - 1) {
                this.selectGraph(this.activeGraphIndex + 1);
            } else {
                // All variant graphs structured -> advance to Tag Reconciliation
                showToast('Variant relationships structured successfully!', 'success');
                if (rootData) {
                    setTimeout(() => {
                        rootData.activeView = 'reconcile';
                    }, 0);
                }
            }
        }
    };
}

// Alpine Component Registration
document.addEventListener('alpine:init', () => {
    if (window.Alpine) {
        window.Alpine.data('AssociationManager', AssociationManager);
    }
});
