/**
 * Context Manager — 上下文压缩系统
 * 移植自 demo context_manager.rs + tool_result_compressor.rs
 *
 * 3 层渐进压缩:
 *   L0 (始终): sanitize tool results (base64 移除, HTML 清理, 截断)
 *   L1 (>60%): trim old tool rounds
 *   L2 (>75%): compress thinking → "..." (preserve signature)
 *   L3 (>90%): purify history — strip all thinking blocks
 */

// ==================== Constants ====================

const CONTEXT_LIMIT_CLAUDE = 200_000;

// Pressure thresholds (fraction of CONTEXT_LIMIT_CLAUDE)
const L1_THRESHOLD = 0.60;
const L2_THRESHOLD = 0.75;
const L3_THRESHOLD = 0.90;

// Tool result compressor constants
const MAX_TOOL_RESULT_CHARS = 200_000;
const SNAPSHOT_DETECTION_THRESHOLD = 20_000;
const SNAPSHOT_MAX_CHARS = 16_000;
const SNAPSHOT_HEAD_RATIO = 0.7;

// ==================== Token Estimation ====================

/**
 * Estimate token count from a string (multi-language aware).
 * ASCII ÷ 4 + CJK ÷ 1.5 + 15 % margin.
 */
function estimateTokensFromStr(s) {
    if (!s) return 0;
    let ascii = 0;
    let unicode = 0;
    for (const ch of s) {
        if (ch.charCodeAt(0) < 128) {
            ascii++;
        } else {
            unicode++;
        }
    }
    const asciiTokens = Math.ceil(ascii / 4);
    const unicodeTokens = Math.ceil(unicode / 1.5);
    return Math.ceil((asciiTokens + unicodeTokens) * 1.15);
}

/**
 * Estimate total token usage for a Claude request body (plain object).
 */
function estimateTokenUsage(requestBody) {
    let total = 0;

    // System prompt
    if (requestBody.system) {
        if (typeof requestBody.system === 'string') {
            total += estimateTokensFromStr(requestBody.system);
        } else if (Array.isArray(requestBody.system)) {
            for (const block of requestBody.system) {
                if (block.text) total += estimateTokensFromStr(block.text);
            }
        }
    }

    // Messages
    if (Array.isArray(requestBody.messages)) {
        for (const msg of requestBody.messages) {
            total += 4; // per-message overhead
            if (typeof msg.content === 'string') {
                total += estimateTokensFromStr(msg.content);
            } else if (Array.isArray(msg.content)) {
                for (const block of msg.content) {
                    switch (block.type) {
                        case 'text':
                            total += estimateTokensFromStr(block.text || '');
                            break;
                        case 'thinking':
                            total += estimateTokensFromStr(block.thinking || '');
                            total += 100; // signature overhead
                            break;
                        case 'redacted_thinking':
                            total += estimateTokensFromStr(block.data || '');
                            break;
                        case 'tool_use':
                            total += 20;
                            total += estimateTokensFromStr(block.name || '');
                            if (block.input) {
                                total += estimateTokensFromStr(
                                    typeof block.input === 'string'
                                        ? block.input
                                        : JSON.stringify(block.input)
                                );
                            }
                            break;
                        case 'tool_result':
                            total += 10;
                            total += estimateToolResultTokens(block.content);
                            break;
                        default:
                            break;
                    }
                }
            }
        }
    }

    // Tools definition
    if (Array.isArray(requestBody.tools)) {
        for (const tool of requestBody.tools) {
            total += estimateTokensFromStr(JSON.stringify(tool));
        }
    }

    // Thinking budget
    if (requestBody.thinking?.budget_tokens) {
        total += requestBody.thinking.budget_tokens;
    }

    return total;
}

function estimateToolResultTokens(content) {
    if (!content) return 0;
    if (typeof content === 'string') return estimateTokensFromStr(content);
    if (Array.isArray(content)) {
        let t = 0;
        for (const item of content) {
            if (item.text) t += estimateTokensFromStr(item.text);
        }
        return t;
    }
    return estimateTokensFromStr(JSON.stringify(content));
}

// ==================== Tool Result Compressor (Layer 0) ====================

/**
 * Deep-clean HTML: strip style/script tags and inline base64.
 */
