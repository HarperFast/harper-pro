// Diagnostic-only implementation of the owner's latest fallback, installed in this child process.
// No source, dist file, native binding, sender, or receiver is modified on disk.
const fs = require('node:fs');
const Module = require('node:module');
const assert = require('node:assert');
const original = Module._extensions['.js'];
Module._extensions['.js'] = function (module, filename) {
	if (!filename.endsWith('/resources/Table.js')) return original(module, filename);
	let source = fs.readFileSync(filename, 'utf8');
	function replace(before, after) {
		assert.equal(source.split(before).length, 2, 'one matched diagnostic patch: ' + before);
		source = source.replace(before, after);
	}
	replace(
		'if (residencyPolicy?.byAttribute &&\n                        writtenHere &&\n                        !fullUpdate &&\n                        !priorStagedOp?.completeResidencyRecord &&',
		`const retainedStubRetry = residencyPolicy?.byAttribute && !fullUpdate &&
  isRetainedResidencyWrite(write, transaction, localShardingWrite) &&
  !priorStagedOp?.completeResidencyRecord && Boolean((priorStaged ?? existingEntry)?.metadataFlags & exports.INVALIDATED);
 if (retainedStubRetry) {
  if (typeof transaction.usesAbortMarkers === 'function' && transaction.usesAbortMarkers() === true)
   retryResidencySlot(write, undefined, transaction, localShardingWrite, 'retry base became a stub');
 } else if (residencyPolicy?.byAttribute &&
                        writtenHere &&
                        !fullUpdate &&
                        !priorStagedOp?.completeResidencyRecord &&`
	);
	replace(
		'? retryResidencySlot(write, options?.residencySlot ?? baseEntry.residencySlot, transaction, localShardingWrite)',
		'? retainedStubRetry ? baseEntry.residencySlot : retryResidencySlot(write, options?.residencySlot ?? baseEntry.residencySlot, transaction, localShardingWrite)'
	);
	replace(
		'if (write.residencyBaseSlot === write.residencyOwnerSlot && baseEntry?.residencySlot !== slot)',
		'if (!retainedStubRetry && write.residencyBaseSlot === write.residencyOwnerSlot && baseEntry?.residencySlot !== slot)'
	);
	module._compile(source, filename);
};
