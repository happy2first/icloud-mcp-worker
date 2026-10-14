# Find My password reauthentication

The mainland account can read other services while FMIP returns an empty HTTP 450, even after fresh device verification. The official Find My page asks for the account password again. HTTP 450 alone does not prove token expiry or the precise rejection cause.

Use the Find My card's **验证查找** action, `/connect/apple?service=findmy`. The existing browser SRP implementation proves the password; neither raw passwords nor derived keys enter the Worker API. This is an isolated, explicit interactive operation, not an automatic MCP retry.

The Worker restores the verified session's Apple context, performs a new password proof with retained trust material, and accepts direct password success only in this reauthentication mode. A new HSA2 challenge still uses the normal device verification bridge. Initial connection continues to require fresh device verification.

Before saving, enforce the original DSID and session generation and actually list accessible Find My devices. Only a successful read commits authentication material. Cancellation, wrong-account results or a rejected device listing leave the stored original credentials intact. Other service settings, PCS checkpoints and the original retention assurance are preserved. Apple's own server-side token revocation remains outside this guarantee.

References: timlaing/pyicloud `authenticate`, SRP and Find My recovery; Apple's public mainland Find My and CloudOS scripts (`retrieveSession`/`processSessionRetrieveFinish`); ticaki/ioBroker.icloud `invalidateSession`. The obsolete direct `appName + apple_id + password` accountLogin flow is not used.

Synthetic tests cover direct password success, identity mismatch, callback/read failure, initial verification enforcement and opening/cancelling an isolated socket without replacing the saved session. Production password verification and device listing require the owner's interactive test; this change is not yet a confirmed fix for every HTTP 450.
