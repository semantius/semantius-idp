import { defineConfig } from "vite"
import { devtools } from "@tanstack/devtools-vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const config = defineConfig(({ command }) => ({
  // Relative **for the build only**, so one build relocates to any mount path
  // (OPS-10, spike S3): chunk-to-chunk imports resolve from `import.meta.url`
  // and CSS `url()` references from the stylesheet, instead of from the host
  // root. The two URLs this does *not* fix — the SSR manifest and `?url`
  // imports — are pinned to the runtime mount path in `src/server-entry.ts`
  // and `src/lib/base-path.ts`.
  //
  // **Never in dev.** Vite 8 stopped coercing a relative base to `/` for the
  // dev server, and now prefixes every transform URL with `/./`. A real path
  // survives that (`/./src/router.tsx` still resolves against the root), but
  // Vite's own internal URLs are matched by their `/@…` prefix and do not:
  // `/./@fs/…`, `/./@id/…` and `/./@vite/client` all resolve to null. The page
  // still server-renders, so nothing errors — it just arrives with no
  // stylesheet, no client entry and no HMR. That is the unbranded sign-in page.
  base: command === "build" ? "./" : "/",
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    tailwindcss(),
    tanstackStart({
      // Explicit entry names: `src/server/` is the server *code* tree, so a
      // `src/server.ts` entry beside it would read as part of it.
      start: { entry: "start-entry" },
      server: { entry: "server-entry" },
      // Held at the root on purpose. The router basepath is a runtime value
      // (`src/router.tsx`); leaving this unset would derive it from `base`
      // above and bake `.` into the router *and* the server-function base.
      router: { basepath: "/" },
    }),
    viteReact(),
  ],
}))

export default config
