// @ts-check

/** @param {string} text */
function escapeHTML(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * @param {{
 * authorizationURL?: string, pending: boolean,
 * account?: string, plan: boolean,
 * models?: readonly {id: string, name: string}[], message?: string, reply?: string
 * }} view
 */
export function page(view) {
  const account = view.account && escapeHTML(view.account);
  const authorizationURL = view.authorizationURL && escapeHTML(view.authorizationURL);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in with ChatGPT · part</title>
  <style>
    :root { color-scheme: light dark; font: 16px/1.55 system-ui, sans-serif; }
    body { margin: 0; background: Canvas; color: CanvasText; }
    main { max-width: 640px; margin: clamp(2.5rem, 9vw, 6rem) auto; padding: 0 1.25rem; }
    h1 { font-size: clamp(1.9rem, 6vw, 3rem); line-height: 1.12; letter-spacing: -.045em; margin: 0 0 1.5rem; }
    h2 { font-size: 1rem; margin: 0 0 .75rem; }
    section { padding: 1.3rem; border: 1px solid color-mix(in srgb, CanvasText 22%, Canvas); border-radius: 14px; margin: 1rem 0; }
    p { margin: 0 0 .9rem; }
    form { display: grid; gap: .6rem; margin: .75rem 0 0; }
    label { font-weight: 650; }
    input, select, textarea { font: inherit; border: 1px solid GrayText; background: Field; color: FieldText; border-radius: 8px; padding: .65rem; min-width: 0; }
    button, .button { font: inherit; font-weight: 650; background: CanvasText; color: Canvas; border: 1px solid CanvasText; text-decoration: none; border-radius: 8px; padding: .55rem 1rem; width: fit-content; cursor: pointer; display: inline-block; }
    .secondary { margin-top: .8rem; display: inline-block; }
    .message { padding: .7rem 1rem; border-inline-start: 3px solid GrayText; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; margin-bottom: 0; }
    :focus-visible { outline: 3px solid Highlight; outline-offset: 3px; }
  </style>
</head>
<body>
  <main>
    <h1>Sign in with ChatGPT</h1>
    ${view.message ? `<p class="message" role="status">${escapeHTML(view.message)}</p>` : ''}
    <section aria-label="ChatGPT account">
      ${account ? `<p>Signed in as <strong>${account}</strong></p>` : ''}
      ${
        authorizationURL
          ? `
        <p><a class="button" data-oai-siwc-button href="${authorizationURL}" target="_blank" rel="noreferrer noopener">Open ChatGPT sign-in</a></p>
        <p>If the callback tab shows a connection error, copy its full address and paste it below.</p>
        <form method="post" action="/callback" autocomplete="off">
          <label for="callbackURL">Callback URL</label>
          <input id="callbackURL" name="callbackURL" type="url" required spellcheck="false" placeholder="http://127.0.0.1:…/auth/callback?…" />
          <button type="submit">Complete sign-in</button>
        </form>
        <a class="secondary" href="/">Check sign-in status</a>
      `
          : view.pending
            ? '<p>Preparing sign-in…</p><a href="/">Check sign-in status</a>'
            : view.plan
              ? ''
              : `<form method="post" action="/signin"><button type="submit">${account ? 'Authorize ChatGPT plan' : 'Continue with ChatGPT'}</button></form>`
      }
    </section>
    ${
      view.plan && !view.pending
        ? `
      <section aria-label="ChatGPT plan">
        <h2>Try a model</h2>
        <form method="post" action="/models"><button type="submit">Load models</button></form>
        ${
          view.models?.length
            ? `
          <form method="post" action="/ask">
            <label for="model">Model</label>
            <select name="model" id="model">
              ${view.models.map(({ id, name }) => `<option value="${escapeHTML(id)}">${escapeHTML(name)}</option>`).join('')}
            </select>
            <label for="prompt">Prompt</label>
            <textarea id="prompt" name="prompt" rows="3" maxlength="2000" required>Say hello.</textarea>
            <button type="submit">Send prompt</button>
          </form>
        `
            : ''
        }
        ${view.reply !== undefined ? `<pre aria-label="Model reply">${escapeHTML(view.reply)}</pre>` : ''}
      </section>
    `
        : ''
    }
  </main>
</body>
</html>`;
}
