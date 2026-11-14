import { defineConfig } from "astro/config";

// Static output: `npm run build` writes plain files to dist/. Every page is a folder with an index.html,
// so the addresses are /idea, /try, /numbers, /maths and /faq (no ".html").
// Hosting at a sub-path (for example GitHub Pages project sites at /worgl/)? Set `base: "/worgl"` here.
export default defineConfig({
  output: "static",
  build: { format: "directory" },
  trailingSlash: "ignore",
  devToolbar: { enabled: false },
});