function deepCleanHtml(html) {
    let result = html;
    // Remove <style>...</style>
    result = result.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '[style omitted]');
    // Remove <script>...</script>
    result = result.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '[script omitted]');
    // Remove inline base64
    result = result.replace(/data:[^;/]+\/[^;]+;base64,[A-Za-z0-9+/=]+/gi, '[base64 omitted]');
    // Collapse blank lines
    result = result.replace(/\n\s*\n/g, '\n');
    return result;
}

/**
 * Compact "output saved to file" notices.
 */
function compactSavedOutputNotice(text, maxChars) {
    const re = /result\s*\(\s*(?<count>[\d,]+)\s*characters\s*\)\s*exceeds\s+maximum\s+allowed\s+tokens\.\s*Output\s+(?:has\s+been\s+)?saved\s+to\s+(?<path>[^\r\n]+)/i;
    const m = text.match(re);
    if (!m?.groups) return null;

    const count = m.groups.count;
    let filePath = m.groups.path.trim().replace(/[)\]"'.]+$/, '').trim();

    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const noticeLine =
        lines.find(l => /exceeds maximum allowed tokens/i.test(l) && /saved to/i.test(l)) ||
        `result (${count} characters) exceeds maximum allowed tokens. Output has been saved to ${filePath}`;

    const formatLine = lines.find(
        l => l.startsWith('Format:') || l.includes('JSON array with schema') || /^schema:/i.test(l)
    );

    const parts = [noticeLine];
    if (formatLine && formatLine !== noticeLine) parts.push(formatLine);
    parts.push(`[tool_result omitted to reduce prompt size; read file locally if needed: ${filePath}]`);

    return truncateTextSafe(parts.join('\n'), maxChars);
}

/**
 * Compact a browser page snapshot using head(70%) + tail(30%).
 */
