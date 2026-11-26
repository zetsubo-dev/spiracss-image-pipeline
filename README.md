# @spiracss/image-pipeline

Framework-agnostic image optimization and build-time asset pipeline for static sites. Optimize source images during development, convert and rewrite publishable assets safely during builds, and share adopted build results across teams and CI through Git.

## Key Features

- **Size-checked optimization**: Converts and optimizes raster images (AVIF, WebP, PNG, JPEG) and SVGs, adopting a candidate only when it is smaller than the original.
- **Git-shareable adopted store**: Commit `.image-adopted` (`records` and `blobs`) so teammates and CI reuse deterministic build results instead of re-encoding unchanged images, backed by `store check --staged`, `store prune`, and `store refresh`.
- **Source protection ledger**: Optimize source images in place during development (`source` / `--watch`) while avoiding repeated re-compression through `.source-image-processed.sha256` (`--baseline` and `record merge`).
- **Usage-aware format preservation**: Keep original formats for compatibility-sensitive usages such as `ogp`, `favicon`, and `apple-touch-icon` via `preserveFormatFor`.
- **Safe reference rewriting and collision checks**: Updates HTML (`img`, `picture > source`, `srcset`, icon links, OGP/Twitter, JSON-LD), CSS `url()`, and Web Manifest icons while keeping originals whenever the full reference set cannot be established, and detects output collisions with fixed public assets (including Unicode canonical equivalence and case folding).
- **Standalone CLI and build adapter API**: Run directly as a CLI or integrate into static site generators and bundlers through `@spiracss/image-pipeline/adapter/v1`, including server-side inline SVG preparation (`prepareInlineSvg`).

## Requirements

- **Node.js**: `>=24.22.3 <25` or `>=26.1.0 <27`.
- **Module format**: ESM-only (`import` condition; `require()` is not supported).
- **TypeScript**: Requires `@types/node` and `NodeNext` module and module resolution settings.
- **Process lock inspection (`ps`)**: The CLI and APIs that acquire file locks require `ps` on `PATH` with support for `ps -p <pid> -o lstart=`. These APIs include source optimization, output processing, and writes to the ledger and adopted store. Without a compatible `ps`, such as on standard Windows installations, they fail with `Failed to inspect process start time`.

## Install

```sh
npm install @spiracss/image-pipeline
pnpm add @spiracss/image-pipeline
```

Run the CLI with `npx spiracss-image-pipeline` or `pnpm exec spiracss-image-pipeline`.

The package provides four entry points:

- `@spiracss/image-pipeline`: source optimization, output processing, and adopted store operations.
- `@spiracss/image-pipeline/config`: configuration helpers.
- `@spiracss/image-pipeline/adapter/v1`: build adapter and image placement APIs.
- `@spiracss/image-pipeline/watch`: source file watching.

## Run the CLI

Run the commands from your project root. Paths in the configuration are relative to that directory.

Save this JSON as `images.json`:

```json
{
  "publicRoots": ["public"],
  "adoptedStoreDir": ".image-adopted",
  "image": {
    "build": {
      "outputFormat": "avif",
      "preserveFormatFor": ["ogp", "favicon", "apple-touch-icon"]
    }
  },
  "output": {
    "publicCopies": [{ "source": "public", "destination": "." }],
    "editableDocuments": ["index.html", "assets/styles.css"],
    "base": "/",
    "stateDir": ".cache/image-pipeline-output"
  },
  "environments": [
    {
      "name": "production",
      "config": { "build": { "outputFormat": "avif" } },
      "inputs": [
        {
          "file": "src/images/header.png",
          "logicalName": "src/images/header.png",
          "logicalPlacement": "assets/images/header.png"
        }
      ]
    }
  ]
}
```

Use an empty `publicRoots` or `publicCopies` array when there are no fixed public assets. The source commands require `publicRoots`. The output command requires `publicCopies` and `editableDocuments`.

```sh
spiracss-image-pipeline source src/images --config images.json
spiracss-image-pipeline source src/images --watch --config images.json
spiracss-image-pipeline source src/images --baseline --config images.json
spiracss-image-pipeline record merge teammate.sha256
spiracss-image-pipeline output dist --config images.json
```

`source` can replace an input with a smaller image in the same format. `--baseline` records source digests and preserves the image files. Commit `.source-image-processed.sha256` with the source images. A one-column record protects source files during development. A two-column record also identifies the processing conditions.

The output command resolves HTML image attributes, icon links, OGP and Twitter image fields, CSS `url()` references, and simple `srcset` candidates on `img` and `picture > source`. Candidate URLs resolve relative to the HTML document. Supported sets use distinct width or density descriptors, with no HTML entities or data URLs. A set is updated only when all candidates can be processed and select the same format; an existing `source` type follows that format. Original files referenced by a set are kept from same-path replacement. Use `output.siteOrigin` to match absolute URLs for your site. Use `output.base` for deployments below the domain root. Query strings and fragments follow the selected image URL. `preserveFormatFor` defaults to an empty list. Set it for any metadata field that needs the original format.

Editable UTF-8 `.webmanifest` files and HTML-linked `.json` manifests support `icons`, `shortcuts[].icons`, and their `icons_localized` variants. URLs resolve relative to the manifest; existing `type` fields follow the selected format. `screenshots` remain read-only and keep the referenced original. HTML `application/ld+json` image, logo, thumbnailUrl and contentUrl fields are parsed as JSON. Fixed public documents retain their bytes.

