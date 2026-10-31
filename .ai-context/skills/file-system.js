const fs = require('fs');
const path = require('path');
const { REPO_ROOT, resolveSafePath } = require('../lib/security-guard');

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'old', 'dist', 'build', 'coverage', '.venv', 'venv', 'target']);

function searchDirectoryRecursive(dirPath, keyword, results, maxResults = 25) {
    if (results.length >= maxResults) return;
    let entries = [];
    try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (_) {
        return;
    }

    for (const entry of entries) {
        if (results.length >= maxResults) break;
        if (IGNORED_DIRS.has(entry.name)) continue;

        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            searchDirectoryRecursive(fullPath, keyword, results, maxResults);
        } else if (entry.isFile()) {
            if (entry.name === 'runner-config.yml' || entry.name.startsWith('.env')) continue;
            try {
                const stat = fs.statSync(fullPath);
                if (stat.size > 512 * 1024) continue; // Skip large binaries > 512KB
                const content = fs.readFileSync(fullPath, 'utf8');
                const lines = content.split(/\r?\n/);
                const lowerKey = keyword.toLowerCase();
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].toLowerCase().includes(lowerKey)) {
                        const rel = path.relative(REPO_ROOT, fullPath).replace(/\\/g, '/');
                        results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
                        if (results.length >= maxResults) break;
                    }
                }
            } catch (_) {}
        }
    }
}

module.exports = [
    {
        name: 'read_file',
        instruction: '- {"action": "read_file", "path": "relative/path/to/file"}',
        execute: async (toolCall) => {
            try {
                const { fullPath } = resolveSafePath(toolCall.path, { mode: 'read' });
                return fs.readFileSync(fullPath, 'utf8');
            } catch (e) {
                return `Error: ${e.message}`;
            }
        }
    },
    {
        name: 'write_file',
        instruction: '- {"action": "write_file", "path": "relative/path/to/file", "content": "..."}',
        execute: async (toolCall) => {
            try {
                const allowBootstrap = process.env.ALLOW_BOOTSTRAP_WRITE === 'true';
                const { fullPath, relPath } = resolveSafePath(toolCall.path, {
                    mode: 'write',
                    allowBootstrap
                });
                fs.mkdirSync(path.dirname(fullPath), { recursive: true });
                fs.writeFileSync(fullPath, String(toolCall.content ?? ''), 'utf8');
                return `Success: ${relPath} saved.`;
            } catch (e) {
                return `Error: ${e.message}`;
            }
        }
    },
    {
        name: 'search_files',
        instruction: '- {"action": "search_files", "keyword": "search term"}',
        execute: async (toolCall) => {
            try {
                const keyword = String(toolCall.keyword || '').trim();
                if (!keyword) return 'Error: Please provide a non-empty keyword.';
                const results = [];
                searchDirectoryRecursive(REPO_ROOT, keyword, results, 25);
                if (results.length === 0) {
                    return `No matches found for "${keyword}".`;
                }
                return `Results:\n${results.join('\n')}`;
            } catch (e) {
                return `Error: ${e.message}`;
            }
        }
    }
];
