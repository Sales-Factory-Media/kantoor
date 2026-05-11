import { migrateLegacyJsonIntoDb } from '../src/db/migrateFromJson.js';
import { closeDb } from '../src/db/client.js';

migrateLegacyJsonIntoDb()
	.then(async (r) => {
		console.log('Result:', r);
		await closeDb();
		process.exit(0);
	})
	.catch(async (err) => {
		console.error(err);
		await closeDb();
		process.exit(1);
	});
