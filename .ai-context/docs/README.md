# 📚 Project Technical Documentation

This directory stores detailed technical documentation for all modules, state stores, UI components, and API endpoints implemented in this repository.

## Workflow & DRY Discipline
1. **Explore First:** Every agent checks [`.ai-context/catalog-index.txt`](../catalog-index.txt) first and reads the linked markdown files in this directory before writing new code.
2. **Verified Documentation Only:** Whenever a Dev-Agent (or a developer in Antigravity IDE / Codex) adds or updates a feature, it verifies the changes via `git diff`, documents the module in `.ai-context/docs/<module>.md`, and adds a 1-sentence index entry in [`.ai-context/catalog-index.txt`](../catalog-index.txt).
3. **Librarian Consolidation:** After a Pull Request is merged into `main`, the Documentation-Agent (Librarian) automatically deduplicates and organizes [`.ai-context/catalog-index.txt`](../catalog-index.txt).
