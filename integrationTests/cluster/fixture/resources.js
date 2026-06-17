import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
export class LocationImage extends tables.Location {
	static async get(target) {
		let location = await super.get(target);
		console.error('LocationImage.get', location);
		return new Response(location.image, { headers: { 'Content-Type': 'image/jpeg' } });
	}
}

tables.Location.sourcedFrom({
	get(id) {
		let image = createBlob(
			Readable.from(
				(function* () {
					for (let i = 0; i < 150; i++) {
						yield randomBytes(50);
					}
				})()
			)
		);
		return {
			id,
			name: 'location name ' + id,
			random: Math.random(),
			image,
		};
	},
});
