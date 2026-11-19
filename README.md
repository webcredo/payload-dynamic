# payload-dynamic

[![npm beta version](https://img.shields.io/npm/v/payload-dynamic/beta?label=npm%20beta)](https://www.npmjs.com/package/payload-dynamic)

A Payload plugin for defining record types, fields, and relationships in the admin panel. It stores definitions and records in native Payload collections, with typed SQL values, field validation, access control, and reference checks.

## How it works

Add `payloadDynamic(...)` to your Payload config. By default, the plugin registers **Collections** for type definitions and **Entries** for records. You can set the slug and labels of either collection when you configure the plugin.

```mermaid
flowchart TB
    Definitions["Collections<br/>Record types and fields"]
    Entries["Entries<br/>Records and values"]
    App["Application"]
    DB[("SQLite / PostgreSQL")]
    Definitions -->|"Form and validation<br/>via definition"| Entries
    Entries -->|"REST / Local API"| App
    Definitions --> DB
    Entries --> DB
```

For example, create a **Posts** type with a numeric `reading_time` field. The plugin builds the form from the definition in **Collections** and validates the value on save. A post with a reading time of five minutes stores `5` in `values[].numberValue` in **Entries**.

The application queries the entries collection with a `definition` filter for the Posts definition ID. All types share the entries collection, so adding a type in the admin panel requires no schema change.

## Supported versions

- This release targets exactly Payload **4.0.0-beta.9**. Use matching versions of `@payloadcms/ui`, `@payloadcms/drizzle`, and the selected SQL adapter.
- The host application's admin requires `@payloadcms/next@4.0.0-beta.9` and Next.js `>=16.4.1 <17.0.0`.
- **SQLite** (`@payloadcms/db-sqlite`) or **PostgreSQL** (`@payloadcms/db-postgres`). Install only the adapter your app uses; both adapter peers are optional. Other adapters are not supported.
- `@payloadcms/richtext-lexical@4.0.0-beta.9` is required with either adapter.
- React / React DOM **19.3.1**; Node **^24.22.3 || >=26.13.1** (the supported engine range of this development baseline).

**JSON** and **Rich Text** fields are available only with PostgreSQL. Payload stores these values in separate `jsonb` columns. In the Local and REST APIs, pass JSON in `values[].jsonValue` and Lexical documents in `values[].richTextValue`.

Remove incoming **Relationship** and **Upload** references before deleting an entry or file. When you save an entry, the plugin validates its values against the current field settings.

## Install

Install the beta from npm.

```sh
npm install payload-dynamic@beta
```

If the npm beta tag is not available yet, install the tarball from the [GitHub prerelease](https://github.com/webcredo/payload-dynamic/releases/tag/v0.1.0), or install a local copy with `npm install ./payload-dynamic-0.1.0.tgz`.

### Build a tarball from source

Run these commands from the repository root.

```sh
npm install
npm run check
npm pack
```

`npm pack` builds JavaScript and TypeScript declarations. Install the tarball in your Payload project.

### Install peers

Use the versions above and install the required rich text peer and your chosen database adapter.

```sh
# Required peer with either adapter:
npm install @payloadcms/richtext-lexical@4.0.0-beta.9
# SQLite application:
npm install @payloadcms/db-sqlite@4.0.0-beta.9
# OR PostgreSQL application:
npm install @payloadcms/db-postgres@4.0.0-beta.9
```

The tarball contains `dist`, this README, the license, and npm's package metadata. It does not include the demo app, tests, local databases, uploads, secrets or source configuration. Use the tarball rather than copying `src` or linking the development checkout.

Admin components, including `PostgresJSONField`, resolve through `payload-dynamic/react`, not paths in the demo source. Regenerate your application's Payload import map with its selected database adapter; PostgreSQL also adds the Lexical editor imports.

To upgrade a local SQLite database from a version before nested fields, start the demo once with `DATABASE_PUSH=1 npm run dev` using the existing `DATABASE_URL`, then open `/admin` so Payload adds the array columns and tables. Use `DATABASE_PUSH=0` for subsequent runs. For PostgreSQL, generate and apply a Payload migration before starting the upgraded app.

## Configure the plugin

```ts
import { buildConfig, type Access } from 'payload'
import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { payloadDynamic } from 'payload-dynamic'

const signedIn: Access = ({ req }) => Boolean(req.user)

export default buildConfig({
  secret: process.env.PAYLOAD_SECRET!,
  db: sqliteAdapter({ client: { url: process.env.DATABASE_URL ?? 'file:./payload.db' } }),
  collections: [{ slug: 'users', auth: true, fields: [] }],
  plugins: [payloadDynamic({ canManage: signedIn })],
})
```

For PostgreSQL, replace the adapter configuration:

```ts
import { postgresAdapter } from '@payloadcms/db-postgres'

// Inside buildConfig:
db: postgresAdapter({ pool: { connectionString: process.env.DATABASE_URL! } })
```

Use your application's normal migration workflow for production. The plugin extends the adapter's schema initialization hooks; it does not enable schema push or run migrations itself.

### Options

The root entry exports `payloadDynamic` and the type `PayloadDynamicOptions`.

| Option             | Type                     | Meaning                                                                                                           |
| ------------------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `canManage`        | Payload `Access`         | Required access policy for definitions and entries. Apply an appropriate authenticated/role-based policy.         |
| `uploadCollection` | Payload `CollectionSlug` | Optional existing upload collection for upload fields. The plugin protects referenced uploads against deletion.   |
| `enabled`          | `boolean`                | Defaults to `true`. When `false`, returns the exact host config unchanged, without validating or adding anything. |
| `collections`      | `{ slug?, labels? }`     | Overrides the definitions collection. Defaults to `collections` with **Collection** / **Collections** labels.     |
| `entries`          | `{ slug?, labels? }`     | Overrides the records collection. Defaults to `entries` with **Entry** / **Entries** labels.                      |

Each override is optional. Set `labels.singular` and `labels.plural` independently using Payload's collection label format. Scoped lists and breadcrumbs show the selected record type's title.

```ts
payloadDynamic({
  canManage: signedIn,
  collections: {
    slug: 'content-types',
    labels: { singular: 'Content type', plural: 'Content types' },
  },
  entries: {
    slug: 'content-records',
    labels: { singular: 'Record', plural: 'Records' },
  },
})
```

Use distinct slugs that are available in the host app and in SQL. For example, `content-types` and `content_types` share a SQL name. With the settings above, use `/api/content-types` and `/api/content-records` in REST calls and the same slugs in the Local API. The plugin uses the configured slugs for admin links and relationships. The main SQL tables keep their existing names. When changing slugs in an existing app, update API callers, regenerate Payload types and the import map, and review the generated database migration.

A configured `uploadCollection` must exist and have uploads enabled.

### Admin components and import map

Following Payload's [plugin pattern](https://payloadcms.com/docs/plugins/build-your-own) and [custom component paths](https://payloadcms.com/docs/custom-components/overview), component references are package paths, not paths relative to the consumer's `src`:

- `payload-dynamic/react#EntryFields` and other explicitly exported client components
- `payload-dynamic/react/CollectionsNavigation#CollectionsNavigation` (server component, separate from the client barrel)

After changing the plugin configuration, generate the import map from the host application's project root using its active Payload config. Use the same database adapter for import-map generation, build, and runtime.

```sh
npx payload generate:importmap
```

Keep the generated import map in your Payload admin application. If you installed an earlier local tarball under `payload-dynamic-fields`, install the new `payload-dynamic` tarball, update the plugin import to `payloadDynamic`, and regenerate the map.

## Verify in a clean application

Run the application against a new SQLite file, then separately against a disposable PostgreSQL database. For each adapter: generate the import map, build/start your normal Payload app, log in, create a collection definition and fields, create/edit/read an entry, and verify values survive an application restart. Check validation, access denial and upload reference protection when uploads are configured. Enable schema push only for disposable development databases; use migrations for persistent deployments.

Run `npm run test:collections` for SQLite integration coverage. Set `TEST_DATABASE_URL` to a disposable PostgreSQL database to run the PostgreSQL cases as well. The tests create and remove a dedicated PostgreSQL schema.

## Development application (not shipped)

The root `src/app`, `src/payload.config.ts`, and Next configuration form the local demo application and are excluded from the tarball. The host supplies its own Payload application and application dependencies (Next, adapters, and GraphQL).

Create `.env` in the repository root. Set `PAYLOAD_SECRET` to a long random value and point `DATABASE_URL` at a new SQLite file or an empty PostgreSQL database dedicated to the demo.

```dotenv
PAYLOAD_SECRET=replace-with-a-long-random-secret
DATABASE_URL=file:./native-collections.db
```

Only the demo config selects its adapter from `DATABASE_URL`. For PostgreSQL, use a URL such as `postgres://user:password@localhost:5432/database` before generating the demo import map and starting the app. A host application selects its adapter in its own Payload config.

```sh
npm install
npm run importmap
DATABASE_PUSH=1 npm run dev
```

Open `/admin` to initialize the schema and create the first user. No migration files are provided for the demo. Use `DATABASE_PUSH=1` only with a disposable development database. After initialization, use `npm run dev` for subsequent starts. Run `npm run dev:build` to build the demo and `npm run build` to build the npm plugin.

### Create types and query records

In the admin panel, add a definition under **Collections** and give its fields stable keys. Then select the new type in **Dynamic collections** to create records. The plugin validates types, required values, choices, and references against the definition.

Use the Local API to find Posts entries with a reading time of at least five minutes.

```ts
const entries = await payload.find({
  collection: 'entries',
  where: {
    and: [
      { definition: { equals: postsDefinitionID } },
      { 'values.fieldKey': { equals: 'reading_time' } },
      { 'values.numberValue': { greater_than_equal: 5 } },
    ],
  },
  user,
  overrideAccess: false,
})
```

Use the ID of the **Posts** definition from **Collections** for `postsDefinitionID`. Use your configured entries slug if you changed the default. The `and` group matches the `reading_time` key and the minimum value `5` in the same `values` row in Payload 4.0.0-beta.9. Queries across several keys or ranges need separate conditions for their respective rows. Pass the authenticated Payload user as `user` and set `overrideAccess: false` to enforce the collection's access rules.

The plugin indexes field keys, numeric values, dates, and choice values. It also adds the compound index `collection_values_key_number_parent_idx` on `(field_key, number_value, _parent_id)`. Check your database's query plan for production filters.

### Migrations

Existing records can prevent incompatible changes to field definitions. Plan data migration and backup before changing a field type or removing a field in use.

For production, keep schema push disabled. Use `payload migrate:create` to generate the migration, review its SQL and indexes against a copy of the database, then apply it with `payload migrate`.

## Checks

```sh
npm run check
npm run test:collections
npm run build
npm run test:package
```

## Contributing

Report bugs and suggest changes in [GitHub Issues](https://github.com/webcredo/payload-dynamic/issues). Run the checks above and describe your change when you open a [pull request](https://github.com/webcredo/payload-dynamic/pulls).

## License

[MIT](LICENSE)
