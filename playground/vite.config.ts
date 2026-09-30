import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The package from src/, not a build: an edit shows up at once.
export default defineConfig({
    root: fileURLToPath(new URL('.', import.meta.url)),
    plugins: [react()],
    resolve: {
        alias: { '@mesub/react': fileURLToPath(new URL('../src/index.ts', import.meta.url)) },
    },
    server: { port: 5173, strictPort: true },
});
