// Home is the sign-in form (signed-out) or the user's document list
// (signed-in). Both states depend on the in-browser OAuth client, so this
// route stays client-only even in the SSR build.
export const ssr = false;
