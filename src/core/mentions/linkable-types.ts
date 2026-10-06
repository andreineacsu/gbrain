/**
 * The page types that are always linkable entities, whatever the schema pack
 * says. A leaf module: mentions/policy.ts re-exports it with the rest of the
 * mention-linking policy, and the retrieval reflex reads it without loading
 * the schema-pack machinery policy.ts depends on.
 */
export const ALWAYS_LINKABLE_TYPES = ['person', 'company', 'organization', 'entity'] as const;
