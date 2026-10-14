import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { readFileSync } from 'fs'
import { createHash } from 'crypto'

const { version } = JSON.parse(readFileSync('./version.json', 'utf8'))

// Shared dev-server + preview-server proxy: routes API/websocket/relay/upload
// traffic to the backend (3001) and Nostr relay (7777) so the browser only
// ever talks to Vite's origin.
const proxy = {
    '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:3001',
        changeOrigin: true,
    },
    '/ws': {
        target: process.env.VITE_API_TARGET?.replace('http', 'ws') || 'ws://localhost:3001',
        ws: true,
    },
    '/relay': {
        target: 'ws://localhost:7777',
        ws: true,
        rewrite: () => '/',
        // Suppress error logging when the local relay is not running
        configure: (p) => {
            p.on('error', () => {});
        },
    },
    '/uploads': {
        target: process.env.VITE_API_TARGET || 'http://localhost:3001',
        changeOrigin: true,
    },
    '/translate': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/translate/, ''),
    },
}

/**
 * A Content-Security-Policy for the app's page, as a <meta> tag: the only kind
 * that also covers the phone app's WebView, and the front proxy (YunoHost)
 * replaces CSP headers. Built pages only: the dev server injects inline
 * scripts of its own. The two inline scripts in index.html are allowed by
 * their hashes; nothing else inline runs. Builds that talk to a local server
 * (the Simulator) may also reach localhost over http/ws.
 */
function contentSecurityPolicy() {
    let local = false
    return {
        name: 'bies-content-security-policy',
        apply: 'build',
        configResolved(config) {
            const targets = [config.env.VITE_API_URL, config.env.VITE_NOSTR_RELAY].filter(Boolean)
            local = targets.some((t) => /^(https?|wss?):\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(t))
        },
        transformIndexHtml: {
            order: 'post',
            handler(html) {
                const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
                    .map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`)
                const dev = local ? ' http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*' : ''
                const policy = [
                    "default-src 'self'",
                    `script-src 'self' ${hashes.join(' ')}`.trim(),
                    "style-src 'self' 'unsafe-inline'",
                    // Any image or video address (old posts have http ones); they can't run code.
                    "img-src * data: blob:",
                    "media-src * data: blob:",
                    "font-src 'self' data:",
                    `connect-src 'self' https: wss:${dev}`,
                    'frame-src https://www.youtube-nocookie.com https://www.youtube.com https://player.vimeo.com',
                    "worker-src 'self' blob:",
                    "manifest-src 'self'",
                    "object-src 'none'",
                    "base-uri 'self'",
                    "form-action 'self'",
                ].join('; ')
                // Right after the charset. If index.html's charset tag changes,
                // fail the build rather than ship without the policy.
                const marker = '<meta charset="UTF-8" />'
                if (!html.includes(marker)) throw new Error(`contentSecurityPolicy: ${marker} not found in index.html`)
                return html.replace(marker, `${marker}\n  <meta http-equiv="Content-Security-Policy" content="${policy}" />`)
            },
        },
    }
}

// https://vitejs.dev/config/
export default defineConfig({
    base: '/',
    define: {
        __APP_VERSION__: JSON.stringify(version),
        __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
    resolve: {
        // Ensure Vite resolves shared dependencies (@scure/base etc.)
        // to a single copy when used by both nostr-tools and @sovit.xyz/keytr.
        dedupe: ['@scure/base'],
    },
    plugins: [
        contentSecurityPolicy(),
        react({
            babel: {
                plugins: ['styled-jsx/babel']
            }
        }),
        nodePolyfills({
            protocolImports: true,
        }),
    ],
    build: {
        // Transpile down to older Safari so the app boots on pre-iOS-16 iPhones.
        target: ['es2019', 'safari13'],
    },
    server: {
        host: true,
        proxy,
    },
    // `vite preview` (serving the production build) needs the same proxy as dev
    // so /api, /ws, /relay and /uploads still reach the backend + relay.
    preview: {
        host: true,
        proxy,
    },
})
