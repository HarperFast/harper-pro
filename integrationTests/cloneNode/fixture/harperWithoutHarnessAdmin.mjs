// The integration harness passes --HDB_ADMIN_USERNAME/--HDB_ADMIN_PASSWORD to every node it starts, so a
// token clone it starts never installs `clone-temp-admin`. A production token or certificate clone passes neither.
process.argv = process.argv.filter((arg) => !/^--HDB_ADMIN_(USERNAME|PASSWORD)=/.test(arg));
await import('../../../dist/bin/harper.js');
