import { WarningsManager } from './warnings.js';

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

                // Sources
                const headSources = new Set(headPost.sources || []);
                const hasNewSources = otherPosts.some(p => (p.sources || []).some(s => !headSources.has(s)));
                if (hasNewSources) {
                    details.push('Sources');
                }

                // Pools
                const headPools = new Set(headPost.original?.pool_ids || []);
                const hasNewPools = otherPosts.some(p => (p.original?.pool_ids || []).some(id => !headPools.has(id)));
                if (hasNewPools) {
                    details.push('Pools');
                }

                // Parent
                const hasParent = otherPosts.some(p => p.original?.parent_id && !headPost.original?.parent_id);
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

            const currentSources = Array.isArray(headPost.sources) ? headPost.sources : [];
            if (!currentSources.includes(sourceUrl)) {
                headPost.sources = [...currentSources, sourceUrl];
            }
        },

        /**
         * Removes a source URL from the graph's head post
         * @param {ResolutionGraph} graph
         * @param {string} sourceUrl
         */
        removeSourceFromHead(graph, sourceUrl) {
            const headPost = this.resMgr.getPost(graph.head);
            if (!headPost) return;

            const currentSources = Array.isArray(headPost.sources) ? headPost.sources : [];
            headPost.sources = currentSources.filter(s => s !== sourceUrl);
        },

        /**
         * Checks if the head post currently contains a specific source
         * @param {ResolutionGraph} graph
         * @param {string} sourceUrl
         * @returns {boolean}
         */
        headHasSource(graph, sourceUrl) {
            const headPost = this.resMgr.getPost(graph.head);
            return headPost?.sources?.includes(sourceUrl) ?? false;
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
        },

        /**
         * Flags a duplicate post
         * @param {number} postId
         */
        async submitFlag(postId) {
            const post = this.resMgr.getPost(postId);
            if (!post) return;
            post.flag = true;
            console.log('Flagging post:', postId, post.flag_note);
        }
        };
    });
});