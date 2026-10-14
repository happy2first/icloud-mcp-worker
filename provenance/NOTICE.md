# Provenance and attribution

Authentication, crypto, Apple HTTP/Cookie/push/WebSocket, encrypted D1 sessions, Access verification, CloudKit/CRDT and Reminders code and applicable synthetic tests were copied from Xzese/icloud-reminders-mcp-for-cloudflare-workers at f4da3d8ef41b5bc16415a75abc0043d16e3fcba2 (MIT). Its application copyright remains in the root LICENSE.

`upstream-xzese-sources.json` is the original inherited source provenance, including the older pyicloud revision used to generate the SRP/SPAKE2/CRDT synthetic transcripts. It is not the new service-port manifest. Original reference notices (including pyicloud, icloud-linux and Python srp) are retained in licenses/.

The new Notes, modern Photos and Drive adapters were informed by timlaing/pyicloud revision d0a0d3747fa145f9b89a130af17a364f5252af2b. See docs/RESEARCH.md and the additional current pyicloud MIT notice. Notes uses a bounded handwritten codec; no generated protobuf source or schema file is copied.

@noble/curves, @noble/hashes, fflate, jose and MCP SDK provide runtime libraries under their package licenses; fast-xml-parser parses DAV responses. package-lock.json records actual installed dependency versions/licenses. The inherited full Next.js/Sites dependency inventory was removed because those dependencies are not part of this project. Build/runtime dependencies install their own license notices in node_modules.

No Python subprocess or Python code runs in the deployed Worker. tests/fixtures/generate.py is an optional inherited offline generator requiring the older pinned pyicloud checkout and its Python fixture dependencies; normal tests use the checked-in synthetic protocol.json.

Fixture agreement is not independent proof of Apple protocol correctness. Neither the repository license nor passing tests substitutes for account authorization, cryptographic review or real hosted acceptance.

Find My HTTP/state handling in `src/services/findmy.ts` also follows timlaing/pyicloud at commit `fb56ed6652f2d99ca8dc3cf515f7db0b319fcf1d` (MIT). Existing pyicloud MIT notices remain included. See `docs/FINDMY-VALIDATION.md` for exact source references and Worker adaptations.

The 2026-10-14 timed recurring-completion recipe and date-component helpers in `src/reminders/recurring-completion.ts` and `src/reminders/date-components.ts` additionally adapt Xzese/icloud-mcp-for-cloudflare-workers's `recurring-lifecycle.ts` and `linked-date.ts` (MIT), inspected on that date. Copyright remains covered by the root LICENSE and the source headers. This bounded port supports only the documented timed interval-one daily/weekly recipe; it does not include all upstream recurrence, journal or scheduling features.