function compactBrowserSnapshot(text, maxChars) {
    const lower = text.toLowerCase();
    const isSnapshot =
        lower.includes('page snapshot') ||
        text.includes('页面快照') ||
        (text.match(/ref=/g) || []).length > 30 ||
        (text.match(/\[ref=/g) || []).length > 30;

    if (!isSnapshot) return null;

    const desiredMax = Math.min(maxChars, SNAPSHOT_MAX_CHARS);
    if (desiredMax < 2000 || text.length <= desiredMax) return null;

    const meta = `[page snapshot summarized to reduce prompt size; original ${text.length} chars]`;
    const overhead = meta.length + 200;
    const budget = desiredMax - overhead;
    if (budget < 1000) return null;

    let headLen = Math.min(Math.max(Math.floor(budget * SNAPSHOT_HEAD_RATIO), 500), 10_000);
    headLen = Math.min(headLen, text.length);
    const tailLen = Math.min(budget - headLen, 3_000);

    const head = text.slice(0, headLen);
    const tail = tailLen > 0 && text.length > headLen ? text.slice(-tailLen) : '';
    const omitted = text.length - headLen - (tail ? tailLen : 0);

    const summarized = tail
        ? `${meta}\n---[HEAD]---\n${head}\n---[...omitted ${omitted} chars]---\n---[TAIL]---\n${tail}`
        : `${meta}\n---[HEAD]---\n${head}\n---[...omitted ${omitted} chars]---`;

    return truncateTextSafe(summarized, maxChars);
}

/**
 * Safe text truncation — avoids splitting inside tags or JSON braces.
 */
function truncateTextSafe(text, maxChars) {
    if (text.length <= maxChars) return text;

    const sub = text.slice(0, maxChars);
    let splitPos = maxChars;

    // Avoid splitting inside a tag
    const lastOpen = sub.lastIndexOf('<');
    const lastClose = sub.lastIndexOf('>');
    if (lastOpen !== -1 && (lastClose === -1 || lastOpen > lastClose)) {
        splitPos = lastOpen;
    }

    // Avoid splitting inside JSON brace
    const lastBrace = sub.lastIndexOf('{');
    const lastCloseBrace = sub.lastIndexOf('}');
    if (
        lastBrace !== -1 &&
        (lastCloseBrace === -1 || lastBrace > lastCloseBrace) &&
        maxChars - lastBrace < 100
    ) {
        splitPos = Math.min(splitPos, lastBrace);
    }

    const omitted = text.length - splitPos;
    return `${text.slice(0, splitPos)}\n...[truncated ${omitted} chars]`;
}

/**
 * Route-based compaction for a single tool-result text string.
 */
function compactToolResultText(text, maxChars) {
    if (!text || text.length <= maxChars) return text;

    // Pre-clean HTML
    let cleaned = text;
    if (/<html|<body|<!DOCTYPE/i.test(text)) {
        cleaned = deepCleanHtml(text);
        if (cleaned.length <= maxChars) return cleaned;
    }

    // 1. Saved-output notice
    const savedNotice = compactSavedOutputNotice(cleaned, maxChars);
    if (savedNotice) return savedNotice;

    // 2. Browser snapshot
    if (cleaned.length > SNAPSHOT_DETECTION_THRESHOLD) {
        const snapshot = compactBrowserSnapshot(cleaned, maxChars);
        if (snapshot) return snapshot;
    }

    // 3. Fallback: truncate
    return truncateTextSafe(cleaned, maxChars);
}

/**
 * Check if a content block is a base64 image.
 */
function isBase64Image(block) {
    return block?.type === 'image' && block?.source?.type === 'base64';
}

/**
 * Sanitize tool_result content blocks — remove base64 images, compact text, cap chars.
 */
function sanitizeToolResultBlocks(blocks) {
    if (!Array.isArray(blocks) || blocks.length === 0) return blocks;

    let usedChars = 0;
    const cleaned = [];
    let removedImage = false;

    for (const block of blocks) {
        if (isBase64Image(block)) {
            removedImage = true;
            continue;
        }

        if (block.text != null) {
            const remaining = MAX_TOOL_RESULT_CHARS - usedChars;
            if (remaining <= 0) break;
            const compacted = compactToolResultText(String(block.text), remaining);
            cleaned.push({ ...block, text: compacted });
            usedChars += compacted.length;
        } else {
            cleaned.push(block);
            usedChars += 100;
        }

        if (usedChars >= MAX_TOOL_RESULT_CHARS) break;
    }

    if (removedImage) {
        cleaned.push({
            type: 'text',
            text: '[image omitted to fit Antigravity prompt limits; use the file path in the previous text block]',
        });
    }

    return cleaned;
}

/**
 * Layer 0 entry — walk user messages and sanitize every tool_result's content.
 */
function sanitizeToolResultsInMessages(messages) {
    if (!Array.isArray(messages)) return false;
    let modified = false;
    for (const msg of messages) {
        if (msg.role !== 'user') continue;
        if (!Array.isArray(msg.content)) continue;
        for (const block of msg.content) {
            if (block.type !== 'tool_result') continue;
            if (Array.isArray(block.content)) {
                const before = block.content;
                block.content = sanitizeToolResultBlocks(before);
                if (block.content !== before) modified = true;
            } else if (typeof block.content === 'string' && block.content.length > MAX_TOOL_RESULT_CHARS) {
                block.content = compactToolResultText(block.content, MAX_TOOL_RESULT_CHARS);
                modified = true;
            }
        }
    }
    return modified;
}

// ==================== Layer 1 — Trim Tool Rounds ====================

function hasToolUse(content) {
    return Array.isArray(content) && content.some(b => b.type === 'tool_use');
}

function hasToolResult(content) {
    return Array.isArray(content) && content.some(b => b.type === 'tool_result');
}

function identifyToolRounds(messages) {
    const rounds = [];
    let current = null;

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role === 'assistant' && hasToolUse(msg.content)) {
            if (current) rounds.push(current);
            current = { assistantIndex: i, indices: [i] };
        } else if (msg.role === 'user' && current) {
            if (hasToolResult(msg.content)) {
                current.indices.push(i);
            } else {
                rounds.push(current);
                current = null;
            }
        }
    }
    if (current) rounds.push(current);
    return rounds;
}

/**
 * Trim old tool call/result pairs, keeping the last N rounds.
 */
function trimToolMessages(messages, keepLastN = 5) {
    const rounds = identifyToolRounds(messages);
    if (rounds.length <= keepLastN) return false;

    const roundsToRemove = rounds.length - keepLastN;
    const indicesToRemove = new Set();
    for (let r = 0; r < roundsToRemove; r++) {
        for (const idx of rounds[r].indices) {
            indicesToRemove.add(idx);
        }
    }

    // Remove in reverse to avoid index shift
    let removed = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (indicesToRemove.has(i)) {
            messages.splice(i, 1);
            removed++;
        }
    }

    if (removed > 0) {
        console.log(`[ContextManager] [L1] Trimmed ${removed} tool messages, kept last ${keepLastN} rounds`);
    }
    return removed > 0;
}

