import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? `${result.stdout}\n${result.stderr}`}`);
  return result.stdout;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function download(site, name, destination, allowMissing = false) {
  const response = await fetch(`${site}/${name}`);
  if (allowMissing && response.status === 404) return false;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${name}`);
  mkdirSync(resolve(destination, '..'), { recursive: true });
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
  return true;
}

async function main() {
  if (process.argv.length !== 6) throw new Error('Usage: prepare.mjs <Norm-tooling-directory> <site-url> <output-directory> <tooling-commit>');
  const tooling = resolve(process.argv[2]);
  const site = process.argv[3].replace(/\/$/, '');
  const output = resolve(process.argv[4]);
  const toolingCommit = process.argv[5];
  const bootstrap = process.env.RPM_BOOTSTRAP === 'true';
  const renew = process.env.RPM_RENEW_SIGNING_KEY === 'true';
  if (site !== 'https://normlanguage.github.io/rpm' || !/^[a-fA-F0-9]{40}$/.test(toolingCommit)) throw new Error('Invalid RPM publication identity');
  const publication = await import(pathToFileURL(join(tooling, 'cli/compiler/scripts/release-publication.mjs')).href);
  const rpmPublication = await import(pathToFileURL(join(tooling, 'cli/compiler/scripts/rpm-publication.mjs')).href);
  const { readRepositoryIndex } = await import(pathToFileURL(join(tooling, 'cli/compiler/scripts/rpm-repository.mjs')).href);
  const configPath = resolve('release.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (config.baseurl !== `${site}/fedora/44/$basearch` || config.keyurl !== `${site}/RPM-GPG-KEY-normlang` || !/^[1-9]\d*$/.test(config.packageVersion) || !/^[1-9]\d*$/.test(config.packageRelease)) throw new Error('Invalid RPM release configuration');
  const publicKey = resolve('RPM-GPG-KEY-normlang');
  const keyListing = run('gpg', ['--show-keys', '--with-colons', publicKey]);
  const primaryKeys = keyListing.split('\n').filter(line => line.startsWith('pub:'));
  const fingerprint = keyListing.split('\n').find(line => line.startsWith('fpr:'))?.split(':')[9];
  if (primaryKeys.length !== 1 || fingerprint !== config.fingerprint) throw new Error('Invalid pinned RPM signing key');
  publication.assertSigningKeyLifetime(keyListing);
  const selected = publication.officialReleaseSources(tooling);
  mkdirSync(output, { recursive: true });
  const live = join(output, 'live');
  const repository = join(live, 'fedora', '44', 'x86_64');
  mkdirSync(repository, { recursive: true });
  let published = null;
  let index = null;
  if (await download(site, 'RPM-GPG-KEY-normlang', join(live, 'RPM-GPG-KEY-normlang'), true)) {
    if (bootstrap) throw new Error('RPM site already exists; bootstrap is not allowed');
    const liveListing = run('gpg', ['--show-keys', '--with-colons', join(live, 'RPM-GPG-KEY-normlang')]);
    const liveFingerprint = liveListing.split('\n').find(line => line.startsWith('fpr:'))?.split(':')[9];
    if (liveListing.split('\n').filter(line => line.startsWith('pub:')).length !== 1 || liveFingerprint !== fingerprint) throw new Error('Live RPM signing fingerprint differs from pinned key');
    for (const name of ['repodata/repomd.xml', 'repodata/repomd.xml.asc']) await download(site, `fedora/44/x86_64/${name}`, join(repository, name));
    run('gpg', ['--dearmor', '--output', join(live, 'keyring.gpg'), join(live, 'RPM-GPG-KEY-normlang')]);
    run('gpgv', ['--keyring', join(live, 'keyring.gpg'), join(repository, 'repodata', 'repomd.xml.asc'), join(repository, 'repodata', 'repomd.xml')]);
    const metadata = JSON.parse(run('python3', ['-c', `import json, pathlib, sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
ns = '{http://linux.duke.edu/metadata/repo}'
paths = [item.find(ns + 'location').attrib['href'] for item in root.findall(ns + 'data')]
if not paths or any(not path.startswith('repodata/') or pathlib.PurePosixPath(path).parts != ('repodata', pathlib.PurePosixPath(path).name) for path in paths):
    raise SystemExit('Invalid signed RPM metadata location')
print(json.dumps(paths))`, join(repository, 'repodata', 'repomd.xml')]));
    for (const name of metadata) await download(site, `fedora/44/x86_64/${name}`, join(repository, name));
    index = readRepositoryIndex(repository, join(live, 'RPM-GPG-KEY-normlang'), fingerprint);
    for (const name of ['publication.json', 'publication.json.asc']) await download(site, name, join(live, name));
    run('gpgv', ['--keyring', join(live, 'keyring.gpg'), join(live, 'publication.json.asc'), join(live, 'publication.json')]);
    published = JSON.parse(readFileSync(join(live, 'publication.json'), 'utf8'));
    if (published.schemaVersion !== 1 || !Array.isArray(published.packages) || published.packages.length !== 2 || !published.releasePackage) throw new Error('Invalid RPM publication record');
    const indexed = new Map(index.packages.map(value => [value.path, value.sha256]));
    for (const value of published.packages) {
      if (indexed.get(`pool/normlang-${value.version}-1.x86_64.rpm`) !== value.sha256) throw new Error(`Published RPM application identity mismatch: ${value.version}`);
    }
    if (indexed.get(`pool/${published.releasePackage.name}`) !== published.releasePackage.sha256 || indexed.size !== 3) throw new Error('Published RPM release identity mismatch');
    if (!readFileSync(join(live, 'RPM-GPG-KEY-normlang')).equals(readFileSync(publicKey)) && !renew) throw new Error('Live RPM public key changed without explicit renewal');
  } else {
    if (renew) throw new Error('Cannot renew an unpublished RPM repository');
    if (!bootstrap) throw new Error('RPM site missing; initial publication requires explicit bootstrap');
    const deployments = JSON.parse(run('gh', ['api', 'repos/normlanguage/rpm/deployments?environment=github-pages&per_page=1']));
    if (deployments.length) throw new Error('Published RPM site is missing; refusing bootstrap reset');
  }
  const plan = rpmPublication.planRpmPublication(selected, published, readFileSync(configPath), readFileSync(publicKey), renew);
  writeFileSync(join(output, 'plan.json'), JSON.stringify({ schemaVersion: 1, toolingCommit, selected, ...plan }, null, 2) + '\n');
  if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `changed=${plan.changed}\n`, { flag: 'a' });
  if (!plan.changed) return;
  if (published) {
    for (const value of index.packages) {
      const destination = join(repository, value.path);
      await download(site, `fedora/44/x86_64/${value.path}`, destination);
      if (sha256(destination) !== value.sha256) throw new Error(`Live signed RPM changed: ${value.path}`);
    }
  }
  for (const version of plan.build) publication.downloadAttestedReleaseAsset(selected.find(value => value.version === version), join(output, 'assets', version));
}

await main();
