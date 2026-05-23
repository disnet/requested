// Editing requires the in-browser OAuth + DPoP agent to write back to the
// author's PDS. Skipping SSR also keeps the editor (CodeMirror) from trying
// to mount on the Worker.
export const ssr = false;
