export function resolveProviderStatus(provider = {}) {
    const isDeleted = provider.is_deleted ?? provider.isDeleted ?? false;
    if (isDeleted) {
        return 'deleted';
    }
    const isDisabled = provider.is_disabled ?? provider.isDisabled ?? false;
    if (isDisabled) {
        return 'disabled';
    }
    const isHealthy = provider.is_healthy ?? provider.isHealthy ?? true;
    if (isHealthy) {
        return 'healthy';
    }

    const credentials = provider?.credentials && typeof provider.credentials === 'object'
        ? provider.credentials
        : {};

    // 优先使用已持久化的 relayState 判断
    const relayState = String(credentials.relayState || '').trim().toLowerCase();
    if (relayState === 'cooldown' || relayState === 'overloaded') {
        return 'cooldown';
    }

    const recoverAtRaw = credentials.relayStateRecoverAt
        || credentials.relay_state_recover_at
        || provider.scheduled_recovery_time
        || provider.scheduledRecoveryTime
        || null;
    const recoverAtMs = recoverAtRaw ? new Date(recoverAtRaw).getTime() : NaN;
    if (Number.isFinite(recoverAtMs) && recoverAtMs > Date.now()) {
        return 'cooldown';
    }

    return 'unhealthy';
}
