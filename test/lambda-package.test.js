const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

test('Production Lambda ZIP is reproducible and contains only the two compiled Native V2 modules', () => {
  const root = path.resolve(__dirname, '..');
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dinodia-lambda-package-'));
  try {
    const outputs = ['first.zip', 'second.zip'].map((name) => path.join(outputDirectory, name));
    for (const output of outputs) execFileSync(process.execPath, ['scripts/package-lambda-zip.mjs', output], { cwd: root, stdio: 'pipe' });
    const hashes = outputs.map((output) => createHash('sha256').update(fs.readFileSync(output)).digest('hex'));
    assert.equal(hashes[0], hashes[1]);
    const listing = execFileSync('unzip', ['-Z1', outputs[0]], { encoding: 'utf8' }).trim().split('\n').sort();
    assert.deepEqual(listing, ['dinodiaV1.js', 'index.js']);
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});
