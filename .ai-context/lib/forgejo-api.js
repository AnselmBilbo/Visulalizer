const { redactSecrets } = require('./security-guard');

const DEFAULT_LABEL_COLORS = {
    'Chatbot': '#0075ca',
    'Remote Antigravity': '#7057ff',
    'Lokal IDE/Agent': '#0e8a16',
    'Ready for Dev': '#2cbe4e',
    'Needs Clarification': '#d93f0b',
    'Needs Fix': '#e11d21',
    'Needs Human Help': '#b60205',
    'Resolve Conflict': '#fbca04',
    'Admin Override': '#5319e7'
};

function getForgejoConfig() {
    const apiUrl = (
        process.env.GITHUB_API_URL ||
        process.env.FORGEJO_API_URL ||
        'https://api.github.com'
    ).replace(/\/$/, '');
    const isGitHub =
        apiUrl.includes('github.com') ||
        (process.env.GIT_PLATFORM || 'github').toLowerCase() === 'github';
    const repoName = process.env.REPO_NAME || process.env.GITHUB_REPOSITORY || '';
    const token =
        process.env.VIBE_GIT_TOKEN ||
        process.env.GITHUB_TOKEN ||
        process.env.FORGEJO_TOKEN ||
        process.env.GIT_TOKEN ||
        '';
    return { apiUrl, isGitHub, repoName, token };
}

async function forgejoRequest(endpoint, options = {}) {
    const { apiUrl, isGitHub, repoName, token } = getForgejoConfig();
    if (!repoName || !token) {
        console.log(`[Git API] Skipping API call to ${endpoint} (no REPO_NAME or GITHUB_TOKEN/VIBE_GIT_TOKEN in environment).`);
        return null;
    }

    const url = `${apiUrl}/repos/${repoName}${endpoint}`;
    const headers = {
        'Accept': isGitHub ? 'application/vnd.github+json' : 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Vibe-Coding-Agent',
        'Authorization': isGitHub ? `Bearer ${token}` : `token ${token}`,
        ...(isGitHub ? { 'X-GitHub-Api-Version': '2022-11-28' } : {}),
        ...(options.headers || {})
    };

    const response = await fetch(url, {
        method: options.method || 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Git API ${options.method || 'GET'} ${endpoint} failed (${response.status}): ${redactSecrets(text)}`);
    }

    if (response.status === 204) return null;
    return response.json();
}

/**
 * Fetches an issue and all of its comments so the Dev-Agent can read the PM-Agent's TDD Contract
 * and any human clarifications.
 */
async function getIssueWithComments(issueNumber) {
    if (!issueNumber || issueNumber === 'manual') return { issue: null, comments: [] };
    try {
        const issue = await forgejoRequest(`/issues/${issueNumber}`);
        const comments = (await forgejoRequest(`/issues/${issueNumber}/comments?per_page=100`)) || [];
        return { issue, comments };
    } catch (err) {
        console.warn(`[Git API] Could not fetch issue #${issueNumber} comments: ${redactSecrets(err.message)}`);
        return { issue: null, comments: [] };
    }
}

/**
 * Posts a Markdown comment to a GitHub/Forgejo Issue or Pull Request.
 */
async function postIssueComment(issueNumber, markdownBody) {
    if (!issueNumber || issueNumber === 'manual') return null;
    try {
        return await forgejoRequest(`/issues/${issueNumber}/comments`, {
            method: 'POST',
            body: { body: redactSecrets(markdownBody) }
        });
    } catch (err) {
        console.error(`[Git API] Failed to post comment to #${issueNumber}: ${redactSecrets(err.message)}`);
        return null;
    }
}

/**
 * Ensures the given human-readable label names exist in the repository and returns their numeric IDs.
 */
async function resolveOrCreateLabelIds(labelNames) {
    const { isGitHub } = getForgejoConfig();
    const existing = (await forgejoRequest('/labels?per_page=100&limit=100')) || [];
    const ids = [];

    for (const rawName of labelNames) {
        const targetName = rawName.trim();
        let found = existing.find((l) => l.name.toLowerCase() === targetName.toLowerCase());
        if (!found) {
            try {
                const rawHex = DEFAULT_LABEL_COLORS[targetName] || '#ededed';
                const colorValue = isGitHub ? rawHex.replace(/^#/, '') : rawHex;
                found = await forgejoRequest('/labels', {
                    method: 'POST',
                    body: {
                        name: targetName,
                        color: colorValue,
                        description: `Vibe-Coding workflow label: ${targetName}`
                    }
                });
            } catch (err) {
                console.warn(`[Git API] Could not auto-create label '${targetName}': ${redactSecrets(err.message)}`);
            }
        }
        if (found && found.id) {
            ids.push(found.id);
        }
    }

    return ids;
}

/**
 * Adds human-readable labels to an Issue or Pull Request without removing unrelated labels.
 * Automatically adapts payload format between GitHub REST API (string label names) and Forgejo (numeric label IDs).
 */
async function addIssueLabels(issueNumber, labelNamesToAdd = [], labelNamesToRemove = []) {
    if (!issueNumber || issueNumber === 'manual') return null;
    try {
        const { isGitHub } = getForgejoConfig();
        const issue = await forgejoRequest(`/issues/${issueNumber}`);
        if (!issue) return null;

        const removeSet = new Set(labelNamesToRemove.map((n) => n.toLowerCase()));
        const keptNames = (issue.labels || [])
            .map((l) => (typeof l === 'string' ? l : l.name))
            .filter((name) => name && !removeSet.has(name.toLowerCase()));

        const finalNames = Array.from(new Set([...keptNames, ...labelNamesToAdd]));
        const labelIds = await resolveOrCreateLabelIds(finalNames);

        return await forgejoRequest(`/issues/${issueNumber}/labels`, {
            method: 'PUT',
            body: { labels: isGitHub ? finalNames : labelIds }
        });
    } catch (err) {
        console.warn(`[Git API] Could not update labels on #${issueNumber}: ${redactSecrets(err.message)}`);
        return null;
    }
}

/**
 * Creates a Pull Request (or returns the existing open PR) ONLY after all tests,
 * security scans, and Reviewer-Agent checks have passed.
 */
async function createOrUpdatePullRequest({ head, base = 'main', title, body }) {
    try {
        const openPrs = (await forgejoRequest('/pulls?state=open&per_page=50&limit=50')) || [];
        const existing = openPrs.find((pr) => pr.head && pr.head.ref === head && pr.base && pr.base.ref === base);

        if (existing) {
            console.log(`[Git API] Pull Request #${existing.number} already exists for branch '${head}'.`);
            await postIssueComment(existing.number, body);
            return existing;
        }

        const pr = await forgejoRequest('/pulls', {
            method: 'POST',
            body: {
                title,
                body: redactSecrets(body),
                head,
                base
            }
        });
        if (pr && pr.number) {
            console.log(`[Git API] Successfully created Pull Request #${pr.number} (${head} -> ${base}).`);
        }
        return pr;
    } catch (err) {
        console.error(`[Git API] Failed to create Pull Request for '${head}': ${redactSecrets(err.message)}`);
        throw err;
    }
}

module.exports = {
    DEFAULT_LABEL_COLORS,
    getForgejoConfig,
    forgejoRequest,
    getIssueWithComments,
    postIssueComment,
    resolveOrCreateLabelIds,
    addIssueLabels,
    createOrUpdatePullRequest
};
