// ABOUTME: Standalone assert-based self-check for the Browser Rendering module's response handling (envelope unwrap + binary screenshot). No network, no creds, no framework. Run: bun run src/tools/browser.check.ts
import { readJsonResult, imageContentFromResponse } from './browser.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

async function expectThrows(fn: () => Promise<unknown>, matching: string, msg: string) {
  try {
    await fn();
  } catch (err) {
    assert(err instanceof Error && err.message.includes(matching), `${msg} (got: ${err})`);
    return;
  }
  throw new Error(`FAIL: ${msg} (no error thrown)`);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// readJsonResult: unwraps a successful Cloudflare envelope to its result.
assert((await readJsonResult(jsonResponse({ success: true, result: '# Hi' }))) === '# Hi', 'unwraps result on success');

// readJsonResult: surfaces the API's error message on success:false.
await expectThrows(
  () => readJsonResult(jsonResponse({ success: false, errors: [{ message: 'bad url' }] })),
  'bad url',
  'throws the API error message',
);

// readJsonResult: surfaces HTTP status when the body carries no usable error.
await expectThrows(() => readJsonResult(jsonResponse({}, 429)), '429', 'throws on non-2xx with status detail');

// imageContentFromResponse: base64-encodes raw image bytes and echoes the content-type.
const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
const img = await imageContentFromResponse(new Response(bytes, { headers: { 'content-type': 'image/png' } }));
assert(img.type === 'image' && img.mimeType === 'image/png', 'returns an image block with the right mime type');
assert(img.data === Buffer.from(bytes).toString('base64'), 'base64-encodes the exact image bytes');

// imageContentFromResponse: a JSON error (not an image) throws rather than returning garbage.
await expectThrows(
  () => imageContentFromResponse(jsonResponse({ success: false, errors: [{ message: 'no browser' }] })),
  'no browser',
  'throws when the screenshot endpoint returns a JSON error',
);

console.log('OK: browser module response handling checks passed');
