/** Small shared helpers: HTTP, text, filenames, time formatting. */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** Milliseconds since epoch helper. */
export function now() { return Date.now() }

/** Throw the abort reason when the signal is already aborted. */
export function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
}

/**
 * Fetch a URL and decode it as JSON.
 * @param {string} url absolute http(s) URL.
 * @param {{signal?: AbortSignal, headers?: Record<string, string>, timeoutMs?: number}} [options]
 * @returns {Promise<any>}
 */
export async function getJson(url, options = {}) {
  const { signal, headers = {}, timeoutMs = 20_000 } = options
  const timeout = AbortSignal.timeout(timeoutMs)
  const composite = signal ? AbortSignal.any([signal, timeout]) : timeout
  const response = await fetch(url, {
    signal: composite,
    headers: {
      'User-Agent': UA,
      'Referer': 'https://www.bilibili.com/',
      'Accept': 'application/json, text/plain, */*',
      ...headers,
    },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`response is not JSON: ${text.slice(0, 160)}`)
  }
}

/**
 * Format a number of seconds as `m:ss` or `h:mm:ss`.
 * @param {number} seconds
 * @returns {string}
 */
export function clock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

/** Human duration such as `15 分 41 秒`. */
export function humanDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  if (total < 60) return `${total} 秒`
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h} 小时 ${m} 分`
  return s === 0 ? `${m} 分` : `${m} 分 ${s} 秒`
}

/**
 * Remove characters that are illegal in a file name and bound the length.
 * @param {string} name
 * @param {number} [maxLength]
 * @returns {string}
 */
export function safeFileName(name, maxLength = 80) {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (cleaned || '未命名').slice(0, maxLength).trim()
}

/**
 * Split long text into chunks no larger than `size` characters, preferring
 * paragraph boundaries.
 * @param {string} text
 * @param {number} size
 * @returns {string[]}
 */
export function chunkText(text, size) {
  const source = String(text ?? '')
  if (source.length <= size) return [source]
  const paragraphs = source.split(/\n{2,}/)
  const chunks = []
  let current = ''
  for (const paragraph of paragraphs) {
    if (paragraph.length > size) {
      if (current.length > 0) {
        chunks.push(current)
        current = ''
      }
      for (let index = 0; index < paragraph.length; index += size) {
        chunks.push(paragraph.slice(index, index + size))
      }
      continue
    }
    if (current.length + paragraph.length + 2 > size) {
      chunks.push(current)
      current = ''
    }
    current += (current.length > 0 ? '\n\n' : '') + paragraph
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/** Sleep for a bounded delay. */
export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'))
    const timer = setTimeout(() => { cleanup(); resolve() }, ms)
    const onAbort = () => { cleanup(); reject(signal.reason ?? new Error('aborted')) }
    function cleanup() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Quote one line for a log-style message. */
export function indent(text, prefix = '  ') {
  return String(text ?? '').split('\n').map(line => prefix + line).join('\n')
}
