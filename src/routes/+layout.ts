// Pure browser app: all data lives on each user's PDS, so no SSR. The
// adapter-static fallback (build/index.html) is the SPA shell for every route.
export const ssr = false;
export const prerender = false;
