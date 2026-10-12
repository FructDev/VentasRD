import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { relative } from 'node:path';

const repository = fileURLToPath(new URL('../../', import.meta.url));
// Impedir que una extracción UI importe accidentalmente backend/stores legado.
function nativeBoundary(): Plugin {
  return {
    name: 'ventard-native-boundary',
    generateBundle() {
      const application: string[] = [];
      for (const moduleId of this.getModuleIds()) {
        const id = relative(repository, moduleId.split('?')[0]).replaceAll('\\', '/');
        if (/node_modules\/(?:next|dexie|dexie-react-hooks|@supabase)\//.test(id)) {
          this.error('NATIVE_BOUNDARY_FORBIDDEN_DEPENDENCY');
        }
        if (id.startsWith('src/') && !['src/components/ui/Pagination.tsx','src/components/ui/Skeleton.tsx'].includes(id)) {
          this.error('NATIVE_BOUNDARY_FORBIDDEN_LEGACY_MODULE');
        }
        if (id.startsWith('apps/pos/src/') || id.startsWith('packages/ui/src/') || id.startsWith('src/')) {
          application.push(id);
        }
      }
      this.emitFile({ type: 'asset', fileName: 'native-boundary.json', source: JSON.stringify({version:1, applicationModules:application.sort()}, null, 2) });
    },
  };
}
const host = process.env.TAURI_DEV_HOST;
export default defineConfig({
  plugins: [react(), tailwind(), nativeBoundary()],
  publicDir: false, // no copiar manifest/SW de la web
  clearScreen: false,
  envPrefix: 'VITE_', // no exponer env del backend por prefijo Next/Tauri indiscriminado
  resolve: { alias:{'@ventard/ui':fileURLToPath(new URL('../../packages/ui/src',import.meta.url))},dedupe: ['react', 'react-dom'] },
  server: {
    port: 1420,
    strictPort: true,
    host: host || '127.0.0.1',
    hmr: host ? {protocol:'ws', host, port:1421} : undefined,
    watch: {ignored:['**/src-tauri/**']},
  },
  build: { target:['chrome105', 'safari15.4'], sourcemap:false },
});
