/**
 * @typedef {Object} HoveredImplicationData
 * @property {number|string} postId
 * @property {string} tagName
 * @property {Set<string>} directImplicators
 * @property {Set<string>} indirectImplicators
 * @property {Set<string>} directImplied
 * @property {Set<string>} indirectImplied
 */

/**
 * @typedef {Object} HoveredMergedData
 * @property {number|string} targetPostId
 * @property {Set<string>} tags
 */

/**
 * @typedef {'display' | 'lhs' | 'rhs'} TagPillMode
 */

/**
 * @typedef {Object} TagPillContext
 * @property {HoveredImplicationData|null} [hoveredImplicationData]
 * @property {HoveredMergedData|null} [hoveredMergedData]
 * @property {Set<string>} [newTags]
 * @property {boolean} [isLhs]
 */

export const alpineHelpers = {
    // Image & Media utilities
    image: {
        /** 
         * @param {ClusterPost[]} posts
         * @param {ClusterPost} post
         */
        isUniform(posts, post) {
            if (!posts || !post) return true;
            const postsArray = Array.isArray(posts) ? posts : Array.from(/** @type {any} */ (posts) || []);
            if (postsArray.length === 0) return true;
            return postsArray.every(p => {
                const item = typeof p === 'number' || typeof p === 'string' ? null : p;
                if (!item) return true;
                return item.imageWidth === post.imageWidth &&
                    item.imageHeight === post.imageHeight &&
                    item.imageFormat === post.imageFormat &&
                    item.imageQuality === post.imageQuality;
            });
        },

        /**
         * 
         * @param {ClusterPost} post 
         * @returns 
         */
        formatSpecs(post) {
            const quality = post.imageQuality === 101 ? 'Lossless' : post.imageQuality;
            return `${post.imageWidth}x${post.imageHeight} ${post.imageFormat}: ${quality}`;
        }
    },
    tagpill: {
        /**
         * Computes dynamic classes for tag pills based on display mode & hover states.
         * 
         * @param {TagObj} tag - The tag object being rendered.
         * @param {ClusterPost} [post] - The associated post object.
         * @param {TagPillMode} [mode='display'] - Render mode ('display', 'lhs', or 'rhs').
         * @param {TagPillContext} [context={}] - Contextual hover and state flags.
         * @returns {string} Space-separated Tailwind class list.
         */
        getTagClasses(tag, post, mode = 'display', context = {}) {
            const { hoveredImplicationData, newTags, isLhs } = context;
            const tagName = tag.name;
            const postId = post?.postId;

            // Convert lockedTags array to a Set if it isn't one already for fast lookups
            const lockedSet = new Set(post?.lockedTags || []);
            const isLocked = lockedSet.has(tagName);

            // 1. LOCKED TAG HANDLING
            // If tag is locked on LHS, suppress all hover states and mark as disabled
            if (mode === 'lhs' && isLocked) {
                return 'opacity-60 cursor-not-allowed select-none bg-gray-900 border-gray-700/50 text-gray-400';
            }

            // Determine cursor class based on mode and interactivity
            let cursorClass = 'cursor-default';
            if (mode === 'lhs') {
                cursorClass = 'cursor-pointer';
            } else if (mode === 'rhs') {
                cursorClass = isLhs ? 'cursor-default opacity-30' : 'cursor-pointer';
            }

            // 2. Implication Hover States (Active Post Match) - Only if not locked
            if (hoveredImplicationData && hoveredImplicationData.postId === postId) {
                const hi = hoveredImplicationData;

                let implicationStyle = '';

                // Exact Tag Match: outline in interactive modes, no outline in display mode
                if (hi.tagName === tagName) {
                    implicationStyle = mode === 'display'
                        ? 'bg-slate-700! text-white! border-transparent! font-bold! shadow-md!'
                        : 'bg-slate-700! text-white! border-slate-300! font-bold! shadow-md!';
                }
                // Implicators (Amber) - Outlines on LHS deletion where implicators are affected
                else if (hi.directImplicators.has(tagName)) {
                    implicationStyle = mode === 'lhs'
                        ? 'bg-amber-500/80! text-white! border-amber-300! font-bold! shadow-md! shadow-amber-500/40!'
                        : mode === 'rhs'
                            ? 'bg-amber-500/20! text-amber-100! border-transparent!'
                            : 'bg-amber-500/30! text-amber-300! border-transparent!';
                }
                else if (hi.indirectImplicators.has(tagName)) {
                    implicationStyle = mode === 'lhs'
                        ? 'bg-amber-600/60! text-amber-100! border-dashed! border-amber-300! font-bold! shadow-sm!'
                        : mode === 'rhs'
                            ? 'bg-amber-600/20! text-amber-200! border-dashed! border-transparent!'
                            : 'bg-amber-500/10! text-amber-400/80! border-dashed! border-transparent!';
                }
                // Implied Tags (Cyan) - Outlines on RHS transfer where implied tags are transferred
                else if (hi.directImplied.has(tagName)) {
                    implicationStyle = mode === 'rhs'
                        ? 'bg-cyan-500/80! text-white! border-cyan-300! font-bold! shadow-md! shadow-cyan-500/40!'
                        : mode === 'lhs'
                            ? 'bg-cyan-500/20! text-cyan-100! border-transparent! font-bold!'
                            : 'bg-cyan-500/30! text-cyan-300! border-transparent!';
                }
                else if (hi.indirectImplied.has(tagName)) {
                    implicationStyle = mode === 'rhs'
                        ? 'bg-cyan-600/60! text-cyan-100! border-dashed! border-cyan-300! font-bold! shadow-sm!'
                        : mode === 'lhs'
                            ? 'bg-cyan-600/20! text-cyan-100! border-dashed! border-transparent! font-bold!'
                            : 'bg-cyan-500/10! text-cyan-400/80! border-dashed! border-transparent!';
                }

                if (implicationStyle) {
                    return `${cursorClass} ${implicationStyle}`;
                }
            }

            // 3. Mode-Specific Base & Interactive States
            const classes = [cursorClass];

            if (mode === 'lhs' && newTags?.has(tagName)) {
                classes.push('ring-2 ring-emerald-400 bg-emerald-950/60 text-emerald-300 font-bold');
            } else if (mode === 'rhs' && !isLhs) {
                classes.push('hover:brightness-125');
            }

            return classes.join(' ');
        },

        /**
         * Determines inline styles for category coloring, stripping it when active hover states take over.
         * 
         * @param {TagObj} tag - The tag object.
         * @param {ClusterPost} [post] - The target post.
         * @param {HoveredImplicationData|null} [hoveredImplicationData] - Current hovered implication state.
         * @returns {string} Inline style attribute string or empty string.
         */
        getTagStyle(tag, post, hoveredImplicationData) {
            // If locked, maintain base category style unless explicitly overridden
            if (hoveredImplicationData && hoveredImplicationData.postId === post?.postId) {
                const hi = hoveredImplicationData;
                const name = tag.name;
                if (
                    hi.tagName === name ||
                    hi.directImplicators.has(name) ||
                    hi.indirectImplicators.has(name) ||
                    hi.directImplied.has(name) ||
                    hi.indirectImplied.has(name)
                ) {
                    return '';
                }
            }
            /** @type {import('./tags.js').TagManager} */
            const tagStore = /** @type {import('./tags.js').TagManager} */ (Alpine.store('tags'));
            return tagStore.getTagStyle(tag.category);
        },

        /**
         * Helper to check if a tag is locked for a given post.
         * 
         * @param {string} tagName - The name of the tag to test.
         * @param {ClusterPost} [post] - The post containing potential lockedTags.
         * @returns {boolean} True if the tag is locked.
         */
        isTagLocked(tagName, post) {
            return (post?.lockedTags || []).includes(tagName);
        },

        /**
         * Generates standard tooltip text including count and lock status.
         * 
         * @param {string} tagName - The tag name.
         * @param {ClusterPost|null} [post=null] - Optional post object to evaluate lock status.
         * @returns {string} Formatted title tooltip string.
         */
        getTagTitle(tagName, post = null) {
            const isLocked = post && (post.lockedTags || []).includes(tagName);
            /** @type {import('./tags.js').TagManager} */
            const tagStore = /** @type {import('./tags.js').TagManager} */ (Alpine.store('tags'));
            const count = tagStore.tagInfoMap[tagName]?.tagCount ?? 0;
            const lockNotice = isLocked ? ' [LOCKED - Cannot be removed]' : '';
            return `${tagName} (${count.toLocaleString()} posts)${lockNotice}`;
        }
    }
};