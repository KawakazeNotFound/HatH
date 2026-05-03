# Image Search Test Notes

Test date: 2026-05-03

## E-Hentai Form

Homepage loads file search form from:

- `https://e-hentai.org/z/0381/ehg_index.c.js`

The generated form posts to:

- `https://upload.e-hentai.org/image_lookup.php`

Multipart fields:

- `sfile`: uploaded image file
- `f_sfile=File Search`
- `fs_similar=on` for similarity scan
- `fs_covers=on` for cover-only search

## Sample Upload

Sample file:

- `Test/imgsearch-sample.webp`
- Source: Worker `/v1/cache/file`
- Size: 84110 bytes
- Content-Type: `image/webp`

Command result:

- Upload endpoint returned `302 Found`
- `Location: https://e-hentai.org/?f_shash=e0cc8276b23c3654f12280039c1cf1632e05ba97&fs_from=imgsearch-sample.webp`
- Following the redirect returned a page containing `Found 2 results.`

## Implementation Decision

The WebUI calls Worker `POST /v1/imgsearch`.

The Worker:

1. Resolves the selected H@H client.
2. Fetches the selected cached image.
3. Uploads it to `https://upload.e-hentai.org/image_lookup.php`.
4. Returns the redirect/search URL as JSON.

The dashboard opens that returned URL in a new tab. This avoids browser CORS issues and avoids depending on Worker-side parsing of E-Hentai result HTML.
