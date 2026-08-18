// @ts-check

import { decode } from '@msgpack/msgpack';
import { getBlacklistEvaluator, applyBlacklistToCluster } from './blacklist.js';
import { showToast } from './toasts.js';

/**
 * Pure formatting function for ISO lease expiration string -> "MM:SS"
 * @param {number|string} nowTimestamp
 * @param {string|null|undefined} [isoDateStr]
 * @returns {string}
 */
export function getRemainingTimeString(nowTimestamp, isoDateStr) {
    let now = typeof nowTimestamp === 'number' ? nowTimestamp : Date.now();
    let iso = typeof nowTimestamp === 'string' && !isoDateStr ? nowTimestamp : isoDateStr;
    if (!iso) return '';

    const expiry = new Date(iso).getTime();
    const diff = Math.max(0, Math.floor((expiry - now) / 1000));

    if (diff <= 0) return '';

    const minutes = Math.floor(diff / 60);
    const seconds = diff % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Prepares cluster posts for blacklisting, sorting, and state flags.
 * @param {Cluster} c
 * @param {boolean} [forceReset=false]
 */
export function processCluster(c, forceReset = false) {
    applyBlacklistToCluster(c, getBlacklistEvaluator());

    if (forceReset || c.collapsed === undefined) {
        c.collapsed = c.isResolved || c.isBlacklisted;
    }
}

/**
 * Pure display helper for batch status labels.
 * @param {Batch} batch
 * @returns {string}
 */
export function getBatchStatusLabel(batch) {
    if (!batch) return 'AVAILABLE';
    if (batch.status === 'CLAIMED') {
        return batch.isLeasedByYou ? 'CLAIMED BY YOU' : 'CLAIMED';
    }
    return batch.status;
}

/**
 * Pure display helper for batch status Tailwind CSS classes.
 * @param {Batch} batch
 * @returns {string}
 */
export function getBatchStatusClass(batch) {
    if (!batch) return 'bg-blue-950 text-blue-400 border border-blue-800/50';
    const st = batch.status || 'AVAILABLE';
    switch (st) {
        case 'COMPLETE':
            return 'bg-green-950 text-green-400 border border-green-800/50';
        case 'CLAIMED':
            return 'bg-amber-950 text-amber-400 border border-amber-800/50';
        case 'AVAILABLE':
        default:
            return 'bg-blue-950 text-blue-400 border border-blue-800/50';
    }
}

/**
 * Calculates completion percentage.
 * @param {number} resolved
 * @param {number} total
 * @returns {number}
 */
export function getProgressPercent(resolved, total) {
    if (!total || total <= 0) return 0;
    return Math.min(100, Math.round((resolved / total) * 100));
}

/**
 * Safely reads resolved cluster count from a project.
 * @param {Project} project
 * @returns {number}
 */
export function getProjectResolvedCount(project) {
    return project?.resolvedClusters || 0;
}

/**
 * Safely reads total cluster count from a project.
 * @param {Project} project
 * @returns {number}
 */
export function getProjectTotalCount(project) {
    return project?.totalClusters || 0;
}

export class BatchManager {
    constructor() {
        /** @type {Project|null} */
        this.activeProject = null;
        /** @type {Batch[]} */
        this.batches = [];
        /** @type {Batch|null} */
        this.activeBatch = null;
        /** @type {Lease|null} */
        this.activeLease = null;
        /** @type {number} */
        this.nowTimestamp = Date.now();
        /** @type {ReturnType<typeof setInterval>|null} */
        this.pollInterval = null;
        /** @type {ReturnType<typeof setInterval>|null} */
        this.timerInterval = null;
    }

    /**
     * Self-initializes internal tickers for lease expirations and background polling.
     */
    init() {
        this.startTimer();
        this.startBackgroundPolling();
    }

    /**
     * Internal 1-second ticker that keeps nowTimestamp fresh and checks local expirations.
     */
    startTimer() {
        if (this.timerInterval) clearInterval(this.timerInterval);
        this.timerInterval = setInterval(() => {
            this.nowTimestamp = Date.now();
            this.checkLocalLeaseExpiration();
        }, 1000);
    }

    /**
     * Checks for expired local leases or batch lease states and refreshes batches if needed.
     */
    checkLocalLeaseExpiration() {
        let needsReload = false;

        if (this.activeLease && this.activeLease.leasedUntil) {
            const expiry = new Date(this.activeLease.leasedUntil).getTime();
            if (expiry <= this.nowTimestamp) {
                this.activeLease = null;
                needsReload = true;
            }
        }

        for (const batch of this.batches) {
            if (batch.status === 'CLAIMED' && batch.leasedUntil) {
                const expiry = new Date(batch.leasedUntil).getTime();
                if (expiry <= this.nowTimestamp) {
                    batch.status = 'AVAILABLE';
                    batch.isLeasedByYou = false;
                    batch.leasedUntil = null;
                    needsReload = true;
                }
            }
        }

        if (needsReload) {
            this.reloadBatches(true);
        }
    }

    /**
     * Formats an ISO expiration date string using the store's reactive timestamp.
     * @param {string|null|undefined} isoDateStr
     * @returns {string}
     */
    getRemainingTime(isoDateStr) {
        return getRemainingTimeString(this.nowTimestamp, isoDateStr);
    }

    /**
     * Selects an active project and reloads its associated batches.
     * @param {Project[]} projects
     * @param {string} projectId
     */
    selectProject(projects, projectId) {
        this.activeProject = (projects || []).find(p => p.projectId === projectId) || null;
        return this.reloadBatches();
    }

    /**
     * Fetches batches and active leases, updating state and reconciling cluster data in-place.
     * @param {boolean} [silent=false]
     * @param {number|null} [refreshedClusterId=null]
     * @param {boolean} [forceCollapseReset=false]
     */
    async reloadBatches(silent = false, refreshedClusterId = null, forceCollapseReset = false) {
        if (!this.activeProject) return;

        try {
            // 1. Fetch public batch data and dynamic leases in parallel
            const [batchesRes, leasesRes] = await Promise.all([
                fetch(`/api/v1/projects/${this.activeProject.projectId}/batches`, {
                    headers: { 'Accept': 'application/msgpack' }
                }),
                fetch('/api/v1/leases')
            ]);

            if (!batchesRes.ok) return;

            const batchesBuffer = await batchesRes.arrayBuffer();
            const batchesData = /** @type {{ batches: Batch[] }} */ (decode(batchesBuffer));
            const activeLeases = leasesRes.ok ? /** @type {{ leases: Lease[] }} */ (await leasesRes.json()).leases || [] : [];
            const incomingBatches = batchesData.batches || [];

            // 2. Index active leases by batchId for O(1) lookups
            /** @type {Map<number, Lease>} */
            const activeLeasesMap = new Map();
            /** @type {Lease|null} */
            let myActiveLease = null;

            for (const lease of activeLeases) {
                const expiry = new Date(lease.leasedUntil).getTime();
                if (expiry <= this.nowTimestamp) continue; // Skip expired

                activeLeasesMap.set(lease.batchId, lease);

                // Track current user's active lease for top banner
                if (lease.projectId === this.activeProject.projectId && lease.isLeasedByYou) {
                    myActiveLease = {
                        batchId: lease.batchId,
                        batchNumber: lease.batchNumber,
                        projectId: lease.projectId,
                        leasedUntil: lease.leasedUntil,
                        isLeasedByYou: true
                    };
                }
            }
            this.activeLease = myActiveLease;

            /**
             * Syncs dynamic lease state from the activeLeasesMap onto a batch object.
             * @param {Batch} batch
             * @returns {void}
             */
            const syncBatchLeaseState = (batch) => {
                const lease = activeLeasesMap.get(batch.batchId);
                if (lease) {
                    batch.leasedUntil = lease.leasedUntil;
                    batch.isLeasedByYou = Boolean(lease.isLeasedByYou);
                    if (batch.status !== 'COMPLETE') {
                        batch.status = 'CLAIMED';
                    }
                } else if (this.activeLease && this.activeLease.batchId === batch.batchId && this.activeLease.isLeasedByYou) {
                    batch.leasedUntil = this.activeLease.leasedUntil;
                    batch.isLeasedByYou = true;
                    if (batch.status !== 'COMPLETE') {
                        batch.status = 'CLAIMED';
                    }
                } else {
                    batch.leasedUntil = null;
                    batch.isLeasedByYou = false;
                    if (batch.status === 'CLAIMED') {
                        batch.status = 'AVAILABLE';
                    }
                }
            };

            // 3. Reconcile incoming batches into state
            if (this.batches.length === 0) {
                incomingBatches.forEach((b) => {
                    syncBatchLeaseState(b);
                    if (b.clusters) {
                        b.clusters.forEach((c) => {
                            processCluster(c);
                            c.isRefreshing = false;
                        });
                    } else {
                        b.clusters = [];
                    }
                });
                this.batches = incomingBatches;
            } else {
                for (const newBatch of incomingBatches) {
                    let existingBatch = this.batches.find(b => b.batchId === newBatch.batchId);

                    if (!existingBatch) {
                        syncBatchLeaseState(newBatch);
                        if (newBatch.clusters) {
                            newBatch.clusters.forEach((c) => {
                                processCluster(c);
                                c.isRefreshing = false;
                            });
                        } else {
                            newBatch.clusters = [];
                        }
                        this.batches.push(newBatch);
                        continue;
                    }

                    // Update core public fields from /batches
                    existingBatch.status = newBatch.status;
                    existingBatch.resolvedCount = newBatch.resolvedCount;
                    existingBatch.totalClusters = newBatch.totalClusters;

                    // Sync dynamic lease state from /leases
                    syncBatchLeaseState(existingBatch);

                    if (!existingBatch.clusters) {
                        existingBatch.clusters = [];
                    }

                    const isCurrentlyInspecting = this.activeBatch && (this.activeBatch.batchId === newBatch.batchId);

                    if (isCurrentlyInspecting && newBatch.clusters) {
                        for (let i = 0; i < newBatch.clusters.length; i++) {
                            const newCluster = newBatch.clusters[i];
                            let existingCluster = existingBatch.clusters.find((c) => c.clusterId === newCluster.clusterId);

                            if (existingCluster) {
                                existingCluster.note = newCluster.note;
                                existingCluster.isResolved = newCluster.isResolved;
                                existingCluster.manualResolution = newCluster.manualResolution;

                                // Reconcile posts in-place to retain object identity & tag cache
                                if (refreshedClusterId === existingCluster.clusterId) {
                                    existingCluster.posts = newCluster.posts || [];
                                } else if (newCluster.posts && Array.isArray(newCluster.posts)) {
                                    const existingPostsMap = new Map((existingCluster.posts || []).map((p) => [p.postId, p]));

                                    existingCluster.posts = newCluster.posts.map((newPost) => {
                                        const existingPost = existingPostsMap.get(newPost.postId);

                                        if (existingPost) {
                                            const tagsChanged = JSON.stringify(existingPost.tags) !== JSON.stringify(newPost.tags);

                                            Object.assign(existingPost, newPost);

                                            if (tagsChanged) {
                                                delete existingPost._tagsSignature;
                                                delete existingPost._sortedTags;
                                            }
                                            return existingPost;
                                        }
                                        return newPost;
                                    });
                                }

                                processCluster(existingCluster, forceCollapseReset);

                                if (refreshedClusterId && existingCluster.clusterId === refreshedClusterId) {
                                    existingCluster.isRefreshing = false;
                                }
                            } else {
                                processCluster(newCluster);
                                newCluster.isRefreshing = false;
                                existingBatch.clusters.push(newCluster);
                            }
                        }
                    }
                }
            }

            // 4. Ensure existing batches not returned in incremental updates still have accurate lease state
            for (const b of this.batches) {
                syncBatchLeaseState(b);
            }

            // Restore activeBatch reference
            if (this.activeBatch) {
                const found = this.batches.find(b => b.batchId === this.activeBatch?.batchId);
                if (found) this.activeBatch = found;
            }

        } catch (err) {
            if (silent) console.debug("[Polling] Sync failed:", err);
            else console.error("[Reload] Error loading batches:", err);
        }
    }

    /**
     * Periodically polls for batch updates when document is active.
     */
    startBackgroundPolling() {
        if (this.pollInterval) clearInterval(this.pollInterval);

        this.pollInterval = setInterval(() => {
            if (!document.hidden && this.activeProject) {
                this.reloadBatches(true);
            }
        }, 15000);
    }

    /**
     * Sets active batch for detail viewing.
     * @param {Batch} batch
     */
    viewBatchDetail(batch) {
        this.activeBatch = batch;
    }

    /**
     * Navigates directly to a leased batch, fetching batches if not already in state.
     * @param {Lease} lease
     */
    async jumpToLeasedBatch(lease) {
        const batch = this.batches.find(b => b.batchId === lease.batchId);
        if (batch) {
            this.viewBatchDetail(batch);
        } else {
            try {
                const res = await fetch(`/api/v1/projects/${lease.projectId}/batches`, {
                    headers: { 'Accept': 'application/msgpack' }
                });
                if (!res.ok) return;
                const buf = await res.arrayBuffer();

                const data = /** @type {{ batches: Batch[] }} */ (decode(buf));
                this.batches = data.batches;
                const found = this.batches.find(b => b.batchId === lease.batchId);
                if (found) this.viewBatchDetail(found);
            } catch (err) {
                console.error("[Batches] Error jumping to leased batch:", err);
            }
        }
    }

    /**
     * Checks whether the active batch can be claimed by the user.
     * @returns {boolean}
     */
    canClaimActiveBatch() {
        if (!this.activeBatch) return false;
        if (this.activeBatch.isClaiming) return false;
        if (this.activeBatch.status !== 'AVAILABLE') return false;
        if (this.activeLease) return false;
        return true;
    }

    /**
     * Claims the current active batch for the user.
     */
    async claimCurrentBatch() {
        if (!this.activeBatch || !this.activeProject) return;

        const batch = this.activeBatch;
        batch.isClaiming = true;

        try {
            const res = await fetch(`/api/v1/batches/${batch.batchId}/claim`, { method: 'POST' });
            /** @type {ClaimBatchResponse} */
            const data = await res.json();

            if (!res.ok) {
                showToast(data.detail || 'Failed to claim batch.', 'error');
                return;
            }

            this.activeLease = {
                batchId: data.batchId,
                batchNumber: batch.batchNumber,
                projectId: this.activeProject.projectId,
                leasedUntil: data.leasedUntil,
                isLeasedByYou: true
            };

            batch.status = 'CLAIMED';
            batch.isLeasedByYou = true;
            batch.leasedUntil = data.leasedUntil;

            await this.reloadBatches();
            showToast(`Claimed Batch #${batch.batchNumber}`, 'success');
        } catch (err) {
            console.error('[Leases] Error claiming batch:', err);
            showToast('Network error while claiming batch.', 'error');
        } finally {
            batch.isClaiming = false;
        }
    }

    /**
     * Revokes an existing batch lease.
     * @param {number} batchId
     */
    async revokeLease(batchId) {
        const batch = this.batches.find(b => b.batchId === batchId) || this.activeBatch;
        if (batch) batch.isRevoking = true;

        try {
            const res = await fetch(`/api/v1/batches/${batchId}/revoke`, { method: 'POST' });
            const data = await res.json();

            if (!res.ok) {
                showToast(data.detail || 'Failed to revoke lease.', 'error');
                return;
            }

            this.activeLease = null;
            if (batch) {
                batch.status = 'AVAILABLE';
                batch.isLeasedByYou = false;
                batch.leasedUntil = null;
            }

            await this.reloadBatches();
            showToast('Lease revoked.', 'info');
        } catch (err) {
            console.error('[Leases] Error revoking lease:', err);
            showToast('Network error while revoking lease.', 'error');
        } finally {
            if (batch) batch.isRevoking = false;
        }
    }

    /**
     * Triggers a batch refresh request on the backend.
     * @param {Batch} batch
     */
    async refreshBatch(batch) {
        if (!batch || batch.isRefreshing) return;

        batch.isRefreshing = true;

        try {
            const res = await fetch(`/api/v1/batches/${batch.batchId}/refresh`, { method: 'POST' });
            const data = await res.json();

            if (!res.ok) {
                showToast(data.detail || 'Failed to refresh batch.', 'warning');
                return;
            }

            await this.reloadBatches(true);
            showToast(`Refreshed Batch #${batch.batchNumber}`, 'success', 2500);
        } catch (err) {
            console.error("[BatchRefresh] Error refreshing batch:", err);
            showToast('Network error while refreshing batch.', 'error');
        } finally {
            batch.isRefreshing = false;
        }
    }
}

// Singleton instance
export const batchManager = new BatchManager();