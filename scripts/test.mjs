import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
mkdirSync('dist/tests', { recursive: true });
await build({ entryPoints: ['tests/playlist-edit.test.ts'], outfile: 'dist/tests/playlist-edit.test.cjs', bundle: true, platform: 'node', target: 'node18', format: 'cjs', logLevel: 'warning' });
const result = spawnSync(process.execPath, ['--test', 'dist/tests/playlist-edit.test.cjs'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
