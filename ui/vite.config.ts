import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// One self-contained HTML file, written into the plugin, which embeds it and serves it as its page
// in the panel. The plugin keeps a placeholder there, so the folder is not emptied.
export default defineConfig({
  plugins: [react(), viteSingleFile({ removeViteModuleLoader: true })],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  css: {
    modules: {
      localsConvention: 'camelCase',
      generateScopedName: '[name]__[local]___[hash:base64:5]',
    },
    preprocessorOptions: {
      scss: { additionalData: `@use "@/styles/variables.scss" as *;` },
    },
  },
  build: {
    target: 'es2020',
    outDir: '../plugin/page',
    emptyOutDir: false,
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 100000000,
    cssCodeSplit: false,
    rolldownOptions: { output: { codeSplitting: false } },
  },
});
