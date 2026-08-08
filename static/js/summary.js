document.addEventListener('alpine:init', () => {
    if (!window.Alpine) return;

    /**
     * @typedef {import('./resolution.js').ResolutionGraph} ResolutionGraph
     * @typedef {import('./resolution.js').ResolutionPost} ResolutionPost
     */

    window.Alpine.data('summaryManager', (resMgr) => ({
        resMgr: /** @type {ResolutionManagerComponent} */ (resMgr),

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
                headPost.description = headPost.original.description || '';
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

            if (!Array.isArray(headPost.sources)) {
                headPost.sources = [];
            }

            if (!headPost.sources.includes(sourceUrl)) {
                headPost.sources.push(sourceUrl);
            }
        },

        /**
         * Removes a source URL from the graph's head post
         * @param {ResolutionGraph} graph
         * @param {string} sourceUrl
         */
        removeSourceFromHead(graph, sourceUrl) {
            const headPost = this.resMgr.getPost(graph.head);
            if (!headPost || !Array.isArray(headPost.sources)) return;

            const index = headPost.sources.indexOf(sourceUrl);
            if (index > -1) {
                headPost.sources.splice(index, 1);
            }
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
    }));
});