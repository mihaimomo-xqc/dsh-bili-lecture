/** The `bili_lecture` tool: Bilibili link -> transcript -> summary -> .docx. */

import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import { fetchSubtitle, fetchVideo, parseBilibiliInput, selectPages } from './bili.js'
import { downloadAudio, findExecutable, resolvePython, toWav, transcribe } from './asr.js'
import { buildHandout, resolveSelection } from './llm.js'
import { buildDocx } from './docx.js'
import { clock, humanDuration, safeFileName, throwIfAborted } from './util.js'

const KINDS = ['讲义', '摘要', 'SOP', '操作流程']

const DEFAULT_CONFIG = {
  pythonPath: '',
  ffmpegPath: '',
  whisperModel: 'large-v3-turbo',
  whisperThreads: 0,
  cacheDir: '',
}

/**
 * Create the tool definition bound to one plugin context.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, any>} rawConfig
 */
export function createBiliLectureTool(ctx, rawConfig) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig ?? {}) }

  return {
    name: 'bili_lecture',
    description:
      '把 B 站视频链接变成一份中文 Word 文档：讲义、摘要、SOP 或操作流程。'
      + '自动提取字幕或本地语音转写，用当前会话模型总结，并在文档开头说明这条视频是什么、用来干什么、能解决什么问题。'
      + '耗时随视频时长增长（语音转写约需 1–2 倍视频时长）。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'B 站视频链接、BV 号或 av 号，可带 ?p=2 指定分 P。',
        },
        kind: {
          type: 'string',
          enum: KINDS,
          default: '讲义',
          description: '生成哪种文档，默认「讲义」。',
        },
        pages: {
          type: 'string',
          description: '要处理的分 P：如 "1"、"1-3"、"1,3,5" 或 "all"。默认单 P 视频取该 P，多 P 视频取 P1。',
        },
        outputDir: {
          type: 'string',
          description: '输出目录，相对于当前工作目录，默认按类型建目录（如「讲义」）。',
        },
        model: {
          type: 'string',
          description: '可选，覆盖生成所用模型，格式 provider/model 或模型名；默认跟随当前会话模型。',
        },
      },
      required: ['url'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string', description: '生成文件的绝对路径。' },
          relativeFile: { type: 'string', description: '相对于工作目录的路径。' },
          title: { type: 'string' },
          bvid: { type: 'string' },
          kind: { type: 'string' },
          pages: { type: 'array', items: { type: 'string' } },
          durationSeconds: { type: 'integer' },
          transcriptSource: { type: 'string' },
          transcriptChars: { type: 'integer' },
          elapsedSeconds: { type: 'integer' },
          degraded: { type: 'boolean' },
          warning: { type: 'string' },
          steps: { type: 'array', items: { type: 'string' } },
        },
        required: [
          'file', 'relativeFile', 'title', 'bvid', 'kind', 'pages',
          'durationSeconds', 'transcriptSource', 'transcriptChars', 'elapsedSeconds', 'degraded',
        ],
      },
      render(args, value) {
        const lines = [
          `已生成 ${value.kind}：${value.title}`,
          `文件：${value.file}`,
          `视频：${value.bvid} · ${value.pages.join('、')} · 时长 ${humanDuration(value.durationSeconds)}`,
          `转录：${value.transcriptSource}，${value.transcriptChars} 字，用时 ${value.elapsedSeconds} 秒`,
        ]
        if (value.warning) lines.push(`注意：${value.warning}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return runTool(ctx, config, args, exec)
    },
  }
}

/** Resolve the session working directory, falling back to the process cwd. */
async function resolveWorkspace(ctx, exec) {
  try {
    const service = ctx.get('workingDirectory')
    if (service && exec?.agent) return await service.ensure(exec.agent, exec.signal)
  } catch {
    // Fall through to the process directory.
  }
  return process.cwd()
}

/** Read one cached transcript for a part, if present and usable. */
async function readCachedTranscript(cacheDir, bvid, page) {
  const path = join(cacheDir, bvid, `p${page}.json`)
  if (!existsSync(path)) return null
  try {
    const payload = JSON.parse(await readFile(path, 'utf8'))
    if (!Array.isArray(payload.segments) || payload.segments.length === 0) return null
    return {
      segments: payload.segments,
      source: String(payload.source ?? '缓存'),
      model: String(payload.model ?? ''),
    }
  } catch {
    return null
  }
}

async function writeCachedTranscript(cacheDir, bvid, page, payload) {
  const directory = join(cacheDir, bvid)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, `p${page}.json`), JSON.stringify(payload, null, 1), 'utf8')
}

/** Remove the downloaded media for one part after transcription. */
async function cleanMedia(cacheDir, bvid, page) {
  const prefix = `${bvid}-p${page}.`
  try {
    for (const name of await readdir(cacheDir)) {
      if (name.startsWith(prefix)) await rm(join(cacheDir, name), { force: true })
    }
  } catch {
    // Best effort only.
  }
}

/** Obtain transcript segments for one part: subtitle first, local ASR second. */
async function transcriptForPart(options) {
  const { video, part, cacheDir, config, ctx, signal, log } = options
  const cached = await readCachedTranscript(cacheDir, video.bvid, part.index)
  if (cached) {
    log(`P${part.index} 命中转录缓存（${cached.source}）`)
    return cached
  }

  try {
    const subtitle = await fetchSubtitle({ bvid: video.bvid, cid: part.cid }, { signal })
    if (subtitle) {
      log(`P${part.index} 使用视频字幕（${subtitle.language}）`)
      const payload = {
        source: '视频字幕',
        language: subtitle.language,
        createdAt: new Date().toISOString(),
        segments: subtitle.segments,
      }
      await writeCachedTranscript(cacheDir, video.bvid, part.index, payload)
      return { segments: payload.segments, source: payload.source, model: '' }
    }
  } catch (error) {
    if (signal?.aborted) throw error
    log(`P${part.index} 读取字幕失败，改用语音转写：${String(error.message).slice(0, 120)}`)
  }

  throwIfAborted(signal)
  const workspace = options.workspace
  const python = await resolvePython({ pythonPath: config.pythonPath, workspace, signal })
  const ffmpeg = findExecutable(config.ffmpegPath || 'ffmpeg')
  if (!ffmpeg) throw new Error('没有找到 ffmpeg；请在插件配置里设置 ffmpegPath')
  await mkdir(cacheDir, { recursive: true })
  log(`P${part.index} 下载音频中…`)
  const url = `${video.url}?p=${part.index}`
  const audio = await downloadAudio({
    bvid: video.bvid, page: part.index, url, cwd: cacheDir, python, signal,
  })
  log(`P${part.index} 音频转码中…`)
  const wav = await toWav({ audio, outDir: cacheDir, ffmpeg, signal })
  log(`P${part.index} 语音转写中（模型 ${config.whisperModel}），这一步可能较久…`)
  const result = await transcribe({
    wav,
    outPrefix: join(cacheDir, `${video.bvid}-p${part.index}`),
    python,
    model: config.whisperModel || 'large-v3-turbo',
    threads: Number(config.whisperThreads) || 0,
    cwd: workspace,
    signal,
  })
  await cleanMedia(cacheDir, video.bvid, part.index)
  await rm(wav, { force: true })
  const payload = {
    source: '本地语音转写',
    model: config.whisperModel || 'large-v3-turbo',
    language: result.language,
    createdAt: new Date().toISOString(),
    segments: result.segments,
  }
  await writeCachedTranscript(cacheDir, video.bvid, part.index, payload)
  return { segments: result.segments, source: '本地语音转写', model: payload.model }
}

/** Format transcript segments as timestamped lines. */
function formatTranscript(parts) {
  const lines = []
  for (const entry of parts) {
    lines.push(`【P${entry.part.index} ${entry.part.title}】`)
    for (const segment of entry.segments) {
      const stamp = clock(segment.start)
      lines.push(`[${stamp}] ${segment.text}`)
    }
    lines.push('')
  }
  return lines.join('\n').trim()
}

/** Build a degraded but honest document when summarization fails. */
function fallbackDocument(video, parts, transcript, reason) {
  const paragraphs = transcript.split('\n').slice(0, 80)
  return {
    title: video.title || `${video.bvid} 视频整理`,
    subtitle: '转录整理（自动摘要未完成）',
    lead: {
      what: `这是 B 站视频《${video.title}》，上传者 ${video.owner || '未知'}，时长 ${humanDuration(parts.reduce((sum, part) => sum + part.duration, 0))}。`,
      purpose: '本文件保留原始转录，供人工整理或稍后重试自动摘要。',
      problems: [
        '视频没有字幕时，先把语音转成可检索的文字',
        `自动摘要未完成：${reason}`,
      ],
      audience: '',
      prerequisites: [],
    },
    sections: [{ heading: '一、视频转录原文', blocks: paragraphs.map(line => ({ type: 'p', text: line })) }],
    takeaways: [],
    nextSteps: [],
  }
}

async function runTool(ctx, config, args, exec) {
  const started = Date.now()
  const signal = exec.signal
  const logs = []
  const log = message => { logs.push(message) }

  const workspace = await resolveWorkspace(ctx, exec)
  const identity = parseBilibiliInput(args.url)
  const video = await fetchVideo(identity, { signal })
  const parts = selectPages(video.pages, args.pages)
  const kind = KINDS.includes(args.kind) ? args.kind : '讲义'
  log(`视频：${video.title}（${video.bvid}），处理 ${parts.length} 个分 P`)

  const cacheDir = config.cacheDir
    ? (isAbsolute(config.cacheDir) ? config.cacheDir : resolve(workspace, config.cacheDir))
    : join(workspace, '.bili-lecture-cache')

  const collected = []
  for (const part of parts) {
    throwIfAborted(signal)
    const transcript = await transcriptForPart({
      video, part, cacheDir, config, ctx, signal, log, workspace,
    })
    collected.push({ part, ...transcript })
  }

  const transcript = formatTranscript(collected)
  const transcriptChars = transcript.length
  const transcriptSource = [...new Set(collected.map(entry => entry.source))].join('、')
  const durationSeconds = parts.reduce((sum, part) => sum + part.duration, 0)

  let selection
  try {
    selection = await resolveSelection(ctx, args.model)
  } catch (error) {
    throw new Error(`无法确定生成模型：${error.message}`)
  }

  let doc
  let degraded = false
  let warning = ''
  try {
    const result = await buildHandout({
      ctx,
      selection,
      kind,
      video,
      parts,
      transcript,
      signal,
    })
    if (result.degraded) {
      degraded = true
      warning = `自动摘要失败，已输出转录版：${result.notes ?? ''}`
      doc = fallbackDocument(video, parts, transcript, result.notes ?? '未知原因')
    } else {
      doc = result.doc
    }
  } catch (error) {
    if (signal?.aborted) throw error
    degraded = true
    warning = `自动摘要失败，已输出转录版：${String(error.message).slice(0, 200)}`
    doc = fallbackDocument(video, parts, transcript, String(error.message).slice(0, 160))
  }

  const now = new Date()
  const pageLabel = parts.length === 1 ? `P${parts[0].index}` : `P${parts[0].index}-P${parts[parts.length - 1].index}`
  const meta = [
    `来源：B 站 · ${video.owner || '未知上传者'} · ${pageLabel}`,
    `原视频：${video.title}`,
    `链接：${video.url}${parts.length === 1 ? `?p=${parts[0].index}` : ''}`,
    `时长：${humanDuration(durationSeconds)} · 转录：${transcriptSource} · ${transcriptChars} 字`,
    `生成：${now.toLocaleString('zh-CN', { hour12: false })} · 模型 ${selection.model}`,
  ]
  if (degraded) meta.push('状态：自动摘要未完成，本文为转录整理版')

  const footer = '本文由 DSH 插件 bili-lecture 依据视频转录自动整理。'
    + '转录由机器识别，可能存在错字或漏句；引用数字、公式与结论前请对照原视频核对。'

  const buffer = buildDocx({
    title: doc.title,
    subtitle: doc.subtitle,
    meta,
    lead: doc.lead,
    sections: doc.sections,
    takeaways: doc.takeaways,
    nextSteps: doc.nextSteps,
    footer,
  })

  const outputDir = args.outputDir
    ? (isAbsolute(args.outputDir) ? args.outputDir : resolve(workspace, args.outputDir))
    : join(workspace, kind)
  await mkdir(outputDir, { recursive: true })

  const baseName = safeFileName(`${video.bvid}-${pageLabel}-${doc.title}`, 70)
  const file = join(outputDir, `${baseName}.docx`)
  await writeFile(file, buffer)
  const info = await stat(file)
  if (info.size === 0) throw new Error('生成的 docx 为空文件')

  const relativeFile = file.startsWith(`${workspace}/`) ? file.slice(workspace.length + 1) : file
  return {
    file,
    relativeFile,
    title: doc.title,
    bvid: video.bvid,
    kind,
    pages: parts.map(part => `P${part.index}`),
    durationSeconds: Math.round(durationSeconds),
    transcriptSource,
    transcriptChars,
    elapsedSeconds: Math.round((Date.now() - started) / 1000),
    degraded,
    ...(warning ? { warning } : {}),
    steps: logs.slice(-12),
  }
}
