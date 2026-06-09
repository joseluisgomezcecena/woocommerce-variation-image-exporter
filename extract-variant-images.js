#!/usr/bin/env node

/**
 * ============================================================================
 *   WooCommerce Variant Images Export — via WC REST API v3
 * ============================================================================
 *
 * Purpose: walk every variable product in WooCommerce, hit the variations
 *          endpoint for each one, collect variation-level image URLs, write
 *          a CSV ready to be consumed by Matrixify (or similar) to update
 *          variant images on the Shopify side.
 *
 * Requirements:
 *   - Node 18+ (uses native fetch)
 *   - WooCommerce REST API credentials (consumer_key + consumer_secret)
 *     with at least "Read" permissions
 *
 * How to get the credentials:
 *   1. WP Admin -> WooCommerce -> Settings -> Advanced -> REST API
 *   2. "Add key"
 *   3. Description: "Variant images export"
 *      User: your admin user
 *      Permissions: "Read"
 *   4. "Generate API key"
 *   5. Copy BOTH the Consumer key (starts with `ck_`) and the
 *      Consumer secret (starts with `cs_`). You only see the secret once.
 *
 * How to run:
 *   1. npm install            (only `dotenv` and that's optional)
 *   2. cp .env.example .env   (then fill in your values)
 *   3. node extract-variant-images.js
 *   4. Output: variant-images.csv in the current folder
 *
 * Output columns:
 *   variant_sku, image_url, image_alt, product_title, product_handle,
 *   parent_sku, wp_product_id, wp_variation_id
 *
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

// Try to load .env if dotenv is installed; otherwise rely on real env vars.
try { require('dotenv').config(); } catch (_) {}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SITE_URL       = (process.env.WP_SITE_URL || '').replace(/\/$/, '');
const CONSUMER_KEY    = process.env.WC_CONSUMER_KEY || '';
const CONSUMER_SECRET = process.env.WC_CONSUMER_SECRET || '';
const PER_PAGE        = parseInt(process.env.PER_PAGE || '100', 10);
const OUTPUT_FILE     = process.env.OUTPUT_FILE || path.join(__dirname, 'variant-images.csv');
const REQUEST_DELAY_MS = parseInt(process.env.REQUEST_DELAY_MS || '120', 10);
const VERBOSE         = process.env.VERBOSE === '1';
const INCLUDE_PARENT_GALLERY = process.env.INCLUDE_PARENT_GALLERY === '1';

if (!SITE_URL || !CONSUMER_KEY || !CONSUMER_SECRET) {
  console.error('\n[ERROR] Missing required env vars:');
  console.error('  WP_SITE_URL       (e.g. https://yourstore.com)');
  console.error('  WC_CONSUMER_KEY   (starts with ck_)');
  console.error('  WC_CONSUMER_SECRET (starts with cs_)');
  console.error('\nSee .env.example or set them inline:');
  console.error('  WP_SITE_URL=... WC_CONSUMER_KEY=ck_... WC_CONSUMER_SECRET=cs_... node extract-variant-images.js\n');
  process.exit(1);
}

const AUTH_HEADER = 'Basic ' + Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function log(...args)  { console.log(...args); }
function vlog(...args) { if (VERBOSE) console.log('[verbose]', ...args); }

/**
 * Throttled GET against the WC REST API.
 * Retries on 429 / 5xx with exponential backoff.
 */
async function wcGet(endpoint, params = {}, retries = 5) {
  const url = new URL(`${SITE_URL}/wp-json/wc/v3/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }

  let attempt = 0;
  let lastErr;
  while (attempt < retries) {
    try {
      const res = await fetch(url, { headers: { Authorization: AUTH_HEADER, Accept: 'application/json' } });
      if (res.status === 429 || res.status >= 500) {
        const wait = Math.min(30000, 500 * Math.pow(2, attempt));
        vlog(`HTTP ${res.status} on ${url.pathname} — backoff ${wait}ms`);
        await sleep(wait);
        attempt++;
        continue;
      }
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status} on ${url}: ${body.substring(0, 200)}`);
      }
      const totalPages = parseInt(res.headers.get('x-wp-totalpages') || '0', 10) || null;
      const totalItems = parseInt(res.headers.get('x-wp-total') || '0', 10) || null;
      const data = await res.json();
      return { data, totalPages, totalItems };
    } catch (err) {
      lastErr = err;
      const wait = Math.min(30000, 500 * Math.pow(2, attempt));
      vlog(`request error (${err.message}) — backoff ${wait}ms`);
      await sleep(wait);
      attempt++;
    }
  }
  throw lastErr || new Error(`Failed after ${retries} retries: ${url}`);
}

