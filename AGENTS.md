# 🤖 AGENTS.md — Universal Vibe-Coding Instructions (Antigravity IDE, Codex & Cloud Agents)

This repository uses an autonomous, test-driven **Vibe-Coding Pipeline** orchestrated via GitHub Issues and Pull Requests (with GitHub Actions).
Whether you are running as a **Cloud Agent via GitHub Actions** (`Chatbot` or `Remote Antigravity`) or interactively inside a **Local IDE/Agent** (`Antigravity IDE`, `Codex`, `Cursor`), you **MUST** follow the exact same workflow and rules.

---

## 1. Mandatory Context Reading (Explore First)
Before writing or modifying any code, always read:
1. [`.ai-context/core-rules.md`](.ai-context/core-rules.md) — Non-negotiable coding, TDD, and security rules.
2. [`.ai-context/PRODUCT_VISION.md`](.ai-context/PRODUCT_VISION.md) & [`.ai-context/PRD.md`](.ai-context/PRD.md) — Product scope and target platform.
3. [`.ai-context/project-config.json`](.ai-context/project-config.json) — Configured test, lint, and build commands.
4. [`.ai-context/catalog-index.txt`](.ai-context/catalog-index.txt) — Index of existing components, functions, constants, and documentation in `.ai-context/docs/`. **Always reuse existing modules (DRY principle).**

---

## 2. Strict Self-Protection Boundary
**NEVER** modify, overwrite, or delete any file that belongs to the Vibe-Coding agent infrastructure:
- `.ai-context/agents/**`
- `.ai-context/skills/**`
- `.ai-context/lib/**`
- `.ai-context/mcp/**`
- `.ai-context/core-rules.md`
- `.github/**`
- `.forgejo/**`
- `.gitignore`
- `AGENTS.md`

Any branch that modifies these protected files will be automatically blocked by the Pre-PR Security Gate.

---

## 3. Unified Development & Verification Loop
When working on a feature or bugfix (from a GitHub Issue or directly in Antigravity / Codex):
1. **Branching:** Always work on a dedicated branch named `feature/issue-{id}` (or `feature/<short-name>`). Never commit directly to `main`.
2. **TDD First:** Write or update automated unit/integration tests before or alongside your implementation.
3. **Run Verification Locally:** Execute the test command from `.ai-context/project-config.json` (plus `node .ai-context/lib/self-test.js`) until all checks pass with exit code `0`.
4. **Update Documentation & Catalog:**
   - Verify your actual changes using `git diff`.
   - Document new/modified modules in `.ai-context/docs/<module>.md`.
   - Add a 1-sentence reference under the matching category in `.ai-context/catalog-index.txt`.
5. **Push Branch for Pre-PR Security & Architect Gate:**
   - Push your branch (`git push -u origin feature/...`).
   - GitHub's automated **Pre-PR Verification Pipeline** (`.github/workflows/security-firewall.yml`) will automatically run all tests, Gitleaks, Semgrep, Trivy, and the Reviewer-Agent.
   - **Only when all checks pass** will the pipeline automatically open/update the Pull Request on GitHub for final human approval.

---

## 4. Human-Readable GitHub Labels
| Label | Purpose |
| :--- | :--- |
| **`Chatbot`** | Selects the fast Cloud LLM API Agentic Loop for the issue. |
| **`Remote Antigravity`** | Selects the Cloud Gemini Interactions API Agent for the issue. |
| **`Lokal IDE/Agent`** | Marks an issue as being developed interactively in Antigravity IDE / Codex. |
| **`Ready for Dev`** | Human approval signal: starts the selected Dev-Agent on the TDD Contract. |
| **`Needs Clarification`** | Set automatically when an agent has posted a question in the issue and awaits human input. |
| **`Needs Fix`** | Set automatically when a review or check requests corrections. |
| **`Needs Human Help`** | Set automatically if automated self-healing retries are exhausted. |
| **`Resolve Conflict`** | Triggers the Conflict-Resolver Agent on a Pull Request with merge conflicts. |
| **`Admin Override`** | Skips automatic PM-Agent triage on an issue. |
