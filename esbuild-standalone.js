const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes('--production');

/**
 * Copy assets folder to dist/assets (shared with extension build)
 */
function copyAssets() {
	const srcDir = path.join(__dirname, 'webview-ui', 'public', 'assets');
	const dstDir = path.join(__dirname, 'dist', 'assets');

	if (fs.existsSync(srcDir)) {
		if (fs.existsSync(dstDir)) {
			fs.rmSync(dstDir, { recursive: true });
		}
		fs.cpSync(srcDir, dstDir, { recursive: true });
		console.log('✓ Copied assets/ → dist/assets/');
	} else {
		console.log('ℹ️  assets/ folder not found (optional)');
	}
}

/**
 * Copy DB migrations alongside the bundle so runMigrations() can find them
 * via the dist/db/migrations resolver candidate at runtime.
 */
function copyMigrations() {
	const srcDir = path.join(__dirname, 'src', 'db', 'migrations');
	const dstDir = path.join(__dirname, 'dist', 'db', 'migrations');

	if (fs.existsSync(srcDir)) {
		if (fs.existsSync(dstDir)) {
			fs.rmSync(dstDir, { recursive: true });
		}
		fs.cpSync(srcDir, dstDir, { recursive: true });
		console.log('✓ Copied src/db/migrations → dist/db/migrations');
	} else {
		console.log('ℹ️  src/db/migrations not found (optional)');
	}
}

async function main() {
	// Bundle standalone server
	await esbuild.build({
		entryPoints: ['standalone/server.ts'],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/standalone.js',
		external: ['pngjs', 'ws', 'vscode', 'pg', 'pg-native'],
		logLevel: 'info',
	});

	// Copy assets
	copyAssets();
	copyMigrations();

	console.log('✓ Standalone server built → dist/standalone.js');
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
