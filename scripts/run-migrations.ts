import { runMigrations } from '../src/db/migrate.js';

runMigrations()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});
