# 📜 Project Core Rules

These are the fundamental, non-negotiable rules for all AI agents (PM-Agent, Dev-Agent, Reviewer-Agent, Documentation-Agent, Conflict-Resolver, as well as local IDE agents like Antigravity and Codex) working on this repository.

## 1. Architectural Mindset: Contract-First, DRY & TDD
*   **No Guessing:** Never invent APIs, data structures, or UI components outside the scope of the provided task. If requirements are ambiguous, ask for clarification in the Codeberg issue.
*   **Contract Adherence:** The Dev-Agent MUST strictly follow the technical contract (TDD Contract) established by the PM-Agent.
*   **DRY & Catalog First:** Before creating any function, constant, UI component, or signal/data processor (e.g., FFT calculation, theme colors, API helpers), search `.ai-context/catalog-index.txt` and `.ai-context/docs/`. Reuse and extend existing modules instead of duplicating logic.
*   **Test-Driven (TDD):** Always write or update automated tests FIRST. Code is only considered complete when the project's test command (configured in `.ai-context/project-config.json`) returns an exit code of `0`.

## 2. Code Quality & Platform Agnosticism
*   **Language:** Write all code, identifiers, comments, and technical documentation in English.
*   **Readability over Cleverness:** Write modular, clean code that is easy for humans and other AI agents to read and maintain.
*   **Multi-Platform Ready:** Respect the target platform and stack defined in `.ai-context/project-config.json` and `.ai-context/PRD.md` (PC Desktop App, Website, Webservice/API, Mobile App, or CLI Tool).

## 3. Security & Self-Protection (Zero Tolerance)
*   **No Secrets:** NEVER hardcode API keys, passwords, runner tokens, or personal data in the codebase, workflows, or prompts. Never transmit repository tokens (`GIT_TOKEN`, `FORGEJO_TOKEN`) to external LLM APIs.
*   **Immutable Agent Infrastructure:** Agents are strictly forbidden from modifying or deleting any file that controls the Vibe-Coding loop itself (`.ai-context/agents/**`, `.ai-context/skills/**`, `.ai-context/lib/**`, `.ai-context/core-rules.md`, `.forgejo/**`, `.gitignore`, `AGENTS.md`).
*   **Pre-PR Security Verification:** All unit tests, Gitleaks secret scans, Semgrep SAST scans, Trivy vulnerability checks, and Reviewer-Agent checks MUST pass **before** a Pull Request is created.
*   **Input & Command Safety:** Always sanitize external inputs. Never use shell string concatenation or command chaining (`;`, `&&`, `|`, `` ` ``, `$()`) in terminal tools.

## 4. Git, Branching & Documentation Protocol
*   **Isolated Branches:** All development happens on isolated branches (e.g., `feature/issue-{id}`). Never push feature code directly to `main`.
*   **Verified Documentation Only:** Document every new or updated module in `.ai-context/docs/` and register a concise 1-sentence link in `.ai-context/catalog-index.txt` ONLY after verifying the actual `git diff`. Never hallucinate unimplemented features.
*   **Semantic Conflict Resolution:** When resolving merge conflicts, analyze both sides of the `<<<<<<<` markers and preserve both features semantically before re-running all tests and security gates.
