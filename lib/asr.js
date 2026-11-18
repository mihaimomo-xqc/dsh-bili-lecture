/** Audio acquisition and local speech recognition (yt-dlp + faster-whisper). */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { throwIfAborted } from './util.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '..', 'scripts', 'transcribe.py')

const COMMON_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  process.env.HOME ? join(process.env.HOME, 'Documents', 'ffbin') : '',
  process.env.HOME ? join(process.env.HOME, 'bin') : '',
].filter(Boolean)

/**
 * Run one child process to completion.
 * @param {string} command executable path.
 * @param {string[]} args
 * @param {{cwd?: string, signal?: AbortSignal, env?: Record<string, string>}} [options]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
export function run(command, args, options = {}) {
  const { cwd, signal, env } = options
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const onAbort = () => { child.kill('SIGTERM') }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', chunk => { if (stdout.length < 400_000) stdout += chunk.toString() })
    child.stderr.on('data', chunk => { if (stderr.length < 400_000) stderr += chunk.toString() })
    child.on('error', error => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return reject(signal.reason ?? new Error('已取消'))
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/**
 * Locate an executable, honoring an explicit configuration first.
 * @param {string} name bare or absolute executable name.
 * @returns {string | null}
 */
export function findExecutable(name) {
  if (!name) return null
  if (name.includes('/')) return existsSync(name) ? name : null
  for (const dir of COMMON_BIN_DIRS) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Ask a Python interpreter whether it can import the required modules. */
async function pythonHasModules(pythonPath) {
  try {
    const result = await run(pythonPath, ['-c', 'import faster_whisper, yt_dlp; print("ok")'])
    return result.code === 0 && result.stdout.includes('ok')
  } catch {
    return false
  }
}

/**
 * Resolve the Python interpreter used for downloading and transcribing.
 * @param {{pythonPath?: string, workspace: string, signal?: AbortSignal}} options
 * @returns {Promise<string>}
 */
export async function resolvePython(options) {
  const { pythonPath, workspace, signal } = options
  const candidates = []
  if (pythonPath) candidates.push(pythonPath)
  candidates.push(join(workspace, '.venv', 'bin', 'python'))
  candidates.push(join(workspace, '.venv', 'bin', 'python3'))
  const pathPython = findExecutable('python3')
  if (pathPython) candidates.push(pathPython)
  const seen = new Set()
  for (const candidate of candidates) {
    throwIfAborted(signal)
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)
    if (!existsSync(candidate)) continue
    if (await pythonHasModules(candidate)) return candidate
  }
  throw new Error(
    '没有找到可用的 Python 语音转写环境。请在插件配置中设置 pythonPath，'
    + '或在当前工作目录创建 .venv 并安装 faster-whisper 与 yt-dlp：\n'
    + '  python3 -m venv .venv && .venv/bin/pip install faster-whisper yt-dlp',
  )
}

/**
 * Download the audio-only stream of one part with yt-dlp.
 * @param {{bvid: string, page: number, url: string, cwd: string, python: string, signal?: AbortSignal}} options
 * @returns {Promise<string>} absolute path of the downloaded audio file.
 */
export async function downloadAudio(options) {
  const { bvid, page, url, cwd, python, signal } = options
  const prefix = `${bvid}-p${page}.`
  // Remove leftovers from an interrupted earlier attempt so a stale WAV is
  // never mistaken for the downloadable audio stream.
  for (const name of readdirSync(cwd)) {
    if (name.startsWith(prefix)) rmSync(join(cwd, name), { force: true })
  }
  const target = join(cwd, `${bvid}-p${page}.%(ext)s`)
  const args = [
    '-m', 'yt_dlp',
    '-f', 'bestaudio',
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--retries', '3',
    '-o', target,
    url,
  ]
  const result = await run(python, args, { cwd, signal })
  if (result.code !== 0) {
    throw new Error(`下载音频失败（yt-dlp 退出码 ${result.code}）：${tail(result.stderr)}`)
  }
  const audioExtensions = new Set(['.m4a', '.mp4', '.mp3', '.aac', '.webm', '.flac', '.ogg', '.opus', '.m4s'])
  const found = readdirSync(cwd)
    .filter(name => name.startsWith(prefix) && audioExtensions.has(extname(name).toLowerCase()))
    .map(name => join(cwd, name))
    .filter(path => statSync(path).isFile())
    .sort((a, b) => statSync(b).size - statSync(a).size)[0]
  if (!found) throw new Error('yt-dlp 已结束，但没有找到下载的音频文件')
  return found
}

/**
 * Convert any audio file to 16 kHz mono WAV, which the transcriber reads
 * without PyAV.
 * @param {{audio: string, outDir: string, ffmpeg: string, signal?: AbortSignal}} options
 * @returns {Promise<string>}
 */
export async function toWav(options) {
  const { audio, outDir, ffmpeg, signal } = options
  const wav = audio.replace(/\.[^.]+$/, '') + '.wav'
  if (wav === audio) return audio
  const result = await run(ffmpeg, ['-v', 'error', '-y', '-i', audio, '-ar', '16000', '-ac', '1', wav], { cwd: outDir, signal })
  if (result.code !== 0) throw new Error(`音频转码失败（ffmpeg 退出码 ${result.code}）：${tail(result.stderr)}`)
  return wav
}

/**
 * Transcribe a WAV file with faster-whisper.
 * @param {{wav: string, outPrefix: string, python: string, model: string, threads: number, cwd: string, signal?: AbortSignal}} options
 * @returns {Promise<{segments: Array<{start: number, end: number, text: string}>, language: string, duration: number}>}
 */
export async function transcribe(options) {
  const { wav, outPrefix, python, model, threads, cwd, signal } = options
  const args = [
    SCRIPT,
    wav,
    outPrefix,
    model,
    '--threads', String(threads),
  ]
  const result = await run(python, args, {
    cwd,
    signal,
    env: { PYTHONUNBUFFERED: '1', WHISPER_THREADS: String(threads) },
  })
  if (result.code !== 0) {
    throw new Error(`语音转写失败（退出码 ${result.code}）：${tail(result.stderr)}`)
  }
  const jsonPath = `${outPrefix}.json`
  if (!existsSync(jsonPath)) throw new Error('转写脚本没有产出 JSON 结果')
  const payload = JSON.parse(await (await import('node:fs/promises')).readFile(jsonPath, 'utf8'))
  const segments = (payload.segments ?? [])
    .map(row => ({ start: Number(row.start), end: Number(row.end), text: String(row.text ?? '').trim() }))
    .filter(row => row.text.length > 0)
  if (segments.length === 0) throw new Error('转写结果为空，视频可能没有人声')
  return { segments, language: String(payload.language ?? 'zh'), duration: Number(payload.duration ?? 0) }
}

/** Last few lines of a child's stderr, for error messages. */
export function tail(text, lines = 6) {
  return String(text ?? '').trim().split('\n').slice(-lines).join('\n')
}
