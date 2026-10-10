import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { config } from 'dotenv';
import { resolve } from 'path';
import Icons from 'unplugin-icons/vite';
import Components from 'unplugin-vue-components/vite';
import IconsResolver from 'unplugin-icons/resolver';
import { createBuildInfo, writeBuildProvenance } from '../../scripts/extension-artifacts.mjs';

config({ path: resolve(process.cwd(), '.env') });
config({ path: resolve(process.cwd(), '.env.local') });

const CHROME_EXTENSION_KEY = process.env.CHROME_EXTENSION_KEY;
// Detect dev mode early for manifest-level switches
const IS_DEV = process.env.NODE_ENV !== 'production' && process.env.MODE !== 'production';

const buildInfo = createBuildInfo({
  repoRoot: resolve(__dirname, '../..'),
});

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  hooks: {
    'build:publicAssets': (_wxt, files) => {
      for (let index = files.length - 1; index >= 0; index--) {
        if (/\.md$/i.test(files[index].relativeDest)) files.splice(index, 1);
      }
    },
    'build:done': async (wxt) => {
      writeBuildProvenance(wxt.config.outDir, buildInfo);
    },
  },
  webExt: {
    // Option 1: Disable auto-open (recommended)
    disabled: true,

    // Option 2: To enable auto-open with existing profile, uncomment below
    // chromiumArgs: [
    //   '--user-data-dir=' + homedir() + (process.platform === 'darwin'
    //     ? '/Library/Application Support/Google/Chrome'
    //     : process.platform === 'win32'
    //     ? '/AppData/Local/Google/Chrome/User Data'
    //     : '/.config/google-chrome'),
    //   '--remote-debugging-port=9222',
    // ],
  },
  manifest: {
    // Use environment variable for the key, fallback to undefined if not set
    key: CHROME_EXTENSION_KEY,
    name: 'browserpaw',
    description: 'Control your own browser with Agent.',
    permissions: [
      'nativeMessaging',
      'tabs',
      'activeTab',
      'scripting',
      'downloads',
      'webRequest',
      'webNavigation',
      'debugger',
      'storage',
      'tabGroups',
      'bookmarks',
      'history',
      'cookies',
    ],
    host_permissions: ['<all_urls>'],
    action: {
      default_popup: 'popup.html',
      default_title: 'browserpaw',
      default_icon: {
        '16': 'icon/16.png',
        '32': 'icon/32.png',
        '48': 'icon/48.png',
        '128': 'icon/128.png',
      },
    },
    web_accessible_resources: [
      {
        resources: [
          '/inject-scripts/*', // Helper scripts accessible for content script injection
          '/images/*',
        ],
        matches: ['<all_urls>'],
      },
    ],
    content_security_policy: {
      // S1: 'unsafe-inline' removed from style-src - the built popup uses an
      // external stylesheet (assets/*.css) and Vue patches style via
      // CSSOM (style.setProperty), which does not need inline style elements.
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; style-src 'self'; img-src 'self' data: blob:;",
    },
  },
  vite: (env) => ({
    define: {
      __BROWSERPAW_BUILD_ID__: JSON.stringify(buildInfo.buildId),
    },
    plugins: [
      // TailwindCSS v4 Vite plugin – no PostCSS config required
      tailwindcss(),
      // Auto-register SVG icons as Vue components; all icons are bundled locally
      Components({
        dts: false,
        resolvers: [IconsResolver({ prefix: 'i', enabledCollections: ['lucide', 'mdi', 'ri'] })],
      }) as any,
      Icons({ compiler: 'vue3', autoInstall: false }) as any,
      // Ensure static assets are available as early as possible to avoid race conditions in dev
      // Copy _locales/inject-scripts into the build output before other steps
      viteStaticCopy({
        targets: [
          {
            src: 'inject-scripts/*.js',
            dest: 'inject-scripts',
          },
        ],
        // Use writeBundle so outDir exists for dev and prod
        hook: 'writeBundle',
        // Enable watch so changes to these files are reflected during dev
        watch: {
          // Use default patterns inferred from targets; explicit true enables watching
          // Vite plugin will watch src patterns and re-copy on change
        } as any,
      }) as any,
    ],
    build: {
      // Target ES6 compatibility for build outputs
      target: 'es2015',
      // Generate sourcemaps in non-production environments
      sourcemap: env.mode !== 'production',
      // Disable gzip size reporting to prevent slow compression on large bundles
      reportCompressedSize: false,
      // Warn when chunk size exceeds 1500kb
      chunkSizeWarningLimit: 1500,
      minify: false,
    },
  }),
});
