import { readdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// TypeScript Bundler resolution accepts extensionless source imports. Published
// ESM must resolve in Node too, without requiring the consumer to use tsx.
const dist = new URL('../dist/', import.meta.url)
for (const name of await readdir(dist)) {
  if (!name.endsWith('.js') && !name.endsWith('.d.ts')) continue
  const file = new URL(name, dist)
  const source = await readFile(file, 'utf8')
  const fixed = source.replace(
    /(from\s+['"])(\.\.?\/[^'"]+)(['"])/g,
    (match, prefix, path, suffix) =>
      /\.[cm]?js$/.test(path) ? match : `${prefix}${path}.js${suffix}`,
  )
  await writeFile(fileURLToPath(file), fixed)
}
