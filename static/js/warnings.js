// @ts-check

/**
 * @typedef {Object} WarningRule
 * @property {string} id - Unique warning ID (e.g., 'rating-mismatch')
 * @property {'hard'|'soft'|'info'} type - Severity: 'hard' (red), 'soft' (amber), 'info' (blue)
 * @property {string} icon - Icon or emoji (e.g., '⚠️', '🎨', '💡')
 * @property {string} title - Human readable warning title
 * @property {string | ((ctx: any) => string)} message - Detail message string or dynamic function
 * @property {(ctx: any) => boolean} check - Evaluation function returning true if warning condition is active
 * @property {string} [actionLabel] - Optional label for auto-fix button
 * @property {((ctx: any) => void)} [actionHandler] - Optional handler for auto-fix button
 */

/**
 * Manages declarative warning rules, dismissal states per scope, sticky resolutions, and visual fade transitions.
 */
export class WarningsManager {
    constructor() {
        /** @type {Map<string, WarningRule>} */
        this.rules = new Map();
        /** @type {Set<string>} Set of "scopeId:warningId" keys representing manually dismissed soft warnings */
        this.dismissedKeys = new Set();
        /** @type {Set<string>} Set of "scopeId:warningId" keys representing permanently resolved soft warnings */
        this.permanentlyResolvedKeys = new Set();
        /** @type {Set<string>} Set of "scopeId:warningId" keys that were active in the previous tick */
        this.wasActiveKeys = new Set();
        /** @type {Map<string, { isResolved: boolean }>} Map of "scopeId:warningId" -> transient resolution state */
        this.resolvingMap = new Map();
    }

    /**
     * Registers a single warning rule.
     * @param {WarningRule} rule
     */
    registerRule(rule) {
        this.rules.set(rule.id, rule);
    }

    /**
     * Registers an array of warning rules.
     * @param {WarningRule[]} rules
     */
    registerRules(rules) {
        for (const r of rules) {
            this.registerRule(r);
        }
    }

    /**
     * Silences a soft warning for a specific scope ID (moves to muted dismissed style without vanishing or green animation).
     * @param {string|number} scopeId
     * @param {string} warningId
     */
    dismiss(scopeId, warningId) {
        const key = `${scopeId}:${warningId}`;
        this.dismissedKeys.add(key);
    }

    /**
     * Helper to trigger a 1.2-second visual collapse transition when condition resolves.
     * Removes key from dismissedKeys and permanently marks it resolved so it never pops back up after collapse.
     * @param {string|number} scopeId
     * @param {string} warningId
     */
    triggerTransientResolution(scopeId, warningId) {
        const key = `${scopeId}:${warningId}`;
        if (this.resolvingMap.has(key)) return;

        this.dismissedKeys.delete(key);
        this.permanentlyResolvedKeys.add(key);
        this.resolvingMap.set(key, { isResolved: true });

        setTimeout(() => {
            this.resolvingMap.delete(key);
        }, 1200);
    }

    /**
     * Evaluates all registered rules against context in strict rule insertion order.
     * @param {string|number} scopeId
     * @param {any} ctx
     * @returns {(WarningRule & { isDismissed: boolean, isResolved: boolean })[]}
     */
    getActiveWarnings(scopeId, ctx) {
        const result = [];

        for (const [id, rule] of this.rules.entries()) {
            const key = `${scopeId}:${id}`;
            const isCurrentlyActive = rule.check(ctx);
            const isDismissed = this.dismissedKeys.has(key);
            const isPermanentlyResolved = this.permanentlyResolvedKeys.has(key);
            const resolvingRecord = this.resolvingMap.get(key);

            // Condition transitioned from active to inactive
            if (this.wasActiveKeys.has(key) && !isCurrentlyActive) {
                this.wasActiveKeys.delete(key);
                this.triggerTransientResolution(scopeId, id);
            }

            if (resolvingRecord) {
                result.push({
                    ...rule,
                    icon: '✓',
                    isDismissed: false,
                    isResolved: true
                });
            } else if (isPermanentlyResolved) {
                // Permanently resolved items are NEVER pushed to result again!
                continue;
            } else if (isDismissed) {
                // Silenced/Dismissed items stay in list permanently as muted gray cards while condition is active
                result.push({
                    ...rule,
                    isDismissed: true,
                    isResolved: false
                });
            } else if (isCurrentlyActive) {
                this.wasActiveKeys.add(key);
                result.push({
                    ...rule,
                    isDismissed: false,
                    isResolved: false
                });
            }
        }

        return result;
    }

    /**
     * Checks if there are any active warnings for scope.
     * @param {string|number} scopeId
     * @param {any} ctx
     * @returns {boolean}
     */
    hasActiveWarnings(scopeId, ctx) {
        return this.getActiveWarnings(scopeId, ctx).length > 0;
    }

    /**
     * Checks if progression is blocked for the specified scope ID.
     * Hard warnings ALWAYS block progression.
     * Soft warnings block progression UNLESS manually dismissed or condition resolved.
     * Info warnings NEVER block progression.
     * @param {string|number} scopeId
     * @param {any} ctx
     * @returns {boolean}
     */
    isBlocked(scopeId, ctx) {
        const warnings = this.getActiveWarnings(scopeId, ctx);
        for (const w of warnings) {
            if (w.isResolved) continue;
            if (w.type === 'hard') return true;
            if (w.type === 'soft' && !w.isDismissed) return true;
        }
        return false;
    }
}
