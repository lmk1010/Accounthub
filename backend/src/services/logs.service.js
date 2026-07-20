/**
 * Log service
 */
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import readline from 'readline';
import { spawn } from 'child_process';
import zlib from 'zlib';
import { pipeline } from 'stream/promises';

const LOG_DIR = path.join(process.cwd(), 'logs');
const DATE_PATTERN = /(\d{4}-\d{2}-\d{2})/;
const LOG_LINE_PATTERN = /^\[(.+?)\]\s+\[([A-Z]+)\]\s+(.*)$/;
// 大文件阈值：超过此大小使用流式读取
const LARGE_FILE_THRESHOLD = 5 * 1024 * 1024; // 5MB

const ensureLogDir = () => {
    if (!fs.existsSync(LOG_DIR)) {
        return false;
    }
    return true;
};

const isCompressedFile = (fileName) => fileName.endsWith('.gz');

const getLogDateFromName = (fileName) => {
    const match = fileName.match(DATE_PATTERN);
    if (!match) return null;
    const date = new Date(`${match[1]}T00:00:00`);
    if (Number.isNaN(date.getTime())) return null;
    return date;
};

const safeLogPath = (fileName) => {
    const safeName = path.basename(fileName);
    const fullPath = path.join(LOG_DIR, safeName);
    if (!fullPath.startsWith(LOG_DIR)) {
        throw new Error('Invalid log file path');
    }
    return fullPath;
};

const parseLogLine = (line, lineNumber) => {
    const match = line.match(LOG_LINE_PATTERN);
    if (!match) {
        return {
            lineNumber,
            timestamp: null,
            level: 'info',
            message: line,
            raw: line
        };
    }

    return {
        lineNumber,
        timestamp: match[1],
        level: match[2].toLowerCase(),
        message: match[3],
        raw: line
    };
};

/**
 * 使用流式读取获取文件总行数（用于大文件）
 */
async function countLinesStream(filePath) {
    return new Promise((resolve, reject) => {
        let count = 0;
        const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        rl.on('line', () => { count++; });
        rl.on('close', () => resolve(count));
        rl.on('error', reject);
    });
}

/**
 * 流式读取指定范围的行（用于大文件）
 */
async function readLinesStream(filePath, startLine, endLine) {
    return new Promise((resolve, reject) => {
        const lines = [];
        let currentLine = 0;
        const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

        rl.on('line', (line) => {
            currentLine++;
            if (currentLine >= startLine && currentLine <= endLine) {
                lines.push({ lineNumber: currentLine, content: line });
            }
            if (currentLine >= endLine) {
                rl.close();
                stream.destroy();
            }
        });
        rl.on('close', () => resolve(lines));
        rl.on('error', reject);
    });
}

export async function listLogDays() {
    if (!ensureLogDir()) {
        return { days: [], totalFiles: 0, totalSize: 0, compressedFiles: 0, compressedSize: 0 };
    }

    const entries = await fsp.readdir(LOG_DIR, { withFileTypes: true });
    const files = [];
    let totalSize = 0;
    let compressedFiles = 0;
    let compressedSize = 0;

    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const dateMatch = entry.name.match(DATE_PATTERN);
        if (!dateMatch) continue;

        const stat = await fsp.stat(path.join(LOG_DIR, entry.name));
        const compressed = isCompressedFile(entry.name);
        totalSize += stat.size;
        if (compressed) {
            compressedFiles += 1;
            compressedSize += stat.size;
        }
        files.push({
            name: entry.name,
            date: dateMatch[1],
            size: stat.size,
            updatedAt: stat.mtimeMs,
            isCompressed: compressed
        });
    }

    const grouped = new Map();
    files.forEach((file) => {
        if (!grouped.has(file.date)) {
            grouped.set(file.date, []);
        }
        grouped.get(file.date).push(file);
    });

    const days = Array.from(grouped.entries())
        .map(([date, dayFiles]) => ({
            date,
            files: dayFiles.sort((a, b) => b.updatedAt - a.updatedAt)
        }))
        .sort((a, b) => b.date.localeCompare(a.date));

    return { days, totalFiles: files.length, totalSize, compressedFiles, compressedSize };
}

