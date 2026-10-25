# Signing the installers

Goldfelty's release workflow already signs and notarizes builds. It does so as
soon as the credentials below are added to the repository. Until then it
produces unsigned builds, which is why macOS calls the app "damaged" and
Windows SmartScreen warns about it.

Signing proves a download came from you and wasn't altered. For an app that
asks wallets to sign transactions, it's worth doing before promoting the app
widely.

Only the owner can do this: Apple and Microsoft verify the identity of the
person or company they issue certificates to.

## macOS: Apple Developer ID (about US$99 a year)

1. Join the [Apple Developer Program](https://developer.apple.com/programs/)
   as an individual or an organization. Approval for an organization needs a
   D-U-N-S number and takes a few days.
2. In Xcode → Settings → Accounts, or at
   [developer.apple.com/account/resources/certificates](https://developer.apple.com/account/resources/certificates/list),
   create a **Developer ID Application** certificate.
3. In Keychain Access, export that certificate *with its private key* as a
   `.p12` file, with a strong password.
4. Create an **app-specific password** for your Apple ID at
   [account.apple.com](https://account.apple.com) → Sign-In and Security.
5. Add these **repository secrets** (Settings → Secrets and variables →
   Actions → Secrets):

| Secret | Value |
|---|---|
| `CSC_LINK` | The `.p12` file, base64-encoded: `base64 -i cert.p12 \| pbcopy` |
| `CSC_KEY_PASSWORD` | The `.p12` password |
| `APPLE_ID` | Your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | The app-specific password |
| `APPLE_TEAM_ID` | The 10-character Team ID from the developer account |

The next release is then signed with your Developer ID and notarized by Apple,
and opens without the `xattr` step.

## Windows: Azure Trusted Signing (about US$10 a month)

Since 2023, ordinary code-signing certificates must live on hardware tokens,
which a CI runner can't hold. Microsoft's Azure Trusted Signing is the
practical replacement, and its signatures build SmartScreen reputation.

1. Create an Azure account and a **Trusted Signing account** in the Azure
   portal. Note its region endpoint, for example
   `https://eus.codesigning.azure.net`.
2. Complete **identity validation** (individual or organization). This takes
   from a day to a couple of weeks.
3. Create a **certificate profile** of type *Public Trust*.
4. Create an **app registration** in Microsoft Entra ID with a client secret,
   and give it the *Trusted Signing Certificate Profile Signer* role on the
   signing account.
5. Add these to the repository:

| Kind | Name | Value |
|---|---|---|
| Secret | `AZURE_TENANT_ID` | The Entra tenant ID |
| Secret | `AZURE_CLIENT_ID` | The app registration's client ID |
| Secret | `AZURE_CLIENT_SECRET` | The client secret |
| Variable | `AZURE_SIGNING_ENDPOINT` | The region endpoint from step 1 |
| Variable | `AZURE_SIGNING_ACCOUNT` | The Trusted Signing account name |
| Variable | `AZURE_CERTIFICATE_PROFILE` | The certificate profile name |
| Variable | `AZURE_PUBLISHER_NAME` | The name on the certificate, exactly as validated |

## Linux

Linux packages aren't signed by an OS vendor. The checksums and provenance
below cover them.

## What's in place already, for every build

- **SHA-256 checksums** for every file, in `SHA256SUMS.txt` on each release.
- **Build provenance attestations**: a record, signed through GitHub and
  Sigstore and kept in a public transparency log, that each file was built by
  this repository's release workflow from a specific commit. Anyone can check
  a download with the [GitHub CLI](https://cli.github.com):

  ```sh
  gh attestation verify "Goldfelty Portfolio Manager-1.2.0-arm64.dmg" \
    --repo gceoalexyt-ops/goldfelty-portfolio-manager
  ```

  A file altered or swapped anywhere after the build fails this check, even if
  someone also changed the checksum file. Attestations are free for public
  repositories.
- Downloads are served from GitHub Releases, not from goldfelty.com, so a
  compromise of the website alone can't replace an installer.
