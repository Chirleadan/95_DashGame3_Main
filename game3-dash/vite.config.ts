import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  esbuild: {
    drop: mode === 'production' ? ['debugger'] : [],
    pure:
      mode === 'production'
        ? ['console.log', 'console.debug', 'console.info']
        : [],
  },
}));
