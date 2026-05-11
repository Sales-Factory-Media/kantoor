import type { Config } from 'drizzle-kit';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://pixelagents:pixelagents@localhost:5438/pixelagents';

export default {
	schema: './src/db/schema.ts',
	out: './src/db/migrations',
	dialect: 'postgresql',
	dbCredentials: {
		url: DATABASE_URL,
	},
} satisfies Config;
