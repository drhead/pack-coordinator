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
         * @param {ClusterPost[]|ResolutionPost[]|Iterable<any>} posts
         * @param {ClusterPost|ResolutionPost} post
         */
        isUniform(posts, post) {
            if (!posts || !post) return true;
            const target = /** @type {ClusterPost} */ ((post && typeof post === 'object' && 'original' in post) ? (/** @type {any} */ (post)).original : post);
            const postsArray = Array.isArray(posts) ? posts : Array.from(/** @type {any} */ (posts) || []);
            if (postsArray.length === 0) return true;
            return postsArray.every(p => {
                const item = /** @type {ClusterPost} */ ((p && typeof p === 'object' && 'original' in p) ? (/** @type {any} */ (p)).original : (typeof p === 'object' ? p : null));
                if (!item) return true;
                return item.imageWidth === target.imageWidth &&
                    item.imageHeight === target.imageHeight &&
                    item.imageFormat === target.imageFormat &&
                    item.imageQuality === target.imageQuality;
            });
        },

        /**
         * Formats the image specification string (resolution, format, quality)
         * with context-aware comparative highlighting:
         * - Best resolution / quality: highlighted green (text-emerald-400)
         * - Worst resolution / quality: highlighted red (text-red-400)
         * - Aspect ratio deviation > 5%: resolution highlighted yellow (text-yellow-400) for all posts
         * - Uniform context: dimmed gray (text-gray-600)
         * - Default / neutral: standard gray (text-gray-400)
         * 
         * @param {ClusterPost|ResolutionPost|any} post 
         * @param {ClusterPost[]|ResolutionPost[]|Iterable<any>|null} [context=null]
         * @returns {string} HTML string representing the formatted spec line.
         */
        formatSpecs(post, context = null) {
            if (!post) return '';
            const target = /** @type {ClusterPost} */ ((post && typeof post === 'object' && 'original' in post) ? (/** @type {any} */ (post)).original : post);
            const width = target.imageWidth;
            const height = target.imageHeight;
            const format = target.imageFormat || '';
            const rawQuality = target.imageQuality;
            const qualityText = rawQuality === 101 ? 'Lossless' : (rawQuality !== undefined && rawQuality !== null ? rawQuality : '');

            const hasDimensions = typeof width === 'number' && typeof height === 'number';
            const resolutionText = hasDimensions ? `${width}x${height}` : '';
            const formatText = format ? (qualityText !== '' ? `${format}:` : format) : '';

            const posts = context ? (Array.isArray(context) ? context : Array.from(context)) : [];
            const validPosts = posts
                .map(p => (p && typeof p === 'object' && 'original' in p ? p.original : p))
                .filter(p => p && typeof p === 'object' && typeof p.imageWidth === 'number' && typeof p.imageHeight === 'number');

            let resolutionClass = '';
            let qualityClass = '';

            if (validPosts.length >= 2) {
                // 1. Aspect Ratio check (> 5% deviation)
                const aspectRatios = validPosts
                    .map(p => p.imageWidth / p.imageHeight)
                    .filter(ar => isFinite(ar) && ar > 0);

                let isArMismatched = false;
                if (aspectRatios.length >= 2) {
                    const minAR = Math.min(...aspectRatios);
                    const maxAR = Math.max(...aspectRatios);
                    if (minAR > 0 && (maxAR - minAR) / minAR > 0.05) {
                        isArMismatched = true;
                    }
                }

                if (isArMismatched) {
                    resolutionClass = 'text-yellow-400';
                } else if (hasDimensions) {
                    const resolutions = validPosts.map(p => p.imageWidth * p.imageHeight);
                    const minRes = Math.min(...resolutions);
                    const maxRes = Math.max(...resolutions);
                    if (minRes !== maxRes) {
                        const targetRes = width * height;
                        if (targetRes === maxRes) {
                            resolutionClass = 'text-emerald-400';
                        } else if (targetRes === minRes) {
                            resolutionClass = 'text-red-400';
                        }
                    }
                }

                // 2. Quality check (Lossless 101 > 100 > ... > 0)
                const validQualityPosts = validPosts.filter(p => typeof p.imageQuality === 'number');
                if (validQualityPosts.length >= 2 && typeof rawQuality === 'number') {
                    const qualities = validQualityPosts.map(p => p.imageQuality);
                    const minQual = Math.min(...qualities);
                    const maxQual = Math.max(...qualities);
                    if (minQual !== maxQual) {
                        if (rawQuality === maxQual) {
                            qualityClass = 'text-emerald-400';
                        } else if (rawQuality === minQual) {
                            qualityClass = 'text-red-400';
                        }
                    }
                }
            }

            const isAllUniform = validPosts.length > 0 && this.isUniform(validPosts, target);
            const neutralClass = isAllUniform ? 'text-gray-600' : 'text-gray-400';

            const resSpan = resolutionText
                ? `<span class="${resolutionClass || neutralClass}">${resolutionText}</span>`
                : '';
            const fmtSpan = formatText
                ? `<span class="${neutralClass}">${formatText}</span>`
                : '';
            const qualSpan = qualityText !== ''
                ? `<span class="${qualityClass || neutralClass}">${qualityText}</span>`
                : '';

            return [resSpan, fmtSpan, qualSpan].filter(Boolean).join(' ');
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