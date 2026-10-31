const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const DEFAULT_PROTECTED_PREFIXES = [
    '.ai-context/agents',
    '.ai-context/skills',
    '.ai-context/mcp',
    '.ai-context/lib',
    '.ai-context/core-rules.md',
    '.forgejo',
    '.github',
    '.gitea',
    '.git',
    '.gitignore',
    'AGENTS.md',
    'runner-config.yml',
    'old'
];

const BOOTSTRAP_WRITABLE_FILES = [
    '.ai-context/PRODUCT_VISION.md',
    '.ai-context/PRD.md',
    '.ai-context/project-config.json'
];

const SENSITIVE_ENV_PATTERNS = [
    /TOKEN/i,
    /KEY/i,
    /SECRET/i,
    /PASSWORD/i,
    /CREDENTIAL/i,
    /AUTH/i
];

const ALLOWED_COMMAND_BINARIES = new Set([
    'npm',
    'npx',
    'node',
    'python',
    'python3',
    'pytest',
    'pip',
    'cargo',
    'go',
    'flutter',
    'dart',
    'dotnet',
    'mvn',
    'gradle',
    'git'
]);

const FORBIDDEN_GIT_SUBCOMMANDS = new Set([
    'push',
    'remote',
    'config',
    'credential',
    'clean',
    'filter-branch'
]);

/**
 * Normalizes a relative path to forward slashes without leading './'
 */
function normalizeRelPath(relPath) {
    return relPath.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Checks whether a repository-relative path is protected from agent modification.
 */
function isProtectedPath(relPath, { allowBootstrap = false } = {}) {
    const norm = normalizeRelPath(relPath);
    if (!norm || norm.startsWith('..') || path.isAbsolute(norm)) {
        return true;
    }

    if (allowBootstrap && BOOTSTRAP_WRITABLE_FILES.includes(norm)) {
        return false;
    }

    if (BOOTSTRAP_WRITABLE_FILES.includes(norm) && !allowBootstrap) {
        return true;
    }

    for (const prefix of DEFAULT_PROTECTED_PREFIXES) {
        if (norm === prefix || norm.startsWith(prefix + '/')) {
            return true;
        }
    }

    // Block reading/writing .env or secret files
    const base = path.posix.basename(norm);
    if (base === '.env' || base.startsWith('.env.') || base.endsWith('.pem') || base.endsWith('.key')) {
        return true;
    }

    return false;
}

/**
 * Resolves a user/LLM-supplied path safely within the repository root.
 * Throws an Error on path traversal or prohibited access to protected agent/workflow files.
 */
function resolveSafePath(userPath, { mode = 'read', allowBootstrap = false } = {}) {
    if (typeof userPath !== 'string' || userPath.trim() === '' || userPath.includes('\0')) {
        throw new Error('Invalid file path provided.');
    }

    const resolved = path.resolve(REPO_ROOT, userPath);
    const rel = path.relative(REPO_ROOT, resolved);
    const normRel = normalizeRelPath(rel);

    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`Security Violation: Path traversal outside repository is blocked (${userPath}).`);
    }

    // Never allow reading or writing .git, old/, runner-config.yml, or .env files
    if (
        normRel === '.git' ||
        normRel.startsWith('.git/') ||
        normRel === 'old' ||
        normRel.startsWith('old/') ||
        normRel === 'runner-config.yml' ||
        path.posix.basename(normRel).startsWith('.env')
    ) {
        throw new Error(`Security Violation: Access to restricted path is blocked (${normRel}).`);
    }

    if (mode === 'write' && isProtectedPath(normRel, { allowBootstrap })) {
        throw new Error(
            `Security Violation: Writing to protected Vibe-Coding template/agent file is strictly forbidden (${normRel}).`
        );
    }

    return { fullPath: resolved, relPath: normRel };
}

/**
 * Returns a copy of process.env with all API keys, tokens, and secrets removed.
 * Ensures subprocesses executed by agents cannot read or exfiltrate secrets.
 */
function getSanitizedEnv() {
    const cleanEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
        const isSensitive = SENSITIVE_ENV_PATTERNS.some((regex) => regex.test(key));
        if (!isSensitive) {
            cleanEnv[key] = value;
        }
    }
    cleanEnv.CI = 'true';
    return cleanEnv;
}

/**
 * Redacts known secret values from any log or text output.
 */
function redactSecrets(text) {
    if (typeof text !== 'string' || !text) return '';
    let result = text;
    for (const [key, value] of Object.entries(process.env)) {
        if (
            typeof value === 'string' &&
            value.length >= 8 &&
            SENSITIVE_ENV_PATTERNS.some((regex) => regex.test(key))
        ) {
            result = result.split(value).join('[REDACTED_SECRET]');
        }
    }
    // Redact common token patterns in URLs (GitHub & Forgejo/Codeberg)
    result = result.replace(/https:\/\/[^@\s]+@(github\.com|codeberg\.org)/gi, 'https://[REDACTED]@$1');
    return result;
}

