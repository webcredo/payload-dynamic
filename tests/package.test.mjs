import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const subpaths = ['.', './react', './react/CollectionsNavigation']

test('npm pack includes all declared entry points and only distribution files and metadata', () => {
  const [pack] = JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root,
      encoding: 'utf8',
    }),
  )
  const files = new Set(pack.files.map(({ path }) => path))
  assert.deepEqual(Object.keys(manifest.exports).sort(), [...subpaths].sort())
  for (const subpath of subpaths) {
    for (const condition of ['import', 'types']) {
      const target = manifest.exports[subpath][condition]
      assert.equal(typeof target, 'string', `${subpath}: missing ${condition}`)
      assert.ok(target.startsWith('./dist/'), `${subpath}: ${target} must be built`)
      assert.ok(files.has(target.slice(2)), `${subpath}: ${target} missing from npm pack`)
    }
  }
  assert.ok(files.has('package.json'))
  assert.ok(files.has('README.md'))
  for (const file of files) {
    assert.ok(
      file.startsWith('dist/') || ['package.json', 'README.md', 'LICENSE'].includes(file),
      `Unexpected file in npm pack: ${file}`,
    )
  }
})

test('built public exports load in plain Node ESM', async () => {
  for (const subpath of subpaths) {
    const specifier = manifest.name + (subpath === '.' ? '' : subpath.slice(1))
    const entry = await import(specifier)
    assert.ok(Object.keys(entry).length > 0, `${specifier} has no public exports`)
  }
})

test('disabled plugin returns the exact config without validating reserved slugs', async () => {
  const { payloadDynamic } = await import(manifest.name)
  const config = { collections: [{ slug: 'entries', fields: [] }] }
  assert.equal(payloadDynamic({ enabled: false, canManage: () => false })(config), config)
})

test('enabled plugin rejects duplicate, conflicting, invalid, and reserved slugs', async () => {
  const { payloadDynamic } = await import(manifest.name)
  const config = {
    collections: [{ slug: 'host-pages', fields: [] }],
    globals: [{ slug: 'siteSettings', fields: [] }],
  }
  const canManage = () => true

  assert.throws(
    () => payloadDynamic({ canManage, collections: { slug: 'entries' } })(config),
    /requires distinct slugs/,
  )
  assert.throws(
    () => payloadDynamic({ canManage, entries: { slug: 'host-pages' } })(config),
    /conflicts with the Payload slug "host-pages"/,
  )
  assert.throws(
    () => payloadDynamic({ canManage, entries: { slug: 'invalid/path' } })(config),
    /Invalid .* slug/,
  )
  for (const [slug, message] of [
    ['Collections', /conflicts with the Payload slug "collections"/],
    ['host_pages', /conflicts with the Payload slug "host-pages"/],
    ['site-settings', /conflicts with the Payload slug "siteSettings"/],
    ['globals-content', /reserved by Payload/],
    ['payload_jobs_stats', /reserved by Payload/],
    ['payload_preferences', /reserved by Payload/],
  ]) {
    assert.throws(() => payloadDynamic({ canManage, entries: { slug } })(config), message)
  }
})

test('workspace mode requires an existing host collection', async () => {
  const { payloadDynamic } = await import(manifest.name)
  const plugin = payloadDynamic({
    canManage: () => true,
    workspace: { collection: 'teams', allowedIDs: () => [] },
  })
  assert.throws(
    () => plugin({ collections: [] }),
    /workspace must be an existing Payload collection/,
  )
})
