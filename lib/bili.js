/** Bilibili metadata and subtitle access. */

import { getJson, throwIfAborted } from './util.js'

const VIEW_URL = 'https://api.bilibili.com/x/web-interface/view'
const PLAYER_URL = 'https://api.bilibili.com/x/player/v2'

/**
 * Parse a Bilibili link, BV id or av id into its identity and optional part
 * number.
 * @param {string} input user-supplied link or identifier.
 * @returns {{bvid: string, aid: number, page: number | null}}
 */
export function parseBilibiliInput(input) {
  const raw = String(input ?? '').trim()
  if (raw.length === 0) throw new Error('请给出 B 站视频链接或 BV 号')
  const bv = raw.match(/BV[0-9A-Za-z]{10}/)
  const av = raw.match(/(?:^|\/|av)(\d{1,12})(?:$|[/?&#])/i)
  let page = null
  const pageMatch = raw.match(/[?&#]p=(\d+)/)
  if (pageMatch) page = Number(pageMatch[1])
  if (bv) return { bvid: bv[0], aid: 0, page }
  if (av) return { bvid: '', aid: Number(av[1]), page }
  throw new Error(`无法从 "${raw.slice(0, 80)}" 中识别 BV 号或 av 号；请粘贴完整的 B 站视频链接`)
}

/**
 * Fetch video metadata and its part list.
 * @param {{bvid: string, aid: number}} identity
 * @param {{signal?: AbortSignal}} options
 */
export async function fetchVideo(identity, { signal } = {}) {
  const query = identity.bvid
    ? `bvid=${encodeURIComponent(identity.bvid)}`
    : `aid=${encodeURIComponent(String(identity.aid))}`
  const payload = await getJson(`${VIEW_URL}?${query}`, { signal })
  if (payload?.code !== 0) {
    throw new Error(`B 站接口返回错误 ${payload?.code}: ${payload?.message ?? '未知错误'}`)
  }
  const data = payload.data
  throwIfAborted(signal)
  return {
    bvid: data.bvid,
    aid: data.aid,
    title: String(data.title ?? '').trim(),
    desc: String(data.desc ?? '').trim(),
    owner: String(data.owner?.name ?? '').trim(),
    pubdate: Number(data.pubdate ?? 0),
    duration: Number(data.duration ?? 0),
    pic: String(data.pic ?? ''),
    url: `https://www.bilibili.com/video/${data.bvid}`,
    pages: (Array.isArray(data.pages) ? data.pages : []).map(page => ({
      index: Number(page.page),
      cid: Number(page.cid),
      title: String(page.part ?? '').trim(),
      duration: Number(page.duration ?? 0),
    })),
  }
}

/**
 * Pick the part list allowed by a `pages` selector.
 * @param {Array<{index: number, title: string, duration: number}>} pages
 * @param {string | undefined} selector `all`, `1`, `1-3`, `1,3,5`; omitted means
 *   every part of a single-part video and the first part otherwise.
 * @returns {Array<{index: number, title: string, duration: number}>}
 */
export function selectPages(pages, selector) {
  const list = pages.length > 0 ? pages : [{ index: 1, cid: 0, title: '', duration: 0 }]
  const requested = String(selector ?? '').trim().toLowerCase()
  if (requested === '' || requested === 'auto') {
    return list.length === 1 ? list : [list[0]]
  }
  if (requested === 'all' || requested === '全部') return [...list]
  const wanted = new Set()
  for (const item of requested.split(/[,，\s]+/).filter(Boolean)) {
    const range = item.match(/^(\d+)\s*[-~到]\s*(\d+)$/)
    if (range) {
      const start = Number(range[1])
      const end = Number(range[2])
      for (let index = Math.min(start, end); index <= Math.max(start, end); index++) wanted.add(index)
      continue
    }
    if (/^\d+$/.test(item)) {
      wanted.add(Number(item))
      continue
    }
    throw new Error(`无法识别的分 P 选择 "${item}"；可用 "1"、"1-3"、"1,3,5" 或 "all"`)
  }
  const selected = list.filter(page => wanted.has(page.index))
  if (selected.length === 0) {
    throw new Error(`没有找到分 P ${[...wanted].sort((a, b) => a - b).join(', ')}；该视频只有 ${list.length} 个分 P`)
  }
  return selected
}

/**
 * Fetch the subtitle track of one part, if the uploader or Bilibili provides
 * one. Returns `null` when no Chinese-capable subtitle exists.
 * @param {{bvid: string, cid: number}} video
 * @param {{signal?: AbortSignal}} options
 * @returns {Promise<null | {language: string, segments: Array<{start: number, end: number, text: string}>}>}
 */
export async function fetchSubtitle(video, { signal } = {}) {
  const query = `bvid=${encodeURIComponent(video.bvid)}&cid=${encodeURIComponent(String(video.cid))}`
  const payload = await getJson(`${PLAYER_URL}?${query}`, { signal })
  if (payload?.code !== 0) return null
  const subtitles = payload?.data?.subtitle?.subtitles
  if (!Array.isArray(subtitles) || subtitles.length === 0) return null
  const preferred = subtitles.find(item => /zh|ai-zh|中文/i.test(String(item.lan ?? ''))) ?? subtitles[0]
  const url = String(preferred.subtitle_url ?? '')
  if (!url) return null
  const absolute = url.startsWith('//') ? `https:${url}` : url
  const body = await getJson(absolute, { signal })
  const rows = Array.isArray(body?.body) ? body.body : []
  const segments = rows
    .map(row => ({
      start: Number(row.from ?? 0),
      end: Number(row.to ?? 0),
      text: String(row.content ?? '').replace(/\s+/g, ' ').trim(),
    }))
    .filter(row => row.text.length > 0)
  if (segments.length === 0) return null
  return { language: String(preferred.lan_doc ?? preferred.lan ?? '中文'), segments }
}
