# Photos exact lookup and bounded reads — 2026-10-14

## Reproduction and cause

The live MCP `photos_get` call for `97BA86C0-62F6-4F89-B55A-72613843B93F` reproduced `CONFLICT: Photo missing from the supported library index.` (requestId `9fd46107-0767-49ce-a06f-845014768c73`). Historical Worker logs were unavailable in this environment.

Source inspection found that `get()` used the rank-based query index with `startRank=0`, a limit of two, and a `recordName` filter, then searched those results for the requested ID. The implementation had no persistent photo index. This is not reliable exact record lookup and explains why listed deep-page IDs can fail while some initial photos work; Apple's treatment of that index filter still needs live confirmation.

## Changes

- Use `records/lookup` in the personal `PrimarySync` zone for the exact CPLAsset ID, then resolve CPLMaster through `masterRef`. Metadata, thumbnail and original download share this path. Validate returned record identity, type, deletion and master reference; do not expose signed URLs in metadata.
- Request only summary fields in list queries, cap each page at 20 assets, and halve the page on the specific response byte-budget error. Keep the 1 MiB transport limit. `nextOffset` advances by the actual number returned; clients must follow it even when requesting 100.
- Retry transient D1 lease/version contention during preparation only, within 12 seconds and the overall request budget. Reload on each preparation attempt and pin the original generation. Reconnect/disconnect conflicts stop; this helper does not replay the service callback or a mutation.
- Record successful Photos MCP reads under the account/session check scope. Photos `realAppleValidated` reflects a successful scoped connection check; `productionValidated` remains false. An `ok` check proves only that recorded read, not every photo operation or perpetual availability.

## Validation

Typecheck, build, 34 service/regression tests, and the local workerd integration suite passed. Added coverage includes deep-page IDs, independent master IDs, thumbnails/originals, wrong/deleted records, page shrinking, actual offset advancement, authentication failures and preparation contention. Workerd coverage exercises Access → MCP → encrypted D1 session → simulated Apple lookup, concurrent album/query calls, image content, download ticket and scoped status.

Apple responses in the new integration tests are simulated. Production verification must repeat the reported IDs after Cloudflare deploys this commit. No Apple credentials, encryption key, schema or environment-variable migration is required.
