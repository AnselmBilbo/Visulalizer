const { redactSecrets } = require('./security-guard');

/**
 * Resolves the active API key from environment variables without ever logging it.
 */
function getApiKey() {
    return process.env.LLM_API_KEY || process.env.API_KEY || '';
}

/**
 * Resolves LLM provider, model, and endpoint from environment variables and human-readable labels.
 * Everything runs via Cloud API calls by default (no local hardware required).
 */
function resolveLlmConfig(defaultModel = 'gemini-2.5-pro') {
    const rawLabels = (process.env.ISSUE_LABELS || '').toLowerCase();
    let provider = (process.env.LLM_PROVIDER || 'gemini').toLowerCase();

    if (rawLabels.includes('openai')) provider = 'openai';
    else if (rawLabels.includes('gemini') || rawLabels.includes('remote antigravity') || rawLabels.includes('chatbot')) {
        provider = 'gemini';
    }

    const model = process.env.LLM_MODEL || defaultModel;
    const apiKey = getApiKey();

    let apiUrl = process.env.LLM_API_URL || '';
    if (!apiUrl) {
        if (provider === 'gemini') {
            apiUrl = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
        } else {
            apiUrl = 'https://api.openai.com/v1/chat/completions';
        }
    }

    return { provider, model, apiKey, apiUrl };
}

/**
 * Determines the execution mode from human-readable Codeberg labels or AGENT_MODE env var.
 * Supported human-readable labels:
 * - "Chatbot" (or legacy "dev-chatbot") -> 'chatbot'
 * - "Remote Antigravity" (or legacy "dev-agent-antigravity") -> 'remote-antigravity'
 * - "Lokal IDE/Agent" -> 'local-ide'
 */
function resolveAgentMode() {
    const rawMode = (process.env.AGENT_MODE || '').toLowerCase();
    const rawLabels = (process.env.ISSUE_LABELS || '').toLowerCase();
    const combined = `${rawMode} ${rawLabels}`;

    if (combined.includes('remote antigravity') || combined.includes('dev-agent-antigravity')) {
        return 'remote-antigravity';
    }
    if (combined.includes('lokal ide') || combined.includes('local ide')) {
        return 'local-ide';
    }
    return 'chatbot';
}

/**
 * Calls a standard OpenAI-compatible Cloud LLM Chat Completions API (Gemini / OpenAI)
 * with automatic exponential backoff for rate limits (HTTP 429 / 503).
 */
async function callCloudChatApi(messages, options = {}) {
    const { provider, model, apiKey, apiUrl } = resolveLlmConfig(options.defaultModel);

    if (!apiKey || apiKey === 'no-key' || apiKey === 'no-key-needed') {
        throw new Error(
            'Missing LLM_API_KEY / API_KEY secret. Please configure LLM_API_KEY in Codeberg Repository Settings -> Actions -> Secrets.'
        );
    }

    const maxRetries = options.maxRetries ?? 3;
    let attempt = 0;

    while (attempt <= maxRetries) {
        try {
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model,
                    messages,
                    temperature: options.temperature ?? 0.1
                })
            });

            if (response.status === 429 || response.status === 503) {
                attempt++;
                if (attempt > maxRetries) {
                    throw new Error(`LLM API rate limit exceeded after ${maxRetries} retries (HTTP ${response.status}).`);
                }
                const waitMs = Math.pow(3, attempt) * 1000;
                console.log(`[LLM] Rate limit (HTTP ${response.status}). Retrying in ${waitMs / 1000}s...`);
                await new Promise((r) => setTimeout(r, waitMs));
                continue;
            }

            const data = await response.json();
            if (!response.ok || data.error) {
                const errMsg = data.error?.message || JSON.stringify(data.error || data);
                throw new Error(`HTTP ${response.status}: ${errMsg}`);
            }

            const content = data.choices?.[0]?.message?.content;
            if (typeof content !== 'string') {
                throw new Error('Unexpected LLM response structure (missing choices[0].message.content).');
            }
            return content;
        } catch (error) {
            if (attempt >= maxRetries) {
                console.error(`[LLM Error] (${provider}/${model}): ${redactSecrets(error.message)}`);
                throw error;
            }
            attempt++;
            const waitMs = Math.pow(2, attempt) * 1000;
            await new Promise((r) => setTimeout(r, waitMs));
        }
    }
    return '';
}

/**
 * Calls the Gemini Interactions API ("Remote Antigravity" mode) via Cloud API call.
 * SECURITY GUARANTEE: Never sends GIT_TOKEN or repository credentials to the external API.
 * Falls back transparently to the standard Cloud Chat Completions loop if the preview endpoint
 * is unavailable for the user's API key tier.
 */
async function callRemoteAntigravityApi(systemPrompt, taskPrompt) {
    const apiKey = getApiKey();
    if (!apiKey) {
        throw new Error('Missing LLM_API_KEY secret for Remote Antigravity API call.');
    }

    const interactionsUrl =
        process.env.ANTIGRAVITY_API_URL || 'https://generativelanguage.googleapis.com/v1beta/interactions';
    const agentName = process.env.ANTIGRAVITY_AGENT_MODEL || 'antigravity-preview-09-2026';

    const payload = {
        agent: agentName,
        input: `${systemPrompt}\n\n${taskPrompt}`
    };

    try {
        const response = await fetch(interactionsUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey
            },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            const data = await response.json();
            if (!data.error) {
                return data.interaction?.outputText || data.outputText || JSON.stringify(data);
            }
        }
        console.log(
            `[Remote Antigravity] Interactions endpoint returned HTTP ${response.status}; using Cloud Agentic Loop with ${
                process.env.LLM_MODEL || 'gemini-2.5-pro'
            }.`
        );
    } catch (err) {
        console.log(
            `[Remote Antigravity] Interactions endpoint unreachable (${redactSecrets(
                err.message
            )}); using Cloud Agentic Loop.`
        );
    }

    return callCloudChatApi([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: taskPrompt }
    ]);
}

/**
 * Safely extracts the first valid JSON object containing an "action" property from an LLM response.
 * Avoids the greedy regex bug where multiple braces in code blocks break JSON.parse().
 */
function extractJsonToolCall(text) {
    if (typeof text !== 'string' || !text) return null;

    // 1. Check fenced ```json ... ``` blocks first
    const fencedRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
    let match;
    while ((match = fencedRegex.exec(text)) !== null) {
        try {
            const parsed = JSON.parse(match[1].trim());
            if (parsed && typeof parsed.action === 'string') {
                return parsed;
            }
        } catch (_) {}
    }

    // 2. Balanced brace scanner for inline JSON objects
    for (let i = 0; i < text.length; i++) {
        if (text[i] !== '{') continue;
        let depth = 0;
        let inString = false;
        let escaped = false;

        for (let j = i; j < text.length; j++) {
            const ch = text[j];
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === '\\' && inString) {
                escaped = true;
                continue;
            }
            if (ch === '"') {
                inString = !inString;
                continue;
            }
            if (!inString) {
                if (ch === '{') depth++;
                else if (ch === '}') {
                    depth--;
                    if (depth === 0) {
                        const candidate = text.slice(i, j + 1);
                        try {
                            const parsed = JSON.parse(candidate);
                            if (parsed && typeof parsed.action === 'string') {
                                return parsed;
                            }
                        } catch (_) {}
                        break;
                    }
                }
            }
        }
    }

    return null;
}

module.exports = {
    getApiKey,
    resolveLlmConfig,
    resolveAgentMode,
    callCloudChatApi,
    callRemoteAntigravityApi,
    extractJsonToolCall
};
