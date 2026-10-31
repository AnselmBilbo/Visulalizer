const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
    REPO_ROOT,
    assertProtectedFilesUnchanged,
    isProtectedPath,
    redactSecrets
} = require('../lib/security-guard');
const {
    resolveAgentMode,
    callCloudChatApi,
    callRemoteAntigravityApi,
    extractJsonToolCall
} = require('../lib/llm-client');
const { runProjectTests } = require('./dev-agent');
const { run_review } = require('./reviewer-agent');

const getFile = (filepath) => {
    try {
        return fs.readFileSync(path.join(__dirname, '..', filepath), 'utf8');
    } catch (_) {
        return 'File not found: ' + filepath;
    }
};

const coreRules = getFile('core-rules.md');
const catalogIndex = getFile('catalog-index.txt');
const productVision = getFile('PRODUCT_VISION.md');
const prd = getFile('PRD.md');
const projectConfigRaw = getFile('project-config.json');

const loadedTools = [];
const toolInstructions = [];

const skillsDir = path.join(__dirname, '..', 'skills');
if (fs.existsSync(skillsDir)) {
    fs.readdirSync(skillsDir)
        .filter((f) => f.endsWith('.js'))
        .forEach((file) => {
            const skillModule = require(path.join(skillsDir, file));
            skillModule.forEach((tool) => {
                loadedTools.push(tool);
                toolInstructions.push(tool.instruction);
            });
        });
}

/**
 * Checks Git history to determine whether any new merges or feature commits
 * occurred within the last 7 days (or since the last Gardener commit).
 * Automated bot commits from the Gardener or Librarian are ignored.
 *
 * @param {object} [options]
 * @param {string[]} [options.mockCommitSubjects] - Optional array of commit subjects for unit testing.
 * @returns {{ hasNewMerges: boolean, commits: string[] }}
 */
function checkRecentMergeActivity(options = {}) {
    if (process.env.FORCE_GARDENER === 'true' && !options.mockCommitSubjects) {
        return { hasNewMerges: true, commits: ['FORCE_GARDENER=true (manual override)'] };
    }

    let rawSubjects = [];
    if (Array.isArray(options.mockCommitSubjects)) {
        rawSubjects = options.mockCommitSubjects;
    } else {
        try {
            // Find timestamp of last gardener commit if one exists
            let lastGardenerSha = '';
            try {
                lastGardenerSha = execFileSync(
                    'git',
                    ['log', '-n', '1', '--grep=chore(gardener)', '--format=%H'],
                    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
                ).trim();
            } catch (_) {
                lastGardenerSha = '';
            }

            const logArgs = lastGardenerSha
                ? ['log', `${lastGardenerSha}..HEAD`, '--since=7.days.ago', '--format=%s']
                : ['log', '--since=7.days.ago', '--format=%s'];

            const logOut = execFileSync('git', logArgs, {
                cwd: REPO_ROOT,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            });
            rawSubjects = logOut
                .split(/\r?\n/)
                .map((s) => s.trim())
                .filter(Boolean);
        } catch (_) {
            rawSubjects = [];
        }
    }

    // Filter out automated maintenance commits (Gardener & Documentation Librarian)
    const meaningfulCommits = rawSubjects.filter((subject) => {
        const lower = subject.toLowerCase();
        if (lower.startsWith('chore(gardener):')) return false;
        if (lower.startsWith('docs(librarian):')) return false;
        return true;
    });

    return {
        hasNewMerges: meaningfulCommits.length > 0,
        commits: meaningfulCommits
    };
}

/**
 * Extracts all documented symbols from .ai-context/catalog-index.txt and all exported
 * functions/variables across application source files so we can deterministically verify
 * that the Gardener NEVER deletes any feature or used symbol.
 */
