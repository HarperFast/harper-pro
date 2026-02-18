import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
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
				(async function* () {
					for (let i = 0; i < 150; i++) {
						yield randomBytes(50);
						await delay(i % 10); // vary it to keep things exciting
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
