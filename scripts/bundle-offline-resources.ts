import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pruneDeployment } from './build-plugins'
import { buildHostPlugin } from './build-host-plugin'

const repo = resolve(import.meta.dirname, '..')
const resources = join(repo, 'src-tauri/resources')
const modules = join(resources, 'node_modules')
const source = resolve(repo, '../../../packages/experimental')
const names = Object.keys(JSON.parse(readFileSync(join(repo, 'packages/dsh-tauri-bundle/package.json'), 'utf8')).dependencies)
// Rehydrate the build-tool package before applying the upstream deployment pruner.
cpSync(join(repo, 'node_modules/dsh-h3'), join(modules, 'dsh-h3'), { recursive: true, dereference: true })
pruneDeployment(modules, names)
// Generated core resources from the retired offline design, never user data.
rmSync(join(resources, 'dsh'), { recursive: true, force: true })

// Shisa: single source (sabishii-me/dsh-model-provider-shisa) shipped as a built-in
// so its client code is always present and can contribute its onboarding step. The
// same source is also installable from its GitHub Release when it is NOT built in;
// this only controls how the copy reaches the profile, never where the logic lives.
const shisaSource = process.env.DSH_SHISA_SOURCE
  ? resolve(process.env.DSH_SHISA_SOURCE)
  : resolve(repo, '../dsh-model-provider-shisa')
if (existsSync(join(shisaSource, 'package.json'))) {
  const shisaTarget = join(modules, '@sabishii-me/dsh-model-provider-shisa')
  mkdirSync(shisaTarget, { recursive: true })
  const shisaManifest = JSON.parse(readFileSync(join(shisaSource, 'package.json'), 'utf8'))
  // Ship exactly what the package declares plus nothing build-time-only.
  for (const entry of ['dist', 'src/generated', 'cordis.patch.yml', 'LICENSE', 'README.md']) {
    const from = join(shisaSource, entry)
    if (existsSync(from))
      cpSync(from, join(shisaTarget, entry), { recursive: true })
  }
  writeFileSync(join(shisaTarget, 'package.json'), JSON.stringify(shisaManifest, null, 2))
  console.log('Bundled built-in model provider from single source:', shisaSource)
}
else {
  console.warn('Shisa build source not found; built-in model provider omitted:', shisaSource)
}

// Shisa is a user-selected, independently released plugin; never bundled here.
const bridge = join(modules, '@deepseek-ai/dsh-experimental-jouzu-backend')
mkdirSync(bridge, { recursive: true })
cpSync(join(source, 'jouzu-backend/lib'), join(bridge, 'lib'), { recursive: true })
const bridgeManifest = JSON.parse(readFileSync(join(source, 'jouzu-backend/package.json'), 'utf8'))
const bridgeImports = await buildHostPlugin(join(source, 'jouzu-backend/lib/types/model-bridge.js'), join(bridge, 'lib/model-implementation.js'))
writeFileSync(join(bridge, 'lib/model-bridge.js'), `import { createImplementation } from './model-implementation.js';
export async function openModelBridge(ctx, ...args) {
 const runtime = Object.fromEntries(await Promise.all(${JSON.stringify(bridgeImports)}.map(async id => [id, id.startsWith('node:') ? await import(id) : await ctx.loader.import(id)])));
 return createImplementation(runtime).openModelBridge(ctx, ...args);
}
`)
bridgeManifest.exports['./model-bridge'].default = './lib/model-bridge.js'
delete bridgeManifest.dsh
delete bridgeManifest.devDependencies
delete bridgeManifest.scripts
writeFileSync(join(bridge, 'package.json'), JSON.stringify(bridgeManifest, null, 2))
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
    runtimeDependencies: ['@deepseek-ai/dsh-experimental-jouzu-backend'],
  }
  delete kernelManifest.dependencies['@deepseek-ai/dsh-experimental-jouzu-backend']
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
