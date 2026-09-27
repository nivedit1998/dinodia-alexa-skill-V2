import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, renameSync, statSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist');
const outputPath = path.resolve(repoRoot, process.argv[2] || 'dinodia-smart-living-stage2.zip');
if (outputPath === distRoot || outputPath.startsWith(`${distRoot}${path.sep}`)) {
  throw new Error('Lambda ZIP output must be outside dist');
}

function walk(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en')).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(absolute, relative);
    if (!entry.isFile() || !entry.name.endsWith('.js')) throw new Error(`Unexpected Lambda package entry: ${relative}`);
    return [{ relative, absolute }];
  });
}

const files = walk(distRoot);
if (files.length !== 2 || files.map((file) => file.relative).sort().join(',') !== 'dinodiaV1.js,index.js') {
  throw new Error('Expected only the compiled canonical adapter and Lambda entrypoint');
}

const fixedTime = new Date('1980-01-01T00:00:00.000Z');
for (const file of files) utimesSync(file.absolute, fixedTime, fixedTime);
const temporaryPath = `${outputPath}.tmp-${process.pid}`;
try {
  execFileSync('zip', ['-X', '-q', '-9', temporaryPath, ...files.map((file) => file.relative)], {
    cwd: distRoot,
    env: { ...process.env, TZ: 'UTC' },
    stdio: 'pipe',
  });
  if (!statSync(temporaryPath).isFile()) throw new Error('ZIP tool did not produce a regular file');
  renameSync(temporaryPath, outputPath);
} catch (error) {
  throw new Error(`Could not create deterministic Stage 2 Lambda package: ${error instanceof Error ? error.message : 'zip failed'}`);
}

const digest = createHash('sha256').update(await import('node:fs/promises').then(({ readFile }) => readFile(outputPath))).digest('hex');
console.log(JSON.stringify({ output: outputPath, sha256: digest, files: files.map((file) => file.relative) }));
