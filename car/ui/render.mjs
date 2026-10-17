// @ts-check

const PRIVATE_KEYS = new Set([
  'body',
  'bodies',
  'content',
  'credentials',
  'headers',
  'messages',
  'prompt',
  'requestBody',
  'secret',
  'token',
]);

/** @param {Document} document @param {string} text @param {string=} className */
export function textBlock(document, text, className) {
  const pre = document.createElement('pre');
  if (className) pre.className = className;
  pre.textContent = text;
  return pre;
}

/** @param {unknown} value @returns {unknown} */
function metadata(value) {
  if (Array.isArray(value)) return value.map(metadata);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !PRIVATE_KEYS.has(key))
      .map(([key, entry]) => [key, metadata(entry)]),
  );
}

/** @param {Document} document @param {unknown} value @param {{metadataOnly?: boolean}=} options */
export function jsonView(document, value, options = {}) {
  const fragment = document.createDocumentFragment();
  if (options.metadataOnly) {
    const notice = document.createElement('p');
    notice.className = 'car-notice';
    notice.textContent =
      'Metadata-only trace: private bodies were not captured; only inspection metadata is displayed.';
    fragment.append(notice);
  }
  fragment.append(
    textBlock(document, JSON.stringify(options.metadataOnly ? metadata(value) : value, null, 2)),
  );
  return fragment;
}

/** @param {Document} document @param {string} value */
export function diffView(document, value) {
  const pre = document.createElement('pre');
  pre.className = 'car-diff';
  pre.setAttribute('aria-label', 'Workspace diff');
  for (const line of value.replaceAll('\r\n', '\n').split('\n')) {
    const row = document.createElement('span');
    row.dataset.kind =
      line.startsWith('+') && !line.startsWith('+++')
        ? 'added'
        : line.startsWith('-') && !line.startsWith('---')
          ? 'removed'
          : 'context';
    row.textContent = `${line}\n`;
    pre.append(row);
  }
  return pre;
}

/** @param {string} encoded @param {number=} maxBytes */
export function decodeArtifact(encoded, maxBytes = 2 * 1024 * 1024) {
  if (encoded.length > Math.ceil(maxBytes / 3) * 4)
    return { ok: false, message: 'Artifact exceeds the 2 MiB viewer limit.' };
  try {
    const binary = atob(encoded);
    if (binary.length > maxBytes)
      return { ok: false, message: 'Artifact exceeds the 2 MiB viewer limit.' };
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    try {
      return {
        ok: true,
        text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        bytes: bytes.length,
      };
    } catch {
      return { ok: false, message: `Binary artifact · ${bytes.length} bytes` };
    }
  } catch {
    return { ok: false, message: 'Artifact payload is not valid base64.' };
  }
}

/** @param {Document} document @param {unknown} value */
export function fileView(document, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return jsonView(document, value);
  const record = /** @type {Record<string, unknown>} */ (value);
  const fragment = document.createDocumentFragment();
  const metadata = document.createElement('p');
  metadata.className = 'car-file-meta';
  metadata.textContent = [
    typeof record.digest === 'string' ? `digest ${record.digest}` : '',
    typeof record.lines === 'number' ? `${record.lines} lines` : '',
    record.truncated === true ? 'truncated' : '',
  ]
    .filter(Boolean)
    .join(' · ');
  if (metadata.textContent) fragment.append(metadata);
  fragment.append(
    typeof record.content === 'string'
      ? textBlock(document, record.content, 'car-file')
      : jsonView(document, value),
  );
  return fragment;
}
