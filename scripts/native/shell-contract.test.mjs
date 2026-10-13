import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const json = (p) => JSON.parse(read(p));

test('shell usa Tauri 2 estable y core exclusivamente cifrado', () => {
  const pkg = json('apps/pos/package.json');
  assert.match(pkg.devDependencies?.['@tauri-apps/cli'] ?? '', /^2\.\d+\.\d+$/);
  assert.match(read('apps/pos/src-tauri/Cargo.toml'), /tauri = \{ version = "=2\./);
  assert.match(read('apps/pos/src-tauri/Cargo.toml'), /features = \["encrypted-storage"\]/);
  assert.doesNotMatch(read('apps/pos/src-tauri/Cargo.toml'), /fixture-storage|3\.0.*alpha/);
});
test('assets empaquetados no apuntan a Next, Vercel ni production', () => {
  const c = json('apps/pos/src-tauri/tauri.conf.json');
  assert.equal(c.$schema, 'https://schema.tauri.app/config/2');
  assert.equal(c.build.frontendDist, '../dist');
  assert.equal(c.build.devUrl, 'http://127.0.0.1:1420');
  assert.equal(c.app.withGlobalTauri, false);
  assert.equal(c.app.windows[0].create, false, 'window construida con navigation guard nativo');
  assert.doesNotMatch(JSON.stringify(c), /ventard\.vercel|supabase\.co|next dev/);
});
test('capabilities limitadas a ventana local, sin SQL/files/shell/red', () => {
  const c = json('apps/pos/src-tauri/capabilities/pos.json');
  assert.deepEqual(c.windows, ['main']);
  assert.deepEqual(c.permissions, ['allow-qa-read','allow-qa-create','allow-qa-sell','allow-qa-result','allow-qa-quote','allow-qa-sale-abandon','allow-qa-sale-ticket','allow-qa-history-read','allow-qa-product-save','allow-qa-stock-adjust','allow-qa-cart-save','allow-qa-cart-action','allow-native-access-status','allow-native-access-login','allow-native-access-provision','allow-native-access-pin','allow-native-access-lock','allow-native-catalogue-download','allow-native-catalogue-read','allow-native-cart-read','allow-native-cart-save','allow-native-cart-action','allow-native-catalogue-quote','allow-native-cash-read','allow-native-history-read','allow-native-history-ticket','allow-native-fiscal-read','allow-native-fiscal-prepare','allow-native-sales','allow-native-backup']);
  assert.equal(c.local, true);
  assert.equal(c.remote, undefined);
  const config = json('apps/pos/src-tauri/tauri.conf.json');
  const csp = config.app.security.csp;
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-eval|https:|\*/);
  assert.equal(config.app.security.dangerousDisableAssetCspModification, undefined);
});
test('UI reutilizada es el componente original, no una copia divergentemente editada', () => {
  assert.match(read('packages/ui/src/pagination.tsx'), /src\/components\/ui\/Pagination/);
  assert.match(read('apps/pos/src/features/catalog/inventory-page.tsx'), /@ventard\/ui\/pagination/);
  for (const p of ['apps/pos/src/app/router.tsx', 'apps/pos/src/main.tsx']) {
    assert.doesNotMatch(read(p), /next\/|dexie|supabase|indexedDB|localStorage|serviceWorker/);
  }
});
test('Vite aislado, puerto fijo y bundle con frontera auditable', () => {
  const vite = read('apps/pos/vite.config.ts');
  assert.match(vite, /strictPort: true/);
  assert.match(vite, /publicDir: false/);
  assert.match(vite, /nativeBoundary/);
  assert.doesNotMatch(vite, /VitePWA|NEXT_PUBLIC|dotenv/);
  assert.equal(existsSync(fileURLToPath(new URL('apps/pos/src/main.tsx', root))), true);
});
test('web y nativo tienen typecheck independiente sin ignorar errores', () => {
  assert.ok(json('tsconfig.json').exclude.includes('apps/pos'));
  const c = json('apps/pos/tsconfig.json');
  assert.equal(c.compilerOptions.strict, true);
  assert.equal(c.compilerOptions.noEmit, true);
  assert.equal(c.compilerOptions.plugins, undefined);
});
