import adapter from "@sveltejs/adapter-static";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    // The app is client-rendered (ssr = false), so it ships as a SPA and is
    // served by Workers Static Assets. Deep links resolve via the
    // notFoundHandling = "single-page-application" fallback.
    adapter: adapter({
      pages: "build",
      assets: "build",
      fallback: "index.html",
      precompress: false,
      strict: false,
    }),
    alias: {
      // API types shared with the Worker (pure types only).
      $shared: "../src/shared",
    },
  },
};

export default config;
