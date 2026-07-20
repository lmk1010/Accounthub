function normalizePlanText(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function toCompactPlanText(value) {
    const normalized = normalizePlanText(value);
    if (!normalized) return '';
    return normalized.toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

function isGenericCodexTitle(value) {
    const normalized = normalizePlanText(value);
    if (!normalized) return false;
    return normalized.toUpperCase() === 'OPENAI CODEX OAUTH';
}

export function normalizeCodexPlanKey(value) {
    const compact = toCompactPlanText(value);
    if (!compact) return null;

    if (compact.includes('PRO20X')) return 'pro20x';
    if (compact.includes('PRO5X')) return 'pro5x';
    if (compact.includes('PROPLUS')) return 'pro-plus';
    if (compact.includes('ULTRA')) return 'ultra';
    if (compact.includes('ENTERPRISECBPUSAGEBASED') || compact.includes('ENTERPRISE')) return 'enterprise';
    if (compact.includes('SELFSERVEBUSINESSUSAGEBASED') || compact.includes('BUSINESS')) return 'business';
    if (compact === 'K12' || compact.includes('K12') || compact.includes('EDUCATION') || compact.includes('EDU')) return 'team';
    if (compact.includes('TEAM')) return 'team';
    if (compact.includes('GO')) return 'go';
    if (compact.includes('FREEWORKSPACE') || compact.includes('FREE')) return 'free';
    if (compact.includes('PRO')) return 'pro';
    if (compact.includes('PLUS')) return 'plus';
    return null;
}

export function formatCodexPlanTitle(value) {
    const normalized = normalizePlanText(value);
    if (!normalized) return null;

    switch (normalizeCodexPlanKey(normalized)) {
    case 'pro20x':
        return 'GPT PRO 20X';
    case 'pro5x':
        return 'GPT PRO 5X';
    case 'pro-plus':
        return 'GPT PRO+';
    case 'ultra':
        return 'GPT ULTRA';
    case 'enterprise':
        return 'GPT ENTERPRISE';
    case 'business':
        return 'GPT BUSINESS';
    case 'team':
        return 'GPT TEAM';
    case 'go':
        return 'GPT GO';
    case 'free':
        return 'GPT FREE';
    case 'pro':
        return 'GPT PRO';
    case 'plus':
        return 'GPT PLUS';
    default:
        return normalized;
    }
}

function codexPlanScore(value) {
    const normalized = normalizePlanText(value);
    if (!normalized) return -1;
    if (isGenericCodexTitle(normalized)) return 0;

    switch (normalizeCodexPlanKey(normalized)) {
    case 'pro20x':
        return 120;
    case 'pro5x':
        return 110;
    case 'pro-plus':
        return 100;
    case 'enterprise':
        return 95;
    case 'business':
        return 90;
    case 'team':
        return 80;
    case 'pro':
        return 70;
    case 'plus':
        return 60;
    case 'go':
        return 50;
    case 'free':
        return 40;
    case 'ultra':
        return 30;
    default:
        return 10;
    }
}

export function selectBestCodexPlanTitle(...values) {
    let bestTitle = null;
    let bestScore = -1;

    for (const value of values) {
        const normalized = normalizePlanText(value);
        if (!normalized) continue;

        const formatted = formatCodexPlanTitle(normalized) || normalized;
        const score = codexPlanScore(formatted);

        if (score > bestScore) {
            bestTitle = formatted;
            bestScore = score;
        }
    }

    return bestTitle;
}