The current output implementation preserves originals when it cannot establish the full set of references. Examples include JavaScript, unrecognized or malformed JSON-LD and manifests, unsupported or ambiguous `srcset` syntax, inline styles, and HTML with a `<base>` tag. It can emit separate images for the references it can update. Declare `output.inventory.completeReferences` and provide `output.inventory.generatedImages`, with `output` and `logicalName` fields, to allow same-path replacements. The command preserves documents outside the editable list and updates editable UTF-8 documents by editing the affected attribute or CSS value.

## Resolve images during a build

Create one build object per project and build. Pass each reference's usage and logical placement before computing the hash of the referring HTML, CSS, or JavaScript.

```js
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { createImageBuild } from '@spiracss/image-pipeline/adapter/v1'
import { defineImageConfig } from '@spiracss/image-pipeline/config'

const build = createImageBuild({
  projectRoot: process.cwd(),
  outputDir: 'dist',
  config: defineImageConfig({
    build: { outputFormat: 'avif', preserveFormatFor: ['ogp'] },
  }),
  adoptedStoreDir: '.image-adopted',
  cacheDir: '.cache/images',
})
await build.registerFixedCopies([]) // Supply the fixed public copies when the build has any.

const prepared = await build.prepareUse({
  input: { kind: 'generated', file: 'src/header.png', logicalName: 'src/header.png' },
  logicalPlacement: 'assets/images/header.png',
  usage: 'body',
  hashLength: 12,
})
const image = build.publish(prepared, {
  owner: 'src/header.png',
  generated: true,
  destination: prepared.suggestedDestination,
  url: '/' + prepared.suggestedDestination.split('/').map(encodeURIComponent).join('/'),
})

const destination = path.join('dist', image.destination)
await mkdir(path.dirname(destination), { recursive: true })
await writeFile(destination, image.bytes)
await build.verifyPublication('dist')
console.log(image.url)
```

The optional `localCache` argument accepts `maxBytes` and `maxEntries` as positive safe integers. Defaults are 512 MiB (536870912 bytes) and 4096 entries. Limits apply only to the local trial cache; entries used by the current build remain protected.

Pass `urlFor` for host-specific URL placement. Use `kind: 'fixed-public'` for copies with a fixed URL and original bytes. Prepare an inline SVG on the server with `prepareInlineSvg`. Pass the returned `prepared-inline-svg/v1` value to your rendering code.

### Adapter contract

Use `prepareUse` to read input and choose bytes. Call the same build's synchronous
`publish(prepared, placement)` before returning the final URL or emitting the
file. It validates the placement and reserves the destination. Declare fixed
copies with `registerFixedCopies` (use `[]` when there are none) or restore a
checkpoint with `resume` before publishing generated images. The declaration
includes every fixed copy that could collide with an image, including non-image
files. Names always collide when they are canonically equivalent. The build
also folds case until its output volume is measured or its case behavior is
explicitly configured with `caseInsensitiveOutputs`.

Use `planManifestImages` to find local manifest links and image references and
rewrite selected references. `unknownReasons` identifies malformed JSON
(`JSON_SYNTAX`, `JSON_DUPLICATE_KEY`), unsupported content
(`UNRECOGNIZED_CONTENT`), and unresolved local URLs (`UNRESOLVABLE_URL`).
External URLs are ignored. The CLI accepts `--help` or `-h` alone or with a
command prefix. String options require a nonempty value.

Host adapters can append source digests and optional processing signatures with
`recordSourceImages` from `@spiracss/image-pipeline`. Use the same
`sourceRecordLockPath` as source optimization and ledger merges when replacing
the default lock location.

## Share adopted results

Commit `records` and the referenced `blobs` with the source images and configuration. Add the following attributes when you use the default store path in the example.

```gitattributes
.image-adopted/blobs/** binary
.image-adopted/records/**/*.json text eol=lf -merge
```

Ignore `/.image-adopted/.tmp/` and keep the store outside your published directory. A store hit requires the same source bytes and effective settings. SVG also requires the same logical path. Git line-ending conversion can change source SVG bytes and yield a different key. Use `git ls-files -u` to see records with unresolved merge conflicts and resolve each record as a whole.

```sh
spiracss-image-pipeline store check --staged --config images.json
spiracss-image-pipeline store prune --config images.json
spiracss-image-pipeline store prune --apply --config images.json
spiracss-image-pipeline store refresh <key> --config images.json --env production
```

The staged check reads the Git index. Without `--config`, it checks `IMAGE_ADOPTED_STORE_DIR` or the project's `.image-adopted/`. Stage the referenced blob when the command reports a missing path. Restore a damaged blob from Git or another checkout and verify its full SHA-256 before rebuilding. Prune requires the inputs and logical placements for every environment that uses the store. Use each environment's `missing` list to report dependencies or other inputs you could not enumerate. The apply command evaluates the current inventory before deleting unused entries. Run prune and refresh after builds using the store have stopped. Rebuild the environment after refresh to propagate the result to its output.

## Verify a development checkout

Run `pnpm install --frozen-lockfile`, then `pnpm run check` or `pnpm test`. The tests use generated fixtures. The checks have run on macOS arm64 with Node.js 24.22.3 and 26.1.0.

## License

The package is licensed under the MIT License. The included Unicode 17.0.0 case folding table is covered by the Unicode License v3. See [LICENSE](LICENSE) for details.
