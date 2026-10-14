# Pre-publication source review / 开源前源码检查

Date: 2026-10-14. Reviewed baseline: 6a9ad525bf4b235a30e8b9cafa27a32ccf790c5f.

## Scope and method

- Retrieved the remote main tree (117 tracked files), all 45 reachable main commits back to the initial commit, and their complete recursive trees.
- Inspected 411 unique historical file blobs, using verified local Git/file contents and fetched remote blobs; recursive trees were not truncated.
- Examined commit messages and author/committer metadata. The listed branch was main; this is a review of its reachable history, not a certification of every unreferenced GitHub object.
- Searched account/contact information, operator domains, known private resource identifiers, private-key blocks, provider token formats, JWT literals, app-password shapes, deployment IDs, credential filenames and literal credential assignments. Reviewed the resulting fixtures/examples and URL domains.

## Findings

No real Apple credentials, session tokens/cookies, encryption keys, private keys, operator production domains, personal account addresses, family/device/location data or private reminder identifiers were identified in the reviewed source/history.

A subsequent broad documentation-ID check identified one real photo identifier and one request ID in docs/PHOTOS-FIX.md, present in ten reviewed main commits. These are opaque resource/trace identifiers rather than credentials and cannot independently retrieve a photo. Their current document has been anonymized. The old commits still contain them; no history rewrite or visibility change has been performed. Removing the historical occurrences requires a separate coordinated decision.

App-password-shaped matches are the synthetic test value aaaa-bbbb-cccc-dddd and the placeholder xxxx-xxxx-xxxx-xxxx. Email matches use reserved example/test domains or intentional malformed Apple URL test cases. Protocol transcripts are synthetic fixtures. The historical all-zero D1 ID was a non-functional placeholder, not a real database identifier.

Commit metadata uses the repository owner's GitHub noreply address. Public repository handles and upstream attributions remain deliberately visible. LICENSE and applicable upstream notices are retained. History cleanup of the two document identifiers remains a separate pre-publication decision.

## Changes prepared for publication

- Rewrite Chinese/English READMEs around the current seven services, self-hosted deployment and any compatible MCP client.
- Describe conditional Apple verification, two credential classes, current-occurrence-only recurring completion and explicit sound confirmation.
- Replace obsolete global “never live tested” claims with scoped evidence and unverified limits.
- Add SECURITY.md and exclusions for local secrets/configuration, database dumps, private keys, HTTP captures and logs.

## Limits

This targeted review is not a cryptographic audit or a guarantee that every possible secret format is detected. It does not inspect deployed D1 data, Worker Secrets, Cloudflare logs, GitHub issues/attachments, workflow artifacts, releases or unreachable objects. Repository visibility is a separate action; preparing these files does not make the repository public.

## 中文结论

已检查 main 的 45 次提交和 411 个不同文件版本，未识别出真实凭证、个人联系方式或生产部署信息。命中的密码/邮箱为测试数据和占位值。照片修复文档中发现一个真实照片ID和一个请求编号，已在当前文件匿名化，仍存在于10次旧提交中；它们不是凭证，但公开前应决定是否清理历史。保留公开GitHub归属和上游许可。本次未重写历史或改变可见性；检查不包含生产数据、平台日志和仓库外附件。
