interface CachedBusinessIdentity {
    sessionUserId: string | null | undefined;
    cachedUserId: string | null | undefined;
    businessId: string | null | undefined;
}

/**
 * A cached tenant can be rendered before the remote refresh only when it was
 * previously validated for the exact same authenticated user.
 */
export function canUseCachedBusiness(identity: CachedBusinessIdentity): boolean {
    return Boolean(
        identity.sessionUserId
        && identity.cachedUserId
        && identity.businessId
        && identity.sessionUserId === identity.cachedUserId,
    );
}

/** Offline identity is cached, not remote-verified. The caller must require PIN. */
export function canUseOfflineBusiness(identity: CachedBusinessIdentity): boolean {
    return Boolean(identity.cachedUserId && identity.businessId
        && (!identity.sessionUserId || identity.sessionUserId === identity.cachedUserId));
}
