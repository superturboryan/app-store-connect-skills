# App Store Connect Credentials

Use a Team API key from App Store Connect.

## Create The Key

1. Open App Store Connect.
2. Go to **Users and Access**.
3. Open **Integrations**.
4. Open **App Store Connect API**.
5. Use **Team Keys**.
6. Generate a key.
7. Choose the least privilege role that supports marketing metadata. For localized copy,
   screenshots, and app previews, use **Marketing**. Do not use **Full Access** unless a future
   workflow specifically requires it.
8. Download the `.p8` private key immediately. Apple only allows downloading it once.

## Store Locally

```zsh
mkdir -p ~/.appstoreconnect
chmod 700 ~/.appstoreconnect
mv ~/Downloads/AuthKey_<KEY_ID>.p8 ~/.appstoreconnect/
chmod 600 ~/.appstoreconnect/AuthKey_<KEY_ID>.p8
```

Create an env file outside the repo:

```zsh
ASC_KEY_ID=<KEY_ID>
ASC_ISSUER_ID=<ISSUER_ID>
ASC_KEY_PATH=/Users/you/.appstoreconnect/AuthKey_<KEY_ID>.p8
ASC_APP_ID=<APP_ID>
ASC_PLATFORM=IOS
ASC_COPYRIGHT=2026 Your Name
ASC_SHEET_ID=<GOOGLE_SHEET_ID>
ASC_SHEET_NAME=<SHEET_TAB_NAME>
```

Keep the target App Store version out of shared credential files. Provide it with `--version` or
`version.versionString` in desired JSON. `ASC_PLATFORM` is recommended for every sync so version
lookup cannot accidentally match the same version string on another platform. `ASC_PLATFORM` and
`ASC_COPYRIGHT` are required when using `--ensure-version` to create a missing App Store version,
unless equivalent values are provided in desired JSON.

Secure it:

```zsh
chmod 600 ~/.appstoreconnect/*.env
```

Never commit `.env` files, JWTs, or `.p8` private keys.
