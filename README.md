# FormFill

Chrome extension (MV3) that refills forms on URLs you choose.

## Install
1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → pick this folder

## Use
1. Fill the form by hand, once.
2. Open the extension → **Read form on this page**.
3. Pick how it should match:
   - **Exact URL** — `https://app.example.com/settings?tab=1`
   - **URL starts with** — `https://app.example.com/settings` (editable, so you can broaden it)
   - **Whole site** — `https://app.example.com`
   - **Wildcard** — `*` matches any run of characters, e.g.
     `https://specta-test--*.web.app/snap/login/email` covers every preview deploy
4. Untick fields you don't want, tweak values, **Save**.

Next visit it fills automatically. **Saved** tab has Fill now / auto on-off / edit / delete.
Overlapping profiles: the longest matching pattern wins.

Preview-deploy hostnames (`specta-test--pr7729-….web.app`, `deploy-preview-42--site.netlify.app`)
are detected on capture: the mode starts on **Wildcard** with the volatile half of the
hostname already blanked out.

## Notes
- Password fields are captured but **off by default** — `chrome.storage.local` is not encrypted.
- Each field stores several fallback locators (id → name → aria-label → placeholder → label text → DOM path), so a re-skinned page usually still fills.
- Values are set through the native setter + `input`/`change` events, so React/Vue forms register them.
- Retries for ~3s after load to catch forms an SPA renders late.
- Wildcard patterns are anchored (`^…$`) and all non-`*` characters are escaped, so a
  pattern can't be satisfied by a matching substring inside some other site's query string.
- Saved profiles live in `chrome.storage.local`, never in this repo.
