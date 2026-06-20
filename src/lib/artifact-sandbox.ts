/**
 * Security primitives for rendering model-generated artifact HTML.
 *
 * Artifact HTML is UNTRUSTED (written by the model). It is rendered ONLY inside
 * an iframe with `sandbox=ARTIFACT_SANDBOX` (scripts allowed for interactivity,
 * but NO `allow-same-origin`, so it runs in an opaque origin and cannot touch
 * CodePilot's cookies/localStorage/DOM) and with ARTIFACT_CSP injected to block
 * all external network access. Keep this logic here, pure and unit-tested,
 * separate from the React component.
 */

/** iframe sandbox tokens. MUST NOT include `allow-same-origin`. */
export const ARTIFACT_SANDBOX = 'allow-scripts';

/** Content-Security-Policy that blocks every external network request. */
export const ARTIFACT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:";

/** Wrap raw artifact html with a CSP <meta> so the sandbox blocks external network. */
export function withCsp(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => `${m}${meta}`);
  }
  return `<!DOCTYPE html><html><head>${meta}</head><body>${html}</body></html>`;
}
