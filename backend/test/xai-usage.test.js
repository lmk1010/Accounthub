import assert from 'node:assert/strict';
import test from 'node:test';

import { formatXaiUsage } from '../src/utils/xai-usage.js';

test('treats an omitted Grok weekly percent as zero usage', () => {
    const usage = formatXaiUsage({
        config: {
            currentPeriod: {
                type: 'USAGE_PERIOD_TYPE_WEEKLY',
                start: '2026-07-13T03:49:42.000Z',
                end: '2026-07-20T03:49:42.000Z'
            },
            onDemandCap: { val: 0 },
            onDemandUsed: { val: 0 },
            prepaidBalance: { val: 0 }
        },
        settings: {
            subscription_tier_display: 'SuperGrok',
            on_demand_enabled: false
        }
    });

    assert.equal(usage.subscription.title, 'SuperGrok');
    assert.equal(usage.subscription.overageCapability, null);
    assert.equal(usage.creditBalance, null);
    assert.deepEqual(usage.onDemand, {
        enabled: false,
        cap: 0,
        used: 0
    });
    assert.equal(usage.usageBreakdown.length, 1);
    assert.deepEqual(usage.usageBreakdown[0], {
        displayName: '每周共享额度',
        resourceType: 'XAI_WEEKLY_CREDITS',
        currentUsage: 0,
        usageLimit: 100,
        usedPercent: 0,
        remainingPercent: 100,
        unit: '%',
        nextDateReset: '2026-07-20T03:49:42.000Z',
        subscriptionId: 'weekly_pool',
        creditUsed: null,
        creditLimit: null,
        creditUnit: null
    });
});

test('maps explicit Grok weekly and pay-as-you-go usage', () => {
    const usage = formatXaiUsage({
        config: {
            creditUsagePercent: 37.5,
            currentPeriod: {
                type: 'USAGE_PERIOD_TYPE_WEEKLY',
                start: '2026-07-13T03:49:42.000Z',
                end: '2026-07-20T03:49:42.000Z'
            },
            onDemandCap: { val: 2500 },
            onDemandUsed: { val: 500 },
            prepaidBalance: { val: 12 }
        }
    });

    assert.equal(usage.usageBreakdown[0].usedPercent, 37.5);
    assert.equal(usage.usageBreakdown[0].remainingPercent, 62.5);
    assert.equal(usage.usageBreakdown[1].usedPercent, 20);
    assert.equal(usage.subscription.overageCapability, '按量付费上限 2500 credits');
    assert.equal(usage.creditBalance.remaining, 12);
    assert.equal(usage.onDemand.enabled, true);
});

test('does not mislabel a non-weekly Grok period as weekly quota', () => {
    const usage = formatXaiUsage({
        config: {
            creditUsagePercent: 20,
            currentPeriod: {
                type: 'USAGE_PERIOD_TYPE_MONTHLY',
                start: '2026-07-01T00:00:00.000Z',
                end: '2026-08-01T00:00:00.000Z'
            }
        }
    });

    assert.equal(usage.usageBreakdown.length, 1);
    assert.equal(usage.usageBreakdown[0].resourceType, 'XAI_BILLING_PERIOD');
    assert.equal(usage.usageBreakdown[0].usedPercent, null);
});

test('reports verified xAI API access when OAuth billing details are unavailable', () => {
    const usage = formatXaiUsage({
        quotaUnavailable: true,
        quotaMessage: 'xAI API access verified',
        quotaSource: 'xai-api-oauth',
        apiAccessVerified: true,
        subscriptionTierDisplay: 'xAI API OAuth',
        account: {
            email: 'grok@example.com',
            userId: 'grok-user'
        }
    });

    assert.equal(usage.quotaUnavailable, true);
    assert.equal(usage.quotaMessage, 'xAI API access verified');
    assert.equal(usage.quotaSource, 'xai-api-oauth');
    assert.equal(usage.apiAccessVerified, true);
    assert.equal(usage.subscription.title, 'xAI API OAuth');
    assert.equal(usage.user.email, 'grok@example.com');
    assert.equal(usage.user.userId, 'grok-user');
    assert.deepEqual(usage.usageBreakdown, []);
});
