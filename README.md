# POS Ninja Device Sync — Website (Stage 3 of 3)

Final piece. Builds on Stage 1 (server) and Stage 2 (Flutter app).

## Changed files (full replacements — drop straight in)

```
index.html   — added the "Device Sync" tab + panel, plus the SheetJS <script> tag
app.js       — generalized setMode() from 2 tabs to 3 (text / item / sync)
style.css    — appended styles for the new sync panel (search "Device Sync panel")
```

## New file

```
sync.js      — all pairing/list/download/upload logic for the sync tab
```

`manifest.json` is untouched — nothing here needs it.

## ⚠️ One thing you must configure server-side: CORS

This site calls `api.food-ninja.com` directly from browser JS (`fetch`)
for four endpoints: `pair/claim`, `files` (the JSON listing), 
`files/push-to-app`, and `unlink`. Unless your Deno server already sends
CORS headers allowing `https://upload.pos.food-ninja.com` as an origin
for these paths, the browser will block them.

You already have `cors` in your `deno.json` imports — just make sure
whatever origin allow-list it's configured with in `main.ts` includes
your sync website's origin, covering (at minimum) `POST` and `GET` with
a `Content-Type` header.

The one exception is the **file download** (`files/download`) — that's
a plain `<a href>` navigation, not a `fetch`, so it needs no CORS
handling at all; the browser follows the server's redirect straight to
the presigned S3 URL and downloads it.

## How it fits together, end to end

1. **Pair (once):** in the app, Settings → Device Sync → Generate
   Pairing Code shows e.g. `XKPQ-7RTN` for 10 minutes. On this website's
   Device Sync tab, typing that code in calls `pair/claim`, which
   returns the device's permanent sync token. The token is stored in
   `localStorage` — the code itself is now spent and irrelevant.
2. **Download:** the dashboard polls `files` every 30s and shows a
   Download button per file that's currently available (populated
   whenever the app's "Sync Now" has run in roughly the last 20
   minutes). Clicking Download is a plain link click — no JS fetch
   needed, so it works even if something's gone wrong with `fetch`
   elsewhere on the page.
3. **Upload:** picking an `.xlsx` and clicking "Upload to POS Ninja"
   pushes it to `files/push-to-app`. Back in the app, Inventory → +
   → Import from Excel → "Import from Website" picks it up.
4. **Template:** "Download Blank Import Template" needs no pairing at
   all — it's generated entirely client-side with SheetJS, matching
   `ExcelImportService.buildTemplate()`'s exact column headers, so a
   template from here and one from inside the app are interchangeable.
5. **Disconnect:** either side can end the relationship — "Disconnect"
   here calls `unlink` and clears `localStorage`; "Unlink This Device"
   in the app's Settings does the same server-side call and clears its
   own stored token. Either one immediately invalidates the other.

## Testing checklist

- [ ] CORS allow-list includes the site's origin (see above)
- [ ] Generate a code in the app, paste it here — dashboard should
      appear and stay connected across a page reload (token persists in
      `localStorage`)
- [ ] Tap "Sync Now" in the app, then "Refresh" here — three files
      should appear with sizes and expiry countdowns
- [ ] Download each file and confirm it opens correctly in Excel/Numbers
- [ ] Upload a `.xlsx` here, then use "Import from Website" in the app
      — the import preview (created/updated/skipped counts) should
      match what the file actually contains
- [ ] Wait ~20 minutes without syncing — files should disappear from
      the dashboard on the next refresh
- [ ] Disconnect from either side and confirm the other side's next
      action fails gracefully (a fresh pairing code / re-pairing should
      recover it)

## Not done here (per your note)

Privacy Policy / Terms of Service updates — you're handling those
yourself. Section 2.4 of the current Privacy Policy already anticipates
a feature like this ("cloud sync... may be introduced. Before any such
feature... we will update this Privacy Policy").
