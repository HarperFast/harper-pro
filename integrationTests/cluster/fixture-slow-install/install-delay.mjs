// Stands in for a real dependency install that outlasts the receive-watchdog window. Kept as a file
// rather than `node -e ...` because the install command is spawned with `shell: true`, where the
// script's parentheses and braces would be shell metacharacters.
const ms = Number.parseInt(process.env.HARPER_TEST_INSTALL_DELAY_MS || '12000', 10);
setTimeout(() => {}, ms);
