# WooCommerce Variant Image Exporter

A small, near-zero-dependency Node.js CLI that walks every **variable product** in a
WooCommerce store via the REST API (v3) and exports the **variation-level image URLs**
to a CSV. The output is ready to be consumed by [Matrixify](https://matrixify.app/)
(or a similar importer) to set variant images on the **Shopify** side during a migration.

## Output columns

```
variant_sku, image_url, image_alt, product_title, product_handle,
parent_sku, wp_product_id, wp_variation_id
```

## Requirements

- **Node 18+** (uses native `fetch`)
- WooCommerce REST API credentials with at least **Read** permission

## Getting WooCommerce API credentials

1. WP Admin → **WooCommerce → Settings → Advanced → REST API**
2. **Add key**
3. Description: `Variant images export`, User: your admin user, Permissions: **Read**
4. **Generate API key**
5. Copy **both** the Consumer key (`ck_…`) and Consumer secret (`cs_…`).
   ⚠️ The secret is shown **only once**.

## Setup

```bash
# 1. Install dependencies (just dotenv)
npm install

# 2. Create your .env from the template and fill in your values
cp env.example .env
```

Edit `.env`:

```env
WP_SITE_URL=https://yoursite.com
WC_CONSUMER_KEY=ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
WC_CONSUMER_SECRET=cs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

> 🔒 `.env` is git-ignored. **Never commit your real credentials.**

## Usage

```bash
npm start          # runs the export
npm run verbose    # same, with detailed per-product logging
```

Or directly:

```bash
node extract-variant-images.js
```

The script writes `variant-images.csv` to the current folder and prints a summary:

```
========================================
  Variable products processed:    123
  Variants WITH image:            456
  Variants WITHOUT image:         7
  Output:                         ./variant-images.csv
========================================
```

## Configuration

All options are set via environment variables (in `.env` or inline). See
[`env.example`](env.example) for the full template.

| Variable                 | Default               | Description                                                      |
| ------------------------ | --------------------- | ---------------------------------------------------------------- |
| `WP_SITE_URL`            | _(required)_          | Your WordPress site URL, no trailing slash.                      |
| `WC_CONSUMER_KEY`        | _(required)_          | WooCommerce REST API consumer key (`ck_…`).                      |
| `WC_CONSUMER_SECRET`     | _(required)_          | WooCommerce REST API consumer secret (`cs_…`).                   |
| `PER_PAGE`               | `100`                 | Items requested per API page.                                    |
| `REQUEST_DELAY_MS`       | `120`                 | Throttle (ms) between requests to avoid rate limits.             |
| `OUTPUT_FILE`            | `./variant-images.csv`| Path of the generated CSV.                                       |
| `VERBOSE`                | `0`                   | Set to `1` for detailed logging.                                 |
| `INCLUDE_PARENT_GALLERY` | `0`                   | Set to `1` to also emit one row per parent product gallery image (with an empty `variant_sku`). |

## Notes

- The client retries on `429` / `5xx` responses with exponential backoff.
- WooCommerce sometimes returns the parent gallery's first image as a variation's
  image when no explicit variation image is set. If that becomes a problem, you can
  filter those out by comparing `img.id` against the parent `product.images[].id`
  (see the comment in `extract-variant-images.js`).

## License

ISC