function captureFeatureAndSymbolSnapshot(customFiles = null) {
    const catalogSymbols = new Set();

    // 1. Extract documented exports from catalog-index.txt (e.g., "(exports: foo, bar)")
    const exportMatches = catalogIndex.matchAll(/exports\s*:\s*([^)\n]+)/gi);
    for (const match of exportMatches) {
        match[1]
            .split(',')
            .map((s) => s.trim().replace(/^['"`]|['"`]$/g, ''))
            .filter((s) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s))
            .forEach((sym) => catalogSymbols.add(sym));
    }

    // 2. Scan application source files for exported functions, classes, and variables
    const appFiles = [];
    if (customFiles) {
        appFiles.push(...customFiles);
    } else {
        function walk(dir) {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (['.git', 'node_modules', 'old', 'dist', 'build', '.venv', 'target'].includes(entry.name)) {
                    continue;
                }
                const fullPath = path.join(dir, entry.name);
                const relPath = path.relative(REPO_ROOT, fullPath).replace(/\\/g, '/');
                if (entry.isDirectory()) {
                    walk(fullPath);
                } else if (
                    !isProtectedPath(relPath, { allowBootstrap: false }) &&
                    /\.(js|ts|jsx|tsx|mjs|cjs|py|rs|go|java|kt|dart)$/i.test(entry.name)
                ) {
                    appFiles.push({
                        relPath,
                        content: fs.readFileSync(fullPath, 'utf8')
                    });
                }
            }
        }
        walk(REPO_ROOT);
    }

    const exportedSymbolsByFile = new Map();
    const allContentsCombined = appFiles.map((f) => f.content).join('\n');

    for (const file of appFiles) {
        const symbols = new Set();
        const patterns = [
            /export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
            /exports\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g,
            /module\.exports\s*=\s*\{([^}]+)\}/g,
            /(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g,
            /def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
            /pub\s+fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g
        ];

        for (const regex of patterns) {
            for (const match of file.content.matchAll(regex)) {
                if (regex.source.includes('module\\.exports')) {
                    match[1]
                        .split(',')
                        .map((part) => part.split(':')[0].trim())
                        .filter((s) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s))
                        .forEach((s) => symbols.add(s));
                } else {
                    const sym = match[1];
                    // If it's a top-level/named function or export, check if it's referenced more than once across the project or in catalog
                    const refRegex = new RegExp(`\\b${sym}\\b`, 'g');
                    const totalOccurrences = (allContentsCombined.match(refRegex) || []).length;
                    if (totalOccurrences > 1 || catalogSymbols.has(sym) || file.content.includes('export')) {
                        symbols.add(sym);
                    }
                }
            }
        }
        exportedSymbolsByFile.set(file.relPath, symbols);
    }

    return {
        catalogSymbols: Array.from(catalogSymbols),
        exportedSymbolsByFile
    };
}

/**
 * Deterministically verifies that no cataloged or referenced function/variable/file
 * was deleted by the Gardener Agent.
 *
 * @param {{ catalogSymbols: string[], exportedSymbolsByFile: Map<string, Set<string>> }} baseline
 * @param {Array<{relPath: string, content: string}>} [currentCustomFiles]
 * @returns {{ passed: boolean, reason: string }}
 */
function verifyFeaturePreservation(baseline, currentCustomFiles = null) {
    const currentFilesMap = new Map();
    if (currentCustomFiles) {
        for (const f of currentCustomFiles) {
            currentFilesMap.set(f.relPath, f.content);
        }
    } else {
        for (const [relPath] of baseline.exportedSymbolsByFile.entries()) {
            const fullPath = path.join(REPO_ROOT, relPath);
            if (!fs.existsSync(fullPath)) {
                return {
                    passed: false,
                    reason: `Feature Preservation Violation: Gardener deleted existing source file '${relPath}'. Gardener must NEVER delete feature files.`
                };
            }
            currentFilesMap.set(relPath, fs.readFileSync(fullPath, 'utf8'));
        }
    }

    const combinedCurrentCode = Array.from(currentFilesMap.values()).join('\n');

    // 1. Verify all symbols documented in catalog-index.txt still exist
    for (const sym of baseline.catalogSymbols) {
        const regex = new RegExp(`\\b${sym}\\b`);
        if (!regex.test(combinedCurrentCode)) {
            return {
                passed: false,
                reason: `Feature Preservation Violation: Cataloged symbol '${sym}' (from .ai-context/catalog-index.txt) was removed!`
            };
        }
    }

    // 2. Verify all exported/referenced functions and variables per file remain intact
    for (const [relPath, symbolSet] of baseline.exportedSymbolsByFile.entries()) {
        const currentContent = currentFilesMap.get(relPath) || '';
        for (const sym of symbolSet) {
            const regex = new RegExp(`\\b${sym}\\b`);
            if (!regex.test(currentContent) && !regex.test(combinedCurrentCode)) {
                return {
                    passed: false,
                    reason: `Feature Preservation Violation: Used function/variable '${sym}' in '${relPath}' was deleted by Gardener! Only provably unused dead code without functionality may be removed.`
                };
            }
        }
    }

    return { passed: true, reason: 'All cataloged features, exported functions, and active variables are preserved.' };
}

