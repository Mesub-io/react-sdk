import { defineConfig } from 'tsup';

/**
 * ESM and CJS, with declaration files. React is the merchant's own copy,
 * never bundled: two Reacts in one page break hooks.
 */
export default defineConfig({
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    // tsup sets `baseUrl` for its declaration build, which TypeScript 6 refuses.
    dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
    clean: true,
    sourcemap: true,
    target: 'es2022',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    // Everything here runs in the browser: without the directive, Next's App
    // Router treats an import from this package as a server component.
    banner: { js: "'use client';" },
});
