import { defineConfig } from 'vitepress';

// VitePress site for factory. Reuses the existing repo markdown
// (README.md, ARCHITECTURE.md, CONTRIBUTING.md, SECURITY.md, docs/*)
// as the source of truth — this config only adds nav/sidebar wiring.
//
// Build: `npm --prefix .vitepress run build` produces .vitepress/dist/,
// which the GH Action publishes to GitHub Pages at
// https://vilaca.github.io/factory/.
export default defineConfig({
  // GH Pages serves the site under /factory/. Both the dev server and
  // the built site must know this so internal links resolve correctly.
  base: '/factory/',
  title: 'factory',
  description:
    'A terminal-first coding agent. Self-hosted, provider-agnostic, configurable.',
  cleanUrls: true,
  lastUpdated: true,
  // README links to relative paths like ./docs/providers.md and
  // ./ARCHITECTURE.md. VitePress follows those at build time. The few
  // exceptions — links to LICENSE (not markdown, served as a GitHub
  // file), localhost, and similar — get ignored here rather than
  // rewritten in the source README.
  ignoreDeadLinks: [
    // LICENSE is a plain-text file, not a markdown page. README's
    // "see LICENSE" link is valid on GitHub but VitePress can't render
    // it as a page. Users land on the GitHub copy either way.
    /^\.?\/LICENSE$/i,
    /^https?:\/\/localhost/,
  ],
  // README is the landing page; the rest hangs off the sidebar.
  rewrites: {
    'README.md': 'index.md',
  },
  // Skip files VitePress shouldn't try to render as pages.
  srcExclude: [
    'node_modules/**',
    'dist/**',
    'dist-test/**',
    'coverage/**',
    'src/**',
    'test/**',
    'scripts/**',
    'CHANGELOG.md',
    'IDEAS.md',
  ],
  themeConfig: {
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Quick start', link: '/#quick-start' },
      { text: 'Docs', link: '/docs/configuration' },
      { text: 'Architecture', link: '/ARCHITECTURE' },
      { text: 'GitHub', link: 'https://github.com/vilaca/factory' },
    ],
    sidebar: [
      {
        text: 'Getting started',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'Configuration', link: '/docs/configuration' },
          { text: 'Providers', link: '/docs/providers' },
          { text: 'Troubleshooting', link: '/docs/troubleshooting' },
        ],
      },
      {
        text: 'Usage',
        items: [
          { text: 'Slash commands', link: '/docs/slash-commands' },
          { text: 'Hotkeys', link: '/docs/hotkeys' },
          { text: 'Headless mode', link: '/docs/headless' },
          { text: 'WebFetch tool', link: '/docs/web-fetch' },
          { text: 'Sampling params', link: '/docs/sampling-params' },
        ],
      },
      {
        text: 'Operations',
        items: [
          { text: 'Security', link: '/docs/security' },
          { text: 'Observability', link: '/docs/observability' },
          { text: 'Picker internals', link: '/docs/picker-internals' },
        ],
      },
      {
        text: 'Project',
        items: [
          { text: 'Architecture', link: '/ARCHITECTURE' },
          { text: 'Contributing', link: '/CONTRIBUTING' },
          { text: 'Security policy', link: '/SECURITY' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/vilaca/factory' },
    ],
    editLink: {
      pattern: 'https://github.com/vilaca/factory/edit/main/:path',
      text: 'Edit this page on GitHub',
    },
    search: {
      provider: 'local',
    },
    footer: {
      message: 'Released under the Apache-2.0 License.',
      copyright: 'Copyright © vilaca',
    },
  },
});