/**
 * Verifies that whenever the Gardener modifies any source code file/function,
 * it also updates the documentation in .ai-context/docs/ (and/or .ai-context/catalog-index.txt).
 *
 * @param {string[]} [mockModifiedPaths] - Optional list of modified relative paths for unit testing.
 * @returns {{ passed: boolean, reason: string }}
 */
function verifyGardenerDocumentationSync(mockModifiedPaths = null) {
    let changedPaths = [];
    if (Array.isArray(mockModifiedPaths)) {
        changedPaths = mockModifiedPaths.map((p) => p.replace(/\\/g, '/'));
    } else {
        try {
            const statusOut = execFileSync('git', ['status', '--porcelain'], {
                cwd: REPO_ROOT,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            });
            changedPaths = statusOut
                .split(/\r?\n/)
                .map((l) => l.trim())
                .filter(Boolean)
                .map((line) => {
                    const raw = line.slice(3).trim();
                    const arrowIdx = raw.indexOf(' -> ');
                    return (arrowIdx !== -1 ? raw.slice(arrowIdx + 4) : raw).replace(/^"|"$/g, '').replace(/\\/g, '/');
                });
        } catch (_) {
            changedPaths = [];
        }
    }

    const modifiedCodeFiles = changedPaths.filter(
        (relPath) =>
            !relPath.startsWith('.ai-context/') &&
            /\.(js|ts|jsx|tsx|mjs|cjs|py|rs|go|java|kt|dart)$/i.test(relPath)
    );

    if (modifiedCodeFiles.length === 0) {
        return { passed: true, reason: 'No source code files modified; documentation sync not required.' };
    }

    const modifiedDocFiles = changedPaths.filter(
        (relPath) => relPath.startsWith('.ai-context/docs/') || relPath === '.ai-context/catalog-index.txt'
    );

    if (modifiedDocFiles.length === 0) {
        return {
            passed: false,
            reason: `Documentation Sync Violation: Gardener modified function(s) in [${modifiedCodeFiles.join(', ')}] without updating the documentation in '.ai-context/docs/<module>.md' (and '.ai-context/catalog-index.txt' if applicable). Whenever a function is refactored or optimized, its documentation MUST be updated to reflect the changes!`
        };
    }

    return {
        passed: true,
        reason: `Documentation updated in [${modifiedDocFiles.join(', ')}] alongside code refactoring.`
    };
}

function buildGardenerSystemPrompt(baselineSnapshot) {
    const protectedSymbolsList = [
        ...new Set([
            ...baselineSnapshot.catalogSymbols,
            ...Array.from(baselineSnapshot.exportedSymbolsByFile.values()).flatMap((set) => Array.from(set))
        ])
    ];

    return `You are the autonomous Gardener-Agent (Gärtner-Agent) in a Test-Driven Vibe-Coding repository.
Your job runs once a week after new merges have occurred to keep the codebase clean, fast, and free of spaghetti code.

STRICT NON-NEGOTIABLE SAFETY & FEATURE-PRESERVATION RULES:
1. NEVER DELETE FEATURES OR USED CODE:
   - You MUST NEVER delete any function, method, class, variable, constant, route, or UI component that is used anywhere in the project or belongs to the program's features (see PRD & Catalog Index below).
   - Specifically, these active symbols/exports MUST remain intact and functional: ${protectedSymbolsList.length > 0 ? protectedSymbolsList.join(', ') : '(all exported and referenced functions/variables)'}.
   - Never change public function signatures, return types, or module exports.
2. WHAT YOU SHOULD CLEAN UP & OPTIMIZE:
   - Remove provably dead code that has ZERO functionality and ZERO references (e.g., unreachable code after return/throw, unused local temporary variables, commented-out legacy code blocks, duplicate imports).
   - Refactor internal spaghetti code (deeply nested if/else pyramids, duplicated internal helper blocks) into clean, readable logic while keeping external behavior 100% identical.
   - Optimize inefficient or useless loops (e.g., redundant multi-pass array iterations, unnecessary O(n^2) nested loops where a Set/Map lookup is O(1), or no-op loops) for maximum runtime performance and stability.
3. MANDATORY DOCUMENTATION UPDATE WHEN MODIFYING A FUNCTION:
   - Whenever you refactor, clean up, or optimize a function, you MUST first check 'git diff' via 'execute_terminal_command' and then update its documentation in '.ai-context/docs/<module>.md' (and '.ai-context/catalog-index.txt' if needed) so the documentation accurately describes the updated internal behavior and performance optimization.
4. NEVER MODIFY PROTECTED AGENT/TEMPLATE FILES:
   - Never modify .ai-context/agents/**, .ai-context/skills/**, .ai-context/lib/**, .ai-context/core-rules.md, .forgejo/**, .gitignore, or AGENTS.md.
5. IF THE CODEBASE IS ALREADY CLEAN:
   - If there is no dead code or spaghetti loop to improve safely, do NOT make cosmetic changes just for the sake of editing. Immediately output {"action": "finish", "summary": "Codebase is already clean and optimal."}.

--- CORE RULES ---
${coreRules}

--- PRODUCT VISION ---
${productVision}

--- PRD (All features described here MUST be preserved 100%) ---
${prd}

--- PROJECT CONFIG ---
${projectConfigRaw}

--- CATALOG INDEX (All documented modules & exports MUST be preserved 100%) ---
${catalogIndex}

DYNAMIC TOOLKIT (Output a single JSON block per step):
${toolInstructions.join('\n')}
- {"action": "finish", "summary": "Concise summary of removed dead code, simplified spaghetti logic, and loop performance optimizations"}`;
}

