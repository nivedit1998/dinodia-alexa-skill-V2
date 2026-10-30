#!/usr/bin/env node
/**
 * Reproducible, reversible deployment of the Dinodia Alexa Lambda.
 *
 *   node scripts/deploy-lambda.mjs deploy   [--dry-run]   test, build, package, upload, publish a numbered version, point alias `live` at it
 *   node scripts/deploy-lambda.mjs rollback --to <version> point alias `live` back at an earlier published version
 *   node scripts/deploy-lambda.mjs status                  show the alias, versions and code hashes
 *
 * Options: --region (default eu-west-1) --function (default dinodia-alexa-skill) --alias (default live) --skill-id <amzn1.ask.skill...>
 * No credential is read or printed here; the AWS CLI's existing signed-in profile is used. Environment variables of the function
 * are never modified (it already uses the single Platform origin DINODIA_API_BASE_URL).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [command, ...rest] = process.argv.slice(2);
const options = new Map();
const flags = new Set();
for (let index = 0; index < rest.length; index += 1) {
  if (!rest[index].startsWith('--')) throw new Error(`Unexpected argument ${rest[index]}`);
  const key = rest[index].slice(2);
  if (key === 'dry-run') flags.add(key);
  else { options.set(key, rest[index + 1]); index += 1; }
}
const region = options.get('region') ?? 'eu-west-1';
const functionName = options.get('function') ?? 'dinodia-alexa-skill';
const alias = options.get('alias') ?? 'live';
const skillId = options.get('skill-id') ?? 'amzn1.ask.skill.7b3acced-734d-4a04-b5c9-83370ce1f25a';
const dryRun = flags.has('dry-run');

function aws(args, { json = true } = {}) {
  const output = execFileSync('aws', [...args, '--region', region, ...(json ? ['--output', 'json'] : [])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return json && output.trim() ? JSON.parse(output) : output;
}
function awsOptional(args) { try { return aws(args); } catch { return null; } }
function step(message, details = {}) { console.log(JSON.stringify({ step: message, ...details })); }

function summary() {
  const config = aws(['lambda', 'get-function-configuration', '--function-name', functionName]);
  const aliasInfo = awsOptional(['lambda', 'get-alias', '--function-name', functionName, '--name', alias]);
  return { latestSha256: config.CodeSha256, state: config.State, lastUpdateStatus: config.LastUpdateStatus, aliasVersion: aliasInfo?.FunctionVersion ?? null };
}

function waitForUpdate() {
  aws(['lambda', 'wait', 'function-updated-v2', '--function-name', functionName], { json: false });
}

function ensureAliasInvokePermission() {
  const policy = awsOptional(['lambda', 'get-policy', '--function-name', functionName, '--qualifier', alias]);
  const statements = policy ? JSON.parse(policy.Policy).Statement : [];
  for (const principal of ['alexa-appkit.amazon.com', 'alexa-connectedhome.amazon.com']) {
    const present = statements.some((statement) => statement.Principal?.Service === principal && statement.Condition?.StringEquals?.['lambda:EventSourceToken'] === skillId);
    if (present) continue;
    step('add-alias-permission', { principal, alias });
    if (!dryRun) {
      aws(['lambda', 'add-permission', '--function-name', functionName, '--qualifier', alias, '--statement-id', `alexa-${principal.split('.')[0]}-${alias}-${createHash('sha256').update(skillId).digest('hex').slice(0, 8)}`,
        '--action', 'lambda:InvokeFunction', '--principal', principal, '--event-source-token', skillId]);
    }
  }
}

function deploy() {
  const before = summary();
  step('before', before);
  step('test');
  execFileSync('npm', ['test'], { cwd: repoRoot, stdio: 'inherit' });
  const scratch = mkdtempSync(path.join(tmpdir(), 'dinodia-lambda-'));
  const zip = path.join(scratch, 'dinodia-alexa.zip');
  try {
    execFileSync('npm', ['run', 'prepare-zip', '--silent'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('node', ['scripts/package-lambda-zip.mjs', zip], { cwd: repoRoot, stdio: 'ignore' });
    const sha256 = createHash('sha256').update(readFileSync(zip)).digest('hex');
    step('package', { zip, sha256 });
    if (dryRun) { step('dry-run-complete', { wouldUpdate: functionName, alias }); return; }
    aws(['lambda', 'update-function-code', '--function-name', functionName, '--zip-file', `fileb://${zip}`]);
    waitForUpdate();
    const published = aws(['lambda', 'publish-version', '--function-name', functionName, '--description', `deploy ${new Date().toISOString()} ${sha256.slice(0, 12)}`]);
    waitForUpdate();
    const existing = awsOptional(['lambda', 'get-alias', '--function-name', functionName, '--name', alias]);
    if (existing) aws(['lambda', 'update-alias', '--function-name', functionName, '--name', alias, '--function-version', published.Version]);
    else aws(['lambda', 'create-alias', '--function-name', functionName, '--name', alias, '--function-version', published.Version]);
    ensureAliasInvokePermission();
    step('deployed', { version: published.Version, codeSha256: published.CodeSha256, alias, previousAliasVersion: before.aliasVersion, rollback: `node scripts/deploy-lambda.mjs rollback --to ${before.aliasVersion ?? '<previous version>'}` });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

function rollback() {
  const target = options.get('to');
  if (!target || !/^\d+$/.test(target)) throw new Error('rollback needs --to <published version number>');
  const before = summary();
  step('before', before);
  if (dryRun) { step('dry-run-complete', { wouldPointAliasTo: target }); return; }
  aws(['lambda', 'update-alias', '--function-name', functionName, '--name', alias, '--function-version', target]);
  step('rolled-back', { alias, version: target });
}

function status() {
  const versions = aws(['lambda', 'list-versions-by-function', '--function-name', functionName]).Versions.map((version) => ({ version: version.Version, lastModified: version.LastModified, codeSha256: version.CodeSha256 }));
  step('status', { ...summary(), versions: versions.slice(-8) });
}

if (command === 'deploy') deploy();
else if (command === 'rollback') rollback();
else if (command === 'status') status();
else { console.error('Usage: deploy-lambda.mjs deploy|rollback|status [--dry-run] [--region R] [--function F] [--alias A] [--skill-id S] [--to N]'); process.exit(2); }
