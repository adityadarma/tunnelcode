import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

const root = dirname(import.meta.dirname);
const outDir = join(root, 'bundle');
const outFile = join(outDir, 'index.js');

/**
 * Dependencies that stay external.
 *
 * These are real npm packages the published manifest depends on, so bundling
 * them would only duplicate code the registry already resolves.
 */
const EXTERNAL = ['ws', 'qrcode'];

/**
 * Default server URL baked in at publish time.
 *
 * A published CLI has no repository to read, so the deployment it should talk to
 * has to be decided when the artifact is built. Configuration still wins: this is
 * only the fallback when no config and no environment variable is present.
 */
const DEFAULT_SERVER_URL = process.env['REMOTECODE_DEFAULT_SERVER_URL'] ?? 'http://localhost:3000';

async function readManifest() {
  return JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
}

/**
 * Writes the manifest for the published package.
 *
 * Workspace dependencies are dropped because their code is inlined, and the
 * workspace protocol is meaningless outside this repository: npm cannot resolve
 * "workspace:*" from the registry.
 */
async function writeManifest(manifest) {
  const external = Object.fromEntries(
    Object.entries(manifest.dependencies ?? {}).filter(([name]) => EXTERNAL.includes(name)),
  );

  const published = {
    name: manifest.name,
    version: manifest.version,
    description: 'Run an AI coding agent locally and control it from a browser.',
    license: manifest.license ?? 'MIT',
    type: 'module',
    // npm refuses to attach a provenance statement unless the manifest points at
    // the public repository the build came from, so this is required by publish.
    repository: {
      type: 'git',
      url: 'git+https://github.com/adityadarma/remotecode.git',
    },
    homepage: 'https://github.com/adityadarma/remotecode#readme',
    bugs: { url: 'https://github.com/adityadarma/remotecode/issues' },
    bin: { remotecode: './index.js' },
    files: ['index.js'],
    engines: manifest.engines ?? { node: '>=22' },
    dependencies: external,
  };

  await writeFile(join(outDir, 'package.json'), `${JSON.stringify(published, null, 2)}\n`, 'utf8');
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const manifest = await readManifest();

await build({
  entryPoints: [join(root, 'src', 'index.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: EXTERNAL,
  // No banner: the entry file already carries the shebang, and a second one on
  // line two would be a syntax error rather than a comment.
  define: {
    // Bare identifiers, matching the `declare const` the sources use. Defining
    // process.env.X instead would leave those identifiers unreplaced.
    REMOTECODE_BUNDLED_SERVER_URL: JSON.stringify(DEFAULT_SERVER_URL),
    REMOTECODE_BUNDLED_VERSION: JSON.stringify(manifest.version),
  },
  logLevel: 'info',
});

await writeManifest(manifest);

// npm sets this itself for bin entries, but a tarball built by hand should still
// be runnable straight out of the directory.
await chmod(outFile, 0o755);

const readme = await readFile(join(dirname(root), '..', 'README.md'), 'utf8');
await writeFile(join(outDir, 'README.md'), readme, 'utf8');

process.stdout.write(`Bundled ${manifest.name} ${manifest.version} to ${outDir}\n`);
process.stdout.write(`Default server URL: ${DEFAULT_SERVER_URL}\n`);
