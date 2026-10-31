# PRODUCT REQUIREMENTS DOCUMENT (PRD)

> **System Note:** This document is automatically generated and maintained by the PM-Agent during project initialization based on `PRODUCT_VISION.md` and the initial Codeberg issue.

## 1. Project Overview & Target Platform
- **Project Name:** [insert project name]
- **Target Platform:** [insert target platform: PC Desktop App | Website | Webservice/API | Mobile App | CLI]
- **Primary Tech Stack:** [insert language & framework]

## 2. Core Features & Architecture
- [insert core features once initialized via Codeberg Issue #1]

## 3. Non-Functional Requirements
- **Test-Driven Development (TDD):** Every feature requires automated tests that pass before a Pull Request is created.
- **Zero-Trust Security:** All code must pass Gitleaks (no secrets), Semgrep (SAST), Trivy (CVE check), and the Protected-File Guard before any Pull Request is opened.
- **DRY & Catalog Discipline:** All reusable functions, constants, UI components, and API endpoints must be registered in `.ai-context/catalog-index.txt` and documented in `.ai-context/docs/`.
