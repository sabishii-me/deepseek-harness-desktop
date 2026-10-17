import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { pruneDeployment } from './build-plugins'

const repo = resolve(import.meta.dirname, '..')
const resources = join(repo, 'src-tauri/resources')
const modules = join(resources, 'node_modules')
const names = Object.keys(JSON.parse(readFileSync(join(repo, 'packages/dsh-tauri-bundle/package.json'), 'utf8')).dependencies)
// Rehydrate the build-tool package before applying the upstream deployment pruner.
cpSync(join(repo, 'node_modules/dsh-h3'), join(modules, 'dsh-h3'), { recursive: true, dereference: true })
pruneDeployment(modules, names)
// Generated core resources from the retired offline design, never user data.
rmSync(join(resources, 'dsh'), { recursive: true, force: true })
// Retired packages that used to be bundled here. Removing them keeps a rebuild
// from carrying a second copy beside their standalone replacements.
for (const retired of [
  '@deepseek-ai/dsh-experimental-jouzu-backend',
  '@deepseek-ai/dsh-experimental-jouzu-ui',
  '@deepseek-ai/dsh-experimental-shisa-provider',
  '@deepseek-ai/dsh-experimental-shisa-ui',
])
  rmSync(join(modules, retired), { recursive: true, force: true })

// Packages we publish ourselves are taken from their own release artifacts at
// build time, never from a checked-out working tree. A working tree can carry
// stale or missing build output — a package shipped without `dist` installs fine
// and then fails on first launch with a missing entry — and the release asset is
// exactly what someone installing the package separately would get.
//
// Set DSH_SHISA_SOURCE / DSH_JOUZU_BRIDGE_SOURCE to a directory to iterate
// locally instead; the declared entry must exist either way.
interface OwnPackage {
  repo: string
  tag: string
  asset: string
  target: string
  entry: string
  sourceEnv: string
}

const OWN_PACKAGES: OwnPackage[] = [
  {
    repo: 'sabishii-me/dsh-model-provider-shisa',
    tag: 'v0.1.0',
    asset: 'sabishii-me-dsh-model-provider-shisa-0.1.0.tgz',
    target: '@sabishii-me/dsh-model-provider-shisa',
    entry: 'dist/provider.js',
    sourceEnv: 'DSH_SHISA_SOURCE',
  },
  {
    repo: 'sabishii-me/dsh-jouzu-bridge',
    tag: 'v0.1.0',
    asset: 'sabishii-me-dsh-jouzu-bridge-0.1.0.tgz',
    target: '@sabishii-me/dsh-jouzu-bridge',
    entry: 'dist/index.js',
    sourceEnv: 'DSH_JOUZU_BRIDGE_SOURCE',
  },
]

const cache = join(repo, '.artifacts-cache')

/**
 * Extract a gzipped tar into `dest`.
 *
 * Minimal on purpose: npm pack output is a flat, well-formed archive with regular
 * files and directories. Only those two entry types are honoured; symlinks and
 * device nodes are ignored rather than guessed at.
 */
function extractTgz(archive: string, dest: string): void {
  const buffer = gunzipSync(readFileSync(archive))
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    // Two consecutive zero blocks terminate the archive; a zero name means the end.
    if (header.every(byte => byte === 0))
      break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '')
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim()
    const size = Number.parseInt(sizeField, 8) || 0
    const type = String.fromCharCode(header[156] || 48)
    const body = buffer.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512
    if (name === '')
      continue
    // Refuse traversal: npm pack never emits these, so seeing one means a bad archive.
    const relative = name.replace(/^\.\//, '')
    if (relative.startsWith('/') || relative.split('/').includes('..'))
      throw new Error(`refusing unsafe archive entry: ${name}`)
    const output = join(dest, relative)
    if (type === '5') {
      mkdirSync(output, { recursive: true })
      continue
    }
    if (type !== '0' && type !== '\0')
      continue
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, body)
  }
}