export async function readLogEntries(fileName, options = {}) {
    if (!fileName) {
        throw new Error('Missing log file name');
    }

    if (!ensureLogDir()) {
        return { entries: [], totalLines: 0, page: 1, pageSize: 0, hasMore: false };
    }

    const {
        page = 1,
        pageSize = 200,
        direction = 'desc'
    } = options;

    const safePath = safeLogPath(fileName);
    const stat = await fsp.stat(safePath);
    const fileSize = stat.size;

    const normalizedPageSize = Math.max(1, Math.min(Number(pageSize) || 200, 1000));
    const normalizedPage = Math.max(1, Number(page) || 1);

    // 小文件：直接读取全部内容
    if (fileSize < LARGE_FILE_THRESHOLD) {
        const content = await fsp.readFile(safePath, 'utf8');
        const lines = content.split(/\r?\n/);
        if (lines.length && lines[lines.length - 1] === '') {
            lines.pop();
        }
        const totalLines = lines.length;

        let startIndex = 0;
        let endIndex = totalLines;

        if (direction === 'asc') {
            startIndex = (normalizedPage - 1) * normalizedPageSize;
            endIndex = Math.min(totalLines, startIndex + normalizedPageSize);
        } else {
            endIndex = totalLines - (normalizedPage - 1) * normalizedPageSize;
            startIndex = Math.max(0, endIndex - normalizedPageSize);
        }

        const slice = lines.slice(startIndex, endIndex);
        const entries = slice.map((line, index) => {
            const lineNumber = startIndex + index + 1;
            return parseLogLine(line, lineNumber);
        });

        const hasMore = direction === 'asc'
            ? endIndex < totalLines
            : startIndex > 0;

        return { entries, totalLines, page: normalizedPage, pageSize: normalizedPageSize, hasMore };
    }

    // 大文件：使用流式读取
    const cacheKey = `${safePath}:${stat.mtimeMs}`;
    if (!global.logLineCountCache) {
        global.logLineCountCache = new Map();
    }

    const cached = global.logLineCountCache.get(cacheKey);
    const now = Date.now();
    let totalLines;
    if (cached && now - cached.time < 300000) { // 5 分钟 TTL
        totalLines = cached.value;
    } else {
        totalLines = await countLinesStream(safePath);
        global.logLineCountCache.set(cacheKey, { value: totalLines, time: now });
        // LRU：超过 50 条删最旧的
        if (global.logLineCountCache.size > 50) {
            const firstKey = global.logLineCountCache.keys().next().value;
            global.logLineCountCache.delete(firstKey);
        }
    }

    let startIndex = 0;
    let endIndex = totalLines;

    if (direction === 'asc') {
        startIndex = (normalizedPage - 1) * normalizedPageSize;
        endIndex = Math.min(totalLines, startIndex + normalizedPageSize);
    } else {
        endIndex = totalLines - (normalizedPage - 1) * normalizedPageSize;
        startIndex = Math.max(0, endIndex - normalizedPageSize);
    }

    const lineData = await readLinesStream(safePath, startIndex + 1, endIndex);
    const entries = lineData.map(({ lineNumber, content }) => parseLogLine(content, lineNumber));

    const hasMore = direction === 'asc'
        ? endIndex < totalLines
        : startIndex > 0;

    return { entries, totalLines, page: normalizedPage, pageSize: normalizedPageSize, hasMore };
}

export async function getLogBuffer(limit = 200) {
    const buffer = Array.isArray(global.logBuffer) ? global.logBuffer : [];
    const size = Math.max(1, Math.min(Number(limit) || 200, 1000));
    if (buffer.length <= size) {
        return buffer;
    }
    return buffer.slice(buffer.length - size);
}

/**
 * 获取日志文件的完整路径（用于下载）
 */
export function getLogFilePath(fileName) {
    if (!fileName) {
        throw new Error('Missing log file name');
    }
    return safeLogPath(fileName);
}

/**
 * 获取日志文件信息
 */
export async function getLogFileInfo(fileName) {
    const filePath = safeLogPath(fileName);
    const stat = await fsp.stat(filePath);
    return {
        path: filePath,
        size: stat.size,
        name: fileName
    };
}

/**
 * 使用 ripgrep 快速搜索日志文件（支持上下文）
 */
export async function searchLogEntries(fileName, keyword, options = {}) {
    if (!fileName) {
        throw new Error('Missing log file name');
    }
    if (!keyword || !keyword.trim()) {
        throw new Error('Missing search keyword');
    }

    if (!ensureLogDir()) {
        return { entries: [], total: 0, keyword };
    }

    const { limit = 200, caseSensitive = false, context = 0 } = options;
    const safePath = safeLogPath(fileName);
    const maxResults = Math.min(Math.max(1, Number(limit) || 200), 500);
    const contextLines = Math.min(Math.max(0, Number(context) || 0), 10);

    return new Promise((resolve, reject) => {
        const args = [
            '--line-number',
            '--no-heading',
            '--color', 'never',
            '-m', String(maxResults)
        ];

        if (!caseSensitive) {
            args.push('-i');
        }

        if (contextLines > 0) {
            args.push('-C', String(contextLines));
        }

        args.push('--', keyword, safePath);

        const rg = spawn('rg', args);
        let stdout = '';
        let stderr = '';

        rg.stdout.on('data', (data) => { stdout += data; });
        rg.stderr.on('data', (data) => { stderr += data; });

        rg.on('close', (code) => {
            if (code !== 0 && code !== 1) {
                // code 1 = no matches, which is OK
                if (stderr.includes('not found') || stderr.includes('No such file')) {
                    return fallbackSearch(safePath, keyword, options).then(resolve).catch(reject);
                }
            }

            const results = parseRipgrepOutput(stdout, contextLines > 0);
            resolve({
                entries: results,
                total: results.length,
                hasMore: results.length >= maxResults,
                keyword,
                context: contextLines
            });
        });

        rg.on('error', (err) => {
            // ripgrep 不可用，回退到流式搜索
            console.log('[Search] ripgrep not available, falling back to stream search');
            fallbackSearch(safePath, keyword, options).then(resolve).catch(reject);
        });
    });
}

