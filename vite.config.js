import { defineConfig, loadEnv } from 'vite';
import injectHTML from 'vite-plugin-html-inject';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const viteDomain = env.VITE_DOMAIN || process.env.VITE_DOMAIN;
  const allowedHosts = viteDomain
    ? viteDomain.split(',').map((host) => host.trim()).filter(Boolean)
    : true;

  return {
    root: '.',
    publicDir: 'static',
    plugins: [
      injectHTML(),
      tailwindcss()
    ],
    server: {
      host: '0.0.0.0',
      allowedHosts,
      port: 8621,
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:8500',
          changeOrigin: true,
        },
        '/static/data': {
          target: 'http://127.0.0.1:8500',
          changeOrigin: true,
        },
      },
    },
  };
});