/**
 * Materialize one of our packages into the resource tree.
 *
 * Local directory when its env var is set, otherwise the release tarball. The
 * declared entry is checked afterwards: shipping a package whose entry cannot
 * exist is a build error, not a first-launch surprise.
 */
function bundleOwnPackage(spec: OwnPackage): void {
  const target = join(modules, spec.target)
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })

  const local = process.env[spec.sourceEnv]
  if (local !== undefined && local !== '') {
    const from = resolve(local)
    cpSync(from, target, { recursive: true, dereference: true })
    console.log(`Bundled ${spec.target} from local source: ${from}`)
  }
  else {
    mkdirSync(cache, { recursive: true })
    const archive = join(cache, spec.asset)
    if (!existsSync(archive)) {
      const url = `https://github.com/${spec.repo}/releases/download/${spec.tag}/${spec.asset}`
      // curl rather than a library: the build already shells out elsewhere, and a
      // plain download keeps the fetch auditable.
      execFileSync('curl', ['-sSL', '--fail', '-o', archive, url], { stdio: 'inherit' })
    }
    // npm packs under a single `package/` prefix; strip exactly that level.
    // Extracted in-process: the system `tar` on Windows misreads drive-letter paths
    // and would need POSIX translation, and a tgz reader is a handful of lines.
    const staging = join(cache, `${spec.asset}.d`)
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    extractTgz(archive, staging)
    cpSync(join(staging, 'package'), target, { recursive: true, dereference: true })
    rmSync(staging, { recursive: true, force: true })
    console.log(`Bundled ${spec.target} from ${spec.repo}@${spec.tag}`)
  }

  if (!existsSync(join(target, spec.entry)))
    throw new Error(`${spec.target} is missing its declared entry ${spec.entry}`)
}

for (const spec of OWN_PACKAGES)
  bundleOwnPackage(spec)

cpSync(join(repo, 'packages/dsh-tauri-kernel/dist'), join(modules, 'dsh-tauri-kernel/dist'), { recursive: true })
// The kernel loads the Jouzu model bridge through the profile loader
// (`ctx.loader.import('<pkg>/model-bridge')`), which resolves from the PROFILE's
// node_modules — not from this resource tree. Declare the bundled bridge as a
// real `link:` dependency of the kernel so the profile installer materializes it
// next to the other kernels' dependencies; otherwise the import fails with
// ERR_MODULE_NOT_FOUND and every kernel call answers 500.
{
  const kernelManifestPath = join(modules, 'dsh-tauri-kernel/package.json')
  const kernelManifest = JSON.parse(readFileSync(kernelManifestPath, 'utf8'))
  // Declared through `dsh.runtimeDependencies` (not `dependencies`) on purpose:
  // the kernel is installed as a plain `link:` to this resource tree (no pnpm
  // resolution), so a package-manager spec here would never be materialized.
  // The profile self-heal links each declared runtime dependency into the
  // profile's node_modules, which is where the loader resolves from.
  kernelManifest.dsh = {
    ...kernelManifest.dsh,
    runtimeDependencies: ['@sabishii-me/dsh-jouzu-bridge'],
  }
  delete kernelManifest.dependencies['@sabishii-me/dsh-jouzu-bridge']
  writeFileSync(kernelManifestPath, JSON.stringify(kernelManifest, null, 2))
}
function digest(dir: string): string {
 const hash = createHash('sha256')
 function walk(p: string) { for (const name of readdirSync(p).sort()) { const f=join(p,name); if(statSync(f).isDirectory())walk(f);else{hash.update(f.slice(dir.length));hash.update(readFileSync(f))} } }
 walk(dir);return hash.digest('hex')
}
writeFileSync(join(resources, 'offline-manifest.json'), JSON.stringify({ dshCore: { version: '0.2.1-alpha.2', delivery: 'managed-download', bundled: false }, pluginsDigest: digest(modules) }, null, 2))
if (existsSync(join(modules, 'jouzu'))) throw new Error('Jouzu CLI must not be bundled')
console.log('Plugin-only resources assembled; DSH runtime uses managed download.')
