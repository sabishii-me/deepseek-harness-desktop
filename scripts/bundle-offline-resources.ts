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
    tag: 'v0.1.1',
    asset: 'sabishii-me-dsh-model-provider-shisa-0.1.1.tgz',
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

// 内核包按它自己 `package.json` 的 `files` 拷入，再加上清单本身。
//
// 不手写白名单：漏一个条目就会打出一个「装得上、启动即失败」的包——曾经漏掉
// `cordis.patch.yml`，dsh 校验插件时读不到 overlay，整个预装阶段直接拒绝安装。
// `files` 是包自己声明的发布内容，与之保持一致才是唯一不会漂移的做法。
// 运行期依赖由 `dsh.runtimeDependencies` 声明，随清单原样复制，构建期不改写
// 任何字段——开发构建读的是源码清单（`bundled_plugin_dir` 的开发覆盖）。
{
  const kernelSource = join(repo, 'packages/dsh-tauri-kernel')
  const kernelTarget = join(modules, 'dsh-tauri-kernel')
  const manifestPath = join(kernelSource, 'package.json')
  if (!existsSync(manifestPath))
    throw new Error(`dsh-tauri-kernel package.json missing: ${manifestPath}`)
  const kernelManifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const published = Array.isArray(kernelManifest.files) ? kernelManifest.files : []
  if (published.length === 0)
    throw new Error('dsh-tauri-kernel declares no `files`; refusing to guess its contents')
  rmSync(kernelTarget, { recursive: true, force: true })
  mkdirSync(kernelTarget, { recursive: true })
  for (const entry of [...published, 'package.json']) {
    const from = join(kernelSource, entry)
    if (!existsSync(from))
      throw new Error(`dsh-tauri-kernel declares ${entry} but it does not exist: ${from}`)
    cpSync(from, join(kernelTarget, entry), { recursive: true })
  }
  // 清单声明的 overlay 必须真的在包里，否则 dsh 安装阶段会拒绝这个插件。
  const overlay = kernelManifest.dsh?.bundle?.patch
  if (typeof overlay === 'string' && !existsSync(join(kernelTarget, overlay)))
    throw new Error(`dsh-tauri-kernel overlay ${overlay} missing from the bundled package`)
}
function digest(dir: string): string {
 const hash = createHash('sha256')
 function walk(p: string) { for (const name of readdirSync(p).sort()) { const f=join(p,name); if(statSync(f).isDirectory())walk(f);else{hash.update(f.slice(dir.length));hash.update(readFileSync(f))} } }
 walk(dir);return hash.digest('hex')
}
writeFileSync(join(resources, 'offline-manifest.json'), JSON.stringify({ dshCore: { version: '0.2.1-alpha.2', delivery: 'managed-download', bundled: false }, pluginsDigest: digest(modules) }, null, 2))
if (existsSync(join(modules, 'jouzu'))) throw new Error('Jouzu CLI must not be bundled')
console.log('Plugin-only resources assembled; DSH runtime uses managed download.')
