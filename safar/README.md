# Suffer Sathi Android updates

The existing debug APKs use ephemeral debug signing keys. The first signed
release requires uninstalling the old debug APK (which removes local app data).
Subsequent signed releases use the same application ID and signing key, so
Android can install them over the existing app after the user confirms.

The app updates itself the way Share Scan does. When it is opened it looks at
the fixed GitHub update release; if that carries a newer version it asks, then
downloads the APK with Android's download manager (the download carries on
with the app closed), checks that the file is this app at that version, and
hands it to the system installer. Android asks the user to confirm each
installation, and the first time also to allow installs from this app. This is
not a silent installer. Debug builds never offer updates: they carry a
different key.

An Android `JobScheduler` job also checks roughly every six hours when
networking is available and posts one notification per new version; tapping it
opens the app on the update prompt. Android may defer checks for battery or
other restrictions, and force-stopping the app prevents them until it is
opened again.

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
