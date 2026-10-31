const { execFile } = require('child_process');
const {
    REPO_ROOT,
    validateAndSplitCommand,
    getSanitizedEnv,
    redactSecrets
} = require('../lib/security-guard');

module.exports = [
    {
        name: 'execute_terminal_command',
        instruction: '- {"action": "execute_terminal_command", "cmd": "npm test"}',
        execute: async (toolCall) => {
            return new Promise((resolve) => {
                try {
                    const { binary, args } = validateAndSplitCommand(toolCall.cmd);
                    const isWindows = process.platform === 'win32';
                    const execBin =
                        isWindows && ['npm', 'npx', 'flutter', 'mvn', 'gradle'].includes(binary)
                            ? `${binary}.cmd`
                            : binary;

                    execFile(
                        execBin,
                        args,
                        {
                            cwd: REPO_ROOT,
                            env: getSanitizedEnv(),
                            timeout: 30000,
                            maxBuffer: 1024 * 1024,
                            shell: false
                        },
                        (error, stdout, stderr) => {
                            if (error) {
                                resolve(
                                    redactSecrets(
                                        `Error: ${error.message}\nStdout: ${stdout || ''}\nStderr: ${stderr || ''}`
                                    )
                                );
                            } else {
                                resolve(redactSecrets(`Success:\n${stdout || ''}`));
                            }
                        }
                    );
                } catch (validationError) {
                    resolve(`Error: ${validationError.message}`);
                }
            });
        }
    }
];
