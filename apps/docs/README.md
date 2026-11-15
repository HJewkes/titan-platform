# titan-docs

The titan-platform docs site on `@titan-design/react-ui`. Each route is rendered to static HTML at build time, so a
page reads the same with JavaScript off, and the browser then hydrates it. VitePress (`site/`) stays the live site
until this one covers every page.

```
pnpm --filter titan-docs build   # writes dist/site/<route>/index.html
```

## How the build works

`scripts/build.mjs` runs four steps:

1. A Vite client build of `index.html` and `src/entry-client.tsx` into `dist/client`.
2. A Vite SSR build of `src/entry-server.tsx` into `dist/server`. It inlines react-ui, so the `react-native` to
   `react-native-web` alias reaches react-ui's imports.
3. `scripts/prerender.mjs` renders every route with `renderToString` and fills the client template: the
   react-native-web stylesheet into `<!--app-head-->`, the markup into `<!--app-html-->`, and the route into
   `<!--app-route-->`.
4. `scripts/dist-check.mjs` fails the build on a page with a placeholder left in it or no react-native-web stylesheet.

## Rules for the render tree

Nothing rendered may read the time, the locale, `Math.random` or `window`: the server renders at build time and the
browser hydrates later, and a difference makes React discard the server markup. That is why `DocsShell` passes
`showClock={false}` to `TopBar`. `src/hydration.test.tsx` hydrates the server markup and fails on any recoverable
error.

The client calls `hydrateRoot` itself rather than react-native-web's `AppRegistry`, whose hydrate drops
`onRecoverableError`.
