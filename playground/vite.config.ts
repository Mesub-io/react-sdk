import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The package from src/, not a build: an edit shows up at once.
export default defineConfig({
    root: fileURLToPath(new URL('.', import.meta.url)),
    plugins: [react()],
    resolve: {
        alias: [
            {
                find: /^@mesub\/react$/,
                replacement: fileURLToPath(new URL('../src/index.ts', import.meta.url)),
            },
            {
                find: '@mesub/react/styles.css',
                replacement: fileURLToPath(new URL('../styles.css', import.meta.url)),
            },
        ],
    },
    server: {
        port: 5173,
        strictPort: true,
        // The merchant's server, on the page's own origin: its cookie travels with the widget's calls.
        proxy: { '/api': process.env['PLAYGROUND_SERVER'] ?? 'http://localhost:5174' },
    },
});