// ==================== Layer 2 — Compress Thinking (preserve signature) ====================

function compressThinkingPreserveSignature(messages, protectedLastN = 4) {
    const total = messages.length;
    if (total === 0) return false;

    const protStart = Math.max(0, total - protectedLastN);
    let compressedCount = 0;
    let charsSaved = 0;

    for (let i = 0; i < protStart; i++) {
        const msg = messages[i];
        if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
        for (const block of msg.content) {
            if (block.type === 'thinking' && block.signature && block.thinking && block.thinking.length > 10) {
                charsSaved += block.thinking.length - 3;
                block.thinking = '...';
                compressedCount++;
            }
        }
    }

    if (compressedCount > 0) {
        const tokensSaved = Math.ceil(charsSaved / 3.5);
        console.log(
            `[ContextManager] [L2] Compressed ${compressedCount} thinking blocks (saved ~${tokensSaved} tokens, signatures preserved)`
        );
    }
    return compressedCount > 0;
}

// ==================== Layer 3 — Purify History ====================

/**
 * Extract the last valid thinking signature from message history.
 * Used by Layer 3 (Fork + Summary) to preserve signature chain.
 * Returns null if no valid signature found (length >= 50).
 */
function extractLastValidSignature(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
        for (const block of msg.content) {
            if (block.type === 'thinking' && block.signature && block.signature.length >= 50) {
                return block.signature;
            }
        }
    }
    return null;
}

/**
 * Strip thinking blocks from assistant messages.
 * strategy: 'soft' protects last 4, 'aggressive' protects none.
 */
function purifyHistory(messages, strategy = 'aggressive') {
    const protectedLastN = strategy === 'soft' ? 4 : 0;
    const total = messages.length;
    if (total === 0) return false;

    const protStart = Math.max(0, total - protectedLastN);
    let modified = false;

    for (let i = 0; i < (protectedLastN === 0 ? total : protStart); i++) {
        const msg = messages[i];
        if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
        const before = msg.content.length;
        msg.content = msg.content.filter(b => b.type !== 'thinking');
        if (msg.content.length !== before) modified = true;
    }

    if (modified) {
        console.log(`[ContextManager] [L3] Purified thinking blocks (strategy=${strategy})`);
    }
    return modified;
}

// ==================== Orchestrator ====================

/**
 * Main entry — apply progressive context compression.
 * Mutates requestBody.messages in place.
 *
 * @returns {{ tokensBefore: number, tokensAfter: number, layersApplied: string[] }}
 */
export function applyContextCompression(requestBody, limit = CONTEXT_LIMIT_CLAUDE) {
    const result = { tokensBefore: 0, tokensAfter: 0, layersApplied: [] };

    if (!requestBody?.messages) return result;

    // Estimate initial usage
    result.tokensBefore = estimateTokenUsage(requestBody);
    const pressure = result.tokensBefore / limit;
    console.log(
        `[ContextManager] Context pressure: ${(pressure * 100).toFixed(1)}% (${result.tokensBefore}/${limit})`
    );

    // L0 — always sanitize tool results
    if (sanitizeToolResultsInMessages(requestBody.messages)) {
        result.layersApplied.push('L0-sanitize');
    }

    // Re-estimate after L0
    let current = estimateTokenUsage(requestBody);

    // L1 — trim tool rounds if > 60 %
    if (current / limit > L1_THRESHOLD) {
        if (trimToolMessages(requestBody.messages, 5)) {
            result.layersApplied.push('L1-trimTools');
            current = estimateTokenUsage(requestBody);
        }
    }

    // L2 — compress thinking if > 75 %
    if (current / limit > L2_THRESHOLD) {
        if (compressThinkingPreserveSignature(requestBody.messages, 4)) {
            result.layersApplied.push('L2-compressThinking');
            current = estimateTokenUsage(requestBody);
        }
    }

    // L3 — purify (strip all thinking) if > 90 %
    if (current / limit > L3_THRESHOLD) {
        if (purifyHistory(requestBody.messages, 'aggressive')) {
            result.layersApplied.push('L3-purifyHistory');
            current = estimateTokenUsage(requestBody);
        }
    }

    result.tokensAfter = current;
    return result;
}
