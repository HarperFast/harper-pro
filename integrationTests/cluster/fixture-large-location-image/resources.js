// Test-only component: serves a LargeLocation record's referenced blob bytes, so copyGapCursorBanking can
// check each record against its deterministic payload.
export class LargeLocationImage extends Resource {
	async get(target) {
		target.checkPermission = false;
		const record = await databases.data.LargeLocation.get(Number(target.id));
		if (!record?.image) return new Response(null, { status: 404 });
		return new Response(record.image, { headers: { 'Content-Type': 'application/octet-stream' } });
	}
}