/**
 * 解析 ripgrep 输出
 */
function parseRipgrepOutput(output, hasContext) {
    if (!output.trim()) return [];

    const results = [];
    const lines = output.split('\n');

    for (const line of lines) {
        if (!line.trim()) continue;

        // 格式: lineNumber:content 或 lineNumber-content (上下文行用 -)
        const match = line.match(/^(\d+)([:|-])(.*)$/);
        if (match) {
            const lineNumber = parseInt(match[1], 10);
            const isMatch = match[2] === ':';
            const content = match[3];

            results.push({
                ...parseLogLine(content, lineNumber),
                isMatch
            });
        }
    }

    return results;
}

/**
 * 流式搜索回退方案（当 ripgrep 不可用时）
 */
async function fallbackSearch(filePath, keyword, options = {}) {
    const { limit = 200, caseSensitive = false } = options;
    const maxResults = Math.min(Math.max(1, Number(limit) || 200), 500);
    const searchTerm = caseSensitive ? keyword : keyword.toLowerCase();

    return new Promise((resolve, reject) => {
        const results = [];
        let lineNumber = 0;

        const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

        rl.on('line', (line) => {
            lineNumber++;
            const compareLine = caseSensitive ? line : line.toLowerCase();

            if (compareLine.includes(searchTerm)) {
                results.push({ ...parseLogLine(line, lineNumber), isMatch: true });
                if (results.length >= maxResults) {
                    rl.close();
                    stream.destroy();
                }
            }
        });

        rl.on('close', () => {
            resolve({
                entries: results,
                total: results.length,
                hasMore: results.length >= maxResults,
                keyword
            });
        });

        rl.on('error', reject);
    });
}

/**
 * Delete a log file
 */
export async function deleteLogFile(fileName) {
    if (!ensureLogDir()) {
        throw new Error('Log directory does not exist');
    }

    const filePath = safeLogPath(fileName);

    // Check if file exists
    try {
        await fsp.access(filePath);
    } catch (error) {
        const err = new Error('Log file not found');
        err.code = 'ENOENT';
        throw err;
    }

    // Delete the file
    await fsp.unlink(filePath);
}

export async function gzipLogFile(fileName) {
    if (!fileName) {
        throw new Error('Missing log file name');
    }
    if (!ensureLogDir()) {
        throw new Error('Log directory does not exist');
    }
    if (isCompressedFile(fileName)) {
        throw new Error('Log file already compressed');
    }

    const filePath = safeLogPath(fileName);
    const gzipName = `${fileName}.gz`;
    const gzipPath = safeLogPath(gzipName);

    const stat = await fsp.stat(filePath);
    try {
        await fsp.access(gzipPath);
        throw new Error('Compressed log file already exists');
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }

    await pipeline(
        fs.createReadStream(filePath),
        zlib.createGzip(),
        fs.createWriteStream(gzipPath)
    );

    const gzipStat = await fsp.stat(gzipPath);
    await fsp.unlink(filePath);

    return {
        file: fileName,
        gzipFile: gzipName,
        sizeBefore: stat.size,
        sizeAfter: gzipStat.size
    };
}

export async function gzipLogFiles(options = {}) {
    if (!ensureLogDir()) {
        throw new Error('Log directory does not exist');
    }
    const keepDays = Math.max(0, Number(options.keepDays ?? 1));
    const entries = await fsp.readdir(LOG_DIR, { withFileTypes: true });
    const results = [];

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const cutoff = new Date(today);
    cutoff.setDate(cutoff.getDate() - keepDays);

    for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (isCompressedFile(entry.name)) continue;
        const fileDate = getLogDateFromName(entry.name);
        if (!fileDate || fileDate >= cutoff) continue;
        try {
            const result = await gzipLogFile(entry.name);
            results.push({ ...result, status: 'compressed' });
        } catch (error) {
            results.push({ file: entry.name, status: 'failed', error: error.message });
        }
    }

    return { results };
}

export async function deleteLogFilesOlderThan(days) {
    if (!ensureLogDir()) {
        throw new Error('Log directory does not exist');
    }

    const keepDays = Math.max(0, Number(days ?? 7));
    const entries = await fsp.readdir(LOG_DIR, { withFileTypes: true });
    const results = [];

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const cutoff = new Date(today);
    cutoff.setDate(cutoff.getDate() - keepDays);

    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const fileDate = getLogDateFromName(entry.name);
        if (!fileDate || fileDate >= cutoff) continue;
        try {
            await fsp.unlink(path.join(LOG_DIR, entry.name));
            results.push({ file: entry.name, status: 'deleted' });
        } catch (error) {
            results.push({ file: entry.name, status: 'failed', error: error.message });
        }
    }

    return { results };
}
