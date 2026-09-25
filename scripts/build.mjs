import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? `${result.stdout}\n${result.stderr}`}`);
  return result.stdout;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

if (process.argv.length !== 7) throw new Error('Usage: build.mjs <Norm-tooling-directory> <input-directory> <output-directory> <fingerprint> <public-key>');
const tooling = resolve(process.argv[2]);
const input = resolve(process.argv[3]);
const output = resolve(process.argv[4]);
const fingerprint = process.argv[5];
const publicKey = resolve(process.argv[6]);
const plan = JSON.parse(readFileSync(join(input, 'plan.json'), 'utf8'));
if (plan.schemaVersion !== 1 || !plan.changed || plan.selected.length !== 2 || !/^[A-F0-9]{40}$/.test(fingerprint)) throw new Error('Invalid RPM publication plan');
if (createHash('sha256').update(readFileSync('release.json')).update(readFileSync(publicKey)).digest('hex') !== plan.releaseContentSha256) throw new Error('RPM release configuration changed after planning');
const toolingModule = await import(pathToFileURL(join(tooling, 'cli/compiler/scripts/rpm-repository.mjs')).href);
const secretListing = run('gpg', ['--with-colons', '--list-secret-keys', fingerprint]);
if (secretListing.split('\n').find(line => line.startsWith('fpr:'))?.split(':')[9] !== fingerprint || !secretListing.split('\n').some(line => line.startsWith('ssb:') && line.split(':')[11]?.toLowerCase().includes('s'))) throw new Error('RPM signing subkey identity mismatch');
if (run('gpg', ['--batch', '--armor', '--export', fingerprint]).trim() !== readFileSync(publicKey, 'utf8').trim()) throw new Error('RPM signing key differs from pinned public key');
const packages = join(output, 'packages');
mkdirSync(packages, { recursive: true });
const publishedPath = join(input, 'live', 'publication.json');
const published = existsSync(publishedPath) ? JSON.parse(readFileSync(publishedPath, 'utf8')) : null;
const records = [];
for (const value of plan.selected) {
  const name = `normlang-${value.version}-1.x86_64.rpm`;
  let destination;
  if (plan.build.includes(value.version)) {
    const unsigned = toolingModule.buildPackage(value.version, join(input, 'assets', value.version), join(output, 'unsigned'));
    destination = toolingModule.signPackage(unsigned, publicKey, fingerprint, packages);
    run('python3', ['scripts/verify_payload.py', join(input, 'assets', value.version, value.assetName), destination, join(output, 'evidence', `payload-${value.version}.json`)]);
  } else if (plan.reuse.includes(value.version)) {
    destination = join(packages, name);
    copyFileSync(join(input, 'live', 'fedora', '44', 'x86_64', 'pool', name), destination);
  } else throw new Error(`Unplanned RPM application version: ${value.version}`);
  if (run('rpm', ['-qp', '--qf', '%{VERSION}', destination]) !== value.version) throw new Error(`RPM application version mismatch: ${value.version}`);
  const prior = published?.packages.find(item => item.version === value.version);
  const digest = sha256(destination);
  if (prior && prior.sha256 !== digest) throw new Error(`Published RPM application changed: ${value.version}`);
  records.push({ version: value.version, sourceCommit: value.sourceCommit, assetSha256: value.assetSha256, sha256: digest, toolingCommit: prior?.toolingCommit ?? plan.toolingCommit });
}
const config = JSON.parse(readFileSync('release.json', 'utf8'));
let releasePath;
if (plan.releaseChanged) {
  const unsigned = toolingModule.buildReleasePackage('release.json', publicKey, join(output, 'unsigned'));
  releasePath = toolingModule.signPackage(unsigned, publicKey, fingerprint, packages);
} else {
  const name = published.releasePackage.name;
  releasePath = join(packages, name);
  copyFileSync(join(input, 'live', 'fedora', '44', 'x86_64', 'pool', name), releasePath);
}
const releaseName = `normlang-release-${config.packageVersion}-${config.packageRelease}.noarch.rpm`;
if (releasePath !== join(packages, releaseName)) throw new Error('RPM release package identity mismatch');
const priorRelease = plan.releaseChanged ? null : published.releasePackage;
const releaseHash = sha256(releasePath);
if (priorRelease && priorRelease.sha256 !== releaseHash) throw new Error('Published RPM release package changed');
const oldRelease = plan.releaseChanged && published ? join(input, 'live', 'fedora', '44', 'x86_64', 'pool', published.releasePackage.name) : releasePath;
const current = join(packages, `normlang-${plan.selected[0].version}-1.x86_64.rpm`);
const older = join(packages, `normlang-${plan.selected[1].version}-1.x86_64.rpm`);
const site = join(output, 'site');
const oldSite = join(output, 'site-old');
for (const root of [site, oldSite]) {
  mkdirSync(join(root, 'fedora', '44'), { recursive: true });
  copyFileSync(publicKey, join(root, 'RPM-GPG-KEY-normlang'));
}
toolingModule.buildRepository([older, oldRelease], publicKey, fingerprint, join(oldSite, 'fedora', '44', 'x86_64'));
toolingModule.buildRepository([current, older, releasePath], publicKey, fingerprint, join(site, 'fedora', '44', 'x86_64'), published ? join(input, 'live', 'fedora', '44', 'x86_64') : undefined);
copyFileSync(oldRelease, join(oldSite, 'normlang-release-latest.noarch.rpm'));
copyFileSync(releasePath, join(site, 'normlang-release-latest.noarch.rpm'));
const record = join(site, 'publication.json');
writeFileSync(record, JSON.stringify({ schemaVersion: 1, toolingCommit: plan.toolingCommit, packages: records, releasePackage: { name: releaseName, version: config.packageVersion, release: config.packageRelease, identity: plan.releaseIdentity, releaseContentSha256: plan.releaseContentSha256, sha256: releaseHash, toolingCommit: priorRelease?.toolingCommit ?? plan.toolingCommit } }, null, 2) + '\n');
run('gpg', ['--batch', '--armor', '--detach-sign', '--local-user', fingerprint, '--output', `${record}.asc`, record]);
console.log(JSON.stringify({ applications: records, releasePackage: { name: releaseName, sha256: releaseHash } }));
