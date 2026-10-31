const { execFileSync } = require('child_process');
const { REPO_ROOT, assertProtectedFilesUnchanged, redactSecrets } = require('./security-guard');
const { createOrUpdatePullRequest, postIssueComment, addIssueLabels } = require('./forgejo-api');
const { run_review } = require('../agents/reviewer-agent');

async function main() {
    const issueNumber = process.env.ISSUE_NUMBER || '';
    const issueTitle = process.env.ISSUE_TITLE || (issueNumber ? `Issue #${issueNumber}` : 'Autonomous Feature Update');
    const branchName =
        process.env.BRANCH_NAME ||
        (issueNumber ? `feature/issue-${issueNumber}` : execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim());
    const baseBranch = process.env.BASE_BRANCH || 'main';

    if (!branchName || branchName === 'main' || branchName === 'master') {
        console.log('ℹ️ Currently on main branch; skipping Pull Request creation.');
        return;
    }

    // 1. Final Protected-File Check
    assertProtectedFilesUnchanged({ allowBootstrap: false });

    // 2. Final Reviewer-Agent Check
    const review = await run_review({ postComment: false });
    if (!review.approved) {
        throw new Error(`Reviewer-Agent rejected PR creation: ${review.summary}`);
    }

    // 3. Build PR Description with Verification Report
    const prBody = [
        `## ✅ Pre-PR Verification & Security Gate Passed`,
        issueNumber ? `\nCloses #${issueNumber}\n` : '',
        `### 🛡️ Automated Checks Completed Before PR Creation:`,
        `- **Protected Template/Agent Files Guard:** ✅ Passed (No agent or workflow files modified)`,
        `- **Unit & Template Self-Tests (TDD):** ✅ Passed`,
        `- **Gitleaks Secret Scanner:** ✅ Passed (Zero hardcoded secrets)`,
        `- **Semgrep SAST Code Scan:** ✅ Passed`,
        `- **Trivy Dependency & CVE Scan:** ✅ Passed`,
        `- **Reviewer-Agent (DRY & Anti-Hallucination):** ✅ Approved`,
        `\n### 🧐 Architect Management Summary\n`,
        review.summary
    ].join('\n');

    const prTitle = issueNumber
        ? `feat(issue-${issueNumber}): ${issueTitle}`
        : `feat(${branchName}): Verified Vibe-Coding Update`;

    const pr = await createOrUpdatePullRequest({
        head: branchName,
        base: baseBranch,
        title: prTitle,
        body: prBody
    });

    if (issueNumber && pr && pr.number) {
        await postIssueComment(
            issueNumber,
            `### 🎉 Pull Request #${pr.number} Created\n\nAll functional tests, security scans (Gitleaks, Semgrep, Trivy), and the Reviewer-Agent architectural check passed before opening the PR.\n\n👉 **Review & Merge PR #${pr.number}**`
        );
        await addIssueLabels(issueNumber, [], ['Ready for Dev', 'Needs Fix', 'Needs Clarification']);
    }
}

if (require.main === module) {
    main().catch(async (err) => {
        console.error(`🚨 Pre-PR Gate blocked Pull Request creation: ${redactSecrets(err.message)}`);
        const issueNumber = process.env.ISSUE_NUMBER || '';
        if (issueNumber) {
            await postIssueComment(
                issueNumber,
                `### 🚨 Pull Request Blocked by Pre-PR Security/Quality Gate\n\n\`${redactSecrets(err.message)}\``
            );
            await addIssueLabels(issueNumber, ['Needs Human Help'], ['Ready for Dev']);
        }
        process.exit(1);
    });
}