/**
 * CSV cell escaper: wraps in quotes if needed, escapes quotes by doubling.
 */
function csvCell(value) {
  if (value == null) return '';
  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function csvRow(cells) {
  return cells.map(csvCell).join(',') + '\n';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  log(`[start] Site: ${SITE_URL}`);
  log(`[start] Output: ${OUTPUT_FILE}`);
  log(`[start] Throttle: ${REQUEST_DELAY_MS}ms between requests`);
  log('');

  // Prime: fetch variable products page-by-page
  const out = fs.createWriteStream(OUTPUT_FILE, { encoding: 'utf8' });
  out.write(csvRow([
    'variant_sku', 'image_url', 'image_alt',
    'product_title', 'product_handle',
    'parent_sku', 'wp_product_id', 'wp_variation_id'
  ]));

  let totalVariableProducts = 0;
  let totalVariantsWithImage = 0;
  let totalVariantsWithoutImage = 0;
  let totalParentGalleryRows = 0;

  let page = 1;
  let totalPages = null;

  while (true) {
    log(`[page ${page}${totalPages ? '/' + totalPages : ''}] fetching variable products...`);
    const { data: products, totalPages: tp } = await wcGet('products', {
      type: 'variable',
      per_page: PER_PAGE,
      page,
      status: 'publish',
      _fields: 'id,name,slug,sku,images,variations'  // minimize payload
    });
    if (totalPages == null) totalPages = tp;

    if (!Array.isArray(products) || products.length === 0) break;
    totalVariableProducts += products.length;

    for (const product of products) {
      await sleep(REQUEST_DELAY_MS);

      // Optional: emit parent gallery rows (image_url with empty variant_sku)
      // Useful if you also want to capture the product gallery via this script
      // instead of the regular product import path.
      if (INCLUDE_PARENT_GALLERY && Array.isArray(product.images)) {
        for (const img of product.images) {
          if (img && img.src) {
            out.write(csvRow([
              '',                  // empty variant_sku = product-level image
              img.src,
              img.alt || '',
              product.name,
              product.slug,
              product.sku || '',
              product.id,
              ''                   // no variation id for product-level images
            ]));
            totalParentGalleryRows++;
          }
        }
      }

      // Fetch all variations for this product (might span multiple pages)
      const variationIds = Array.isArray(product.variations) ? product.variations : [];
      vlog(`  ${product.name} (id=${product.id}, ${variationIds.length} variants)`);

      let vPage = 1;
      while (true) {
        const { data: variations, totalPages: vTotalPages } = await wcGet(
          `products/${product.id}/variations`,
          { per_page: PER_PAGE, page: vPage, _fields: 'id,sku,image' }
        );
        if (!Array.isArray(variations) || variations.length === 0) break;

        for (const v of variations) {
          const sku = v.sku || '';
          const img = v.image || {};
          if (!sku) {
            vlog(`    skip variation id=${v.id} (no SKU)`);
            continue;
          }
          if (!img.src) {
            totalVariantsWithoutImage++;
            vlog(`    skip variation sku=${sku} (no image)`);
            continue;
          }
          // WC sometimes returns parent gallery's first image as the variation's
          // image when no explicit variation image is set. We can't reliably
          // detect this without comparing IDs against the parent gallery. If
          // that becomes a problem, add a filter here: skip if img.id is in
          // product.images[].id.
          out.write(csvRow([
            sku, img.src, img.alt || '',
            product.name, product.slug,
            product.sku || '',
            product.id, v.id
          ]));
          totalVariantsWithImage++;
        }

        if (vTotalPages && vPage >= vTotalPages) break;
        if (variations.length < PER_PAGE) break;
        vPage++;
        await sleep(REQUEST_DELAY_MS);
      }
    }

    if (totalPages && page >= totalPages) break;
    if (products.length < PER_PAGE) break;
    page++;
  }

  out.end();

  log('');
  log('========================================');
  log(`  Variable products processed:    ${totalVariableProducts}`);
  log(`  Variants WITH image:            ${totalVariantsWithImage}`);
  log(`  Variants WITHOUT image:         ${totalVariantsWithoutImage}`);
  if (INCLUDE_PARENT_GALLERY) {
    log(`  Parent gallery rows:            ${totalParentGalleryRows}`);
  }
  log(`  Output:                         ${OUTPUT_FILE}`);
  log('========================================');
}

main().catch(err => {
  console.error('\n[FATAL]', err);
  process.exit(1);
});
