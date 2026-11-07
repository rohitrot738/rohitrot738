# Suffer Sathi Android updates

The existing debug APKs use ephemeral debug signing keys. The first signed
release requires uninstalling the old debug APK (which removes local app data).
Subsequent signed releases use the same application ID and signing key, so
Android can install them over the existing app after the user confirms.

An Android `JobScheduler` job checks the fixed GitHub update release roughly
every six hours when networking is available. Android may defer checks for
battery or other restrictions; force-stopping the app prevents checks until
it is opened again. Notifications must be enabled. Tapping the notification
opens the release page; the user downloads the named APK and confirms Android's
installation prompt. This is not a silent installer or a real-time push.

## One-time signing setup

1. Create a short-lived fine-grained GitHub token restricted to this repository
   with repository **Secrets: Read and write** permission. Do not share it in
   chat or commit it. Create an Actions repository secret named
   `SIGNING_SETUP_TOKEN` containing the token.
2. From the default branch, manually run the **Set up Android signing**
   workflow. It creates a new key and stores `ANDROID_KEYSTORE_BASE64` and
   `ANDROID_KEYSTORE_PASSWORD` as repository Actions secrets. It refuses to
   overwrite either existing secret. If setup fails after saving only one, do
   not delete an existing production key: check the situation before retrying.
3. Revoke the temporary token and delete `SIGNING_SETUP_TOKEN`. Never delete or
   replace the two signing secrets: losing the key means existing installations
   cannot be updated in place. GitHub secrets cannot be viewed after saving.
4. Manually run **Build Android APK** on `main`. Once signing secrets exist,
   successful main builds create a signed APK with an increasing version code,
   upload an artifact and publish it to the fixed `suffer-sathi-updates`
   release. Install the first signed APK manually.

Only trusted maintainers should have permission to change workflows or run the
signing setup; workflows with access to these secrets can use the signing key.
The update release is separate from the OSM data releases. Old APK assets may
remain in the release; always use the filename named in its current notes.
