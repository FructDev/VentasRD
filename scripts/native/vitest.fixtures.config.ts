import { defineConfig } from 'vitest/config';
import path from 'path';

/** Config aislada para generar/verificar fixtures de caracterización legacy
 * (feature 003). No altera la suite principal (`vitest.config.ts`). */
export default defineConfig({
    resolve: {
        alias: { '@': path.resolve(__dirname, '../../src') },
    },
    test: {
        include: ['scripts/native/**/*.fixture.ts'],
        environment: 'node',
    },
});
