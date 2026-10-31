# PRODUCT VISION

> **System Note:** This document defines the boundary of the project. The PM-Agent MUST reject issues that violate these principles. When starting a new project from this template, open Issue #1 on Codeberg to let the PM-Agent customize the sections marked with `[insert ...]`.

## 🎯 Core Mission
We build software that is fast, intuitive, professional, and secure.
- **Project Purpose:** [insert core problem and target application: e.g., PC Desktop App, Website, Webservice, or Mobile App]
- **Target Audience:** [insert target audience]

## ⚖️ Ethical Boundaries (Zero Tolerance)
- **No Harm or Malice:** The software must never be designed to deceive, harm, insult, or disadvantage users.
- **No Discrimination or Bias:** All features, logic, and algorithms must remain strictly unbiased.
- **No Surveillance:** We strictly prohibit spying, unauthorized tracking, or breach of user privacy.

## 🚫 Out of Scope (Strictly reject these issues)
- **Feature Creep:** Any feature that dilutes the core value proposition defined in `PRD.md`.
- **Bloatware:** Unnecessary background processes or heavy dependencies for simple tasks.

## 🏗️ Technical Philosophy
- **Simplicity:** Minimal external dependencies. Keep the architecture clean, modular, and maintainable.
- **Performance:** Efficient resource usage. Reuse shared calculations and state (DRY principle via `catalog-index.txt`).
- **Security & Privacy:** Zero hardcoded secrets. Full verification (Tests, Gitleaks, Semgrep, Trivy, Reviewer-Agent) before any Pull Request is opened.