async function callModelByMode(mode, history, systemPrompt) {
    if (mode === 'remote-antigravity') {
        const transcript = history
            .filter((m) => m.role !== 'system')
            .map((m) => `[${m.role.toUpperCase()}]:\n${m.content}`)
            .join('\n\n');
        return callRemoteAntigravityApi(systemPrompt, transcript);
    }
    return callCloudChatApi(history);
}

async function run_gardener() {
    console.log('🌿 Starting Weekly Gardener-Agent (Code Hygiene, Anti-Spaghetti & Loop Optimization)...');

    // Step 1: Check if any new merges/commits happened in the last 7 days
    const mergeCheck = checkRecentMergeActivity();
    if (!mergeCheck.hasNewMerges) {
        console.log('ℹ️ No new merges or feature commits since the last Gardener run. Skipping cleanup to save API calls.');
        return { skipped: true, reason: 'no_new_merges' };
    }

    console.log(`🔍 Found ${mergeCheck.commits.length} recent commit(s)/merge(s) to inspect:\n  - ${mergeCheck.commits.slice(0, 10).join('\n  - ')}`);

    // Step 2: Capture Baseline Snapshot of all features, exports, and used symbols
    const baselineSnapshot = captureFeatureAndSymbolSnapshot();
    const mode = resolveAgentMode();
    const systemPrompt = buildGardenerSystemPrompt(baselineSnapshot);

    const initialUserPrompt = `Recent merges/commits on main:\n${mergeCheck.commits.map((c) => `- ${c}`).join('\n')}\n\nPlease inspect the application codebase using 'search_files' and 'read_file'.
Identify and clean up ONLY:
1. Unused/dead local variables, unreachable code, or duplicate imports without functionality.
2. Spaghetti control flow or redundant/inefficient loops that can be made faster and more stable without altering any feature, public function signature, or variable needed by the program.
3. If you modify any function, verify your changes with 'git diff' and update its documentation in '.ai-context/docs/<module>.md' (and '.ai-context/catalog-index.txt' if needed) to describe the refactored function before calling 'finish'.`;

    const MAX_VERIFICATION_CYCLES = 3;
    const MAX_TOOL_STEPS_PER_CYCLE = 12;
    let cycle = 0;
    let feedbackPrompt = '';

    while (cycle < MAX_VERIFICATION_CYCLES) {
        cycle++;
        console.log(`\n🌿 === Gardener Verification Cycle ${cycle}/${MAX_VERIFICATION_CYCLES} ===`);

        const history = [
            { role: 'system', content: systemPrompt },
            {
                role: 'user',
                content: feedbackPrompt
                    ? `${initialUserPrompt}\n\nPREVIOUS GARDENER ATTEMPT VIOLATED SAFETY OR TESTS. FIX OR REVERT IMMEDIATELY:\n${feedbackPrompt}`
                    : initialUserPrompt
            }
        ];

        let step = 0;
        let finalSummary = '';

        while (step < MAX_TOOL_STEPS_PER_CYCLE) {
            step++;
            const llmResponse = await callModelByMode(mode, history, systemPrompt);
            history.push({ role: 'assistant', content: llmResponse });

            const toolCall = extractJsonToolCall(llmResponse);
            if (!toolCall || !toolCall.action || toolCall.action === 'finish') {
                finalSummary = (toolCall && toolCall.summary) || llmResponse;
                break;
            }

            const activeTool = loadedTools.find((t) => t.name === toolCall.action);
            const toolResult = activeTool
                ? await activeTool.execute(toolCall)
                : `Error: Unknown action '${toolCall.action}'. Available actions: ${loadedTools.map((t) => t.name).join(', ')}, finish`;

            console.log(`[Gardener Step ${step} - ${toolCall.action}]: ${redactSecrets(String(toolResult).slice(0, 280))}`);
            history.push({ role: 'user', content: `Tool Result:\n${toolResult}` });
        }

        // --- PRE-PR GARDENER VERIFICATION GATES ---
        // Gate 1: Protected Template/Agent Files Guard
        try {
            assertProtectedFilesUnchanged({ allowBootstrap: false });
        } catch (guardErr) {
            feedbackPrompt = guardErr.message;
            console.warn(`⚠️ Gardener Protected-File Guard failed: ${feedbackPrompt}`);
            continue;
        }

        // Gate 2: Deterministic Feature-Preservation Guard (No deleted functions/variables/exports)
        const preservationCheck = verifyFeaturePreservation(baselineSnapshot);
        if (!preservationCheck.passed) {
            feedbackPrompt = preservationCheck.reason;
            console.warn(`⚠️ Gardener Feature-Preservation Guard failed: ${feedbackPrompt}`);
            continue;
        }

        // Gate 3: Deterministic Documentation Sync Guard (Modified functions MUST be documented in .ai-context/docs/)
        const docSyncCheck = verifyGardenerDocumentationSync();
        if (!docSyncCheck.passed) {
            feedbackPrompt = docSyncCheck.reason;
            console.warn(`⚠️ Gardener Documentation Sync Guard failed: ${feedbackPrompt}`);
            continue;
        }

        // Gate 4: Project Lint & Unit/Integration Test Suite
        const testOutcome = runProjectTests();
        if (!testOutcome.passed) {
            feedbackPrompt = testOutcome.errorOutput;
            console.warn(`⚠️ Project tests failed after Gardener refactoring:\n${feedbackPrompt}`);
            continue;
        }

        // Gate 5: Architectural Reviewer-Agent Check
        const reviewOutcome = await run_review({ postComment: false });
        if (!reviewOutcome.approved) {
            feedbackPrompt = `Reviewer-Agent rejected Gardener refactoring:\n${reviewOutcome.summary}`;
            console.warn(`⚠️ Reviewer-Agent rejected Gardener changes:\n${feedbackPrompt}`);
            continue;
        }

        console.log('✅ All 5 Gardener Safety Gates (Protected Files, Feature Preservation, Documentation Sync, Unit Tests, Reviewer Check) PASSED!');
        console.log('Gardener Summary:\n', redactSecrets(finalSummary));
        return { skipped: false, summary: finalSummary };
    }

    // If verification failed after all retries, revert working tree so no broken code is ever left behind
    console.error(`🚨 Gardener-Agent could not verify refactoring after ${MAX_VERIFICATION_CYCLES} cycles. Reverting working tree for safety.`);
    try {
        execFileSync('git', ['checkout', '--', '.'], { cwd: REPO_ROOT, stdio: 'ignore' });
        execFileSync('git', ['clean', '-fd'], { cwd: REPO_ROOT, stdio: 'ignore' });
    } catch (_) {
        // Ignore cleanup errors
    }
    process.exit(1);
}

if (require.main === module) {
    run_gardener().catch((err) => {
        console.error(`🚨 Gardener-Agent failed: ${redactSecrets(err.message)}`);
        process.exit(1);
    });
}

module.exports = {
    run_gardener,
    checkRecentMergeActivity,
    captureFeatureAndSymbolSnapshot,
    verifyFeaturePreservation,
    verifyGardenerDocumentationSync
};
