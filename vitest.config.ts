import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        // A browser without a browser: what the components and hooks run in.
        environment: 'happy-dom',
        include: ['test/**/*.spec.{ts,tsx}'],
        setupFiles: ['test/setup.ts'],
    },
});
