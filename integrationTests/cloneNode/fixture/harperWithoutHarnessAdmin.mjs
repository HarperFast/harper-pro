// The integration harness passes --HDB_ADMIN_USERNAME/--HDB_ADMIN_PASSWORD to every node it starts, and a token
// clone installed with an admin username never creates `clone-temp-admin`.
process.argv = process.argv.filter((arg) => !/^--HDB_ADMIN_(USERNAME|PASSWORD)=/.test(arg));
await import('../../../dist/bin/harper.js');