/**
 * Wraps untrusted user/issue content in XML delimiters and neutralizes delimiter breakout
 * and common prompt-injection override phrases.
 */
function wrapUntrustedContent(label, content) {
    const safeLabel = String(label || 'input').replace(/[^a-zA-Z0-9_-]/g, '_');
    const raw = typeof content === 'string' ? content : JSON.stringify(content || '');
    const escaped = raw
        .replace(/<\/?untrusted_input[^>]*>/gi, '[escaped_tag]')
        .replace(/<\/?system_instructions[^>]*>/gi, '[escaped_tag]');

    return [
        `<untrusted_input label="${safeLabel}">`,
        escaped,
        `</untrusted_input>`
    ].join('\n');
}

/**
 * Validates and tokenizes a terminal command string without allowing shell injection.
 * Rejects command chaining (;, &&, ||, |, `, $(), >, <) and unlisted binaries.
 */
function validateAndSplitCommand(cmdString) {
    if (typeof cmdString !== 'string' || !cmdString.trim()) {
        throw new Error('Empty command is not allowed.');
    }

    // Block shell metacharacters & redirection/chaining
    if (/[;&|`$><\r\n]/.test(cmdString)) {
        throw new Error(
            'Security Violation: Shell chaining, pipes, redirection, or command substitution characters (;&|`$><) are forbidden. Execute one simple command at a time.'
        );
    }

    // Parse simple quoted arguments
    const tokens = [];
    const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
    let match;
    while ((match = regex.exec(cmdString.trim())) !== null) {
        tokens.push(match[1] !== undefined ? match[1] : match[2] !== undefined ? match[2] : match[0]);
    }

    if (tokens.length === 0) {
        throw new Error('No executable command found.');
    }

    const binary = path.basename(tokens[0]).replace(/\.exe$/i, '');
    if (!ALLOWED_COMMAND_BINARIES.has(binary)) {
        throw new Error(
            `Security Violation: Binary '${binary}' is not in the allowed command list (${Array.from(ALLOWED_COMMAND_BINARIES).join(', ')}).`
        );
    }

    if (binary === 'git') {
        const sub = tokens[1] || '';
        if (FORBIDDEN_GIT_SUBCOMMANDS.has(sub)) {
            throw new Error(
                `Security Violation: 'git ${sub}' is managed exclusively by the CI/CD pipeline, not the agent.`
            );
        }
    }

    // Prevent node/python inline eval flags that could bypass file guards
    if (
        (binary === 'node' && tokens.some((t) => t === '-e' || t === '--eval' || t === '-p')) ||
        ((binary === 'python' || binary === 'python3') && tokens.includes('-c'))
    ) {
        throw new Error(`Security Violation: Inline script evaluation flags (-e / -c) are disabled.`);
    }

    return { binary: tokens[0], args: tokens.slice(1) };
}

/**
 * Deterministically checks git status/diff to ensure no protected agent or workflow files
 * were modified, deleted, or added before committing or creating a PR.
 */
function assertProtectedFilesUnchanged({ allowBootstrap = false } = {}) {
    let statusOutput = '';
    try {
        statusOutput = execFileSync('git', ['status', '--porcelain'], {
            cwd: REPO_ROOT,
            encoding: 'utf8'
        });
    } catch (e) {
        throw new Error(`Failed to verify git status: ${e.message}`);
    }

    const violations = [];
    const lines = statusOutput.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
        // Porcelain format: XY PATH or XY ORIG -> PATH
        const rawPath = line.slice(3).trim();
        const pathsToCheck = rawPath.includes(' -> ') ? rawPath.split(' -> ') : [rawPath];
        for (const p of pathsToCheck) {
            const cleaned = p.replace(/^"|"$|/g, '');
            if (isProtectedPath(cleaned, { allowBootstrap })) {
                violations.push(cleaned);
            }
        }
    }

    if (violations.length > 0) {
        throw new Error(
            `Security Gate Blocked: Protected template/agent files were modified: ${violations.join(', ')}`
        );
    }
    return true;
}

module.exports = {
    REPO_ROOT,
    DEFAULT_PROTECTED_PREFIXES,
    BOOTSTRAP_WRITABLE_FILES,
    normalizeRelPath,
    isProtectedPath,
    resolveSafePath,
    getSanitizedEnv,
    redactSecrets,
    wrapUntrustedContent,
    validateAndSplitCommand,
    assertProtectedFilesUnchanged
};
