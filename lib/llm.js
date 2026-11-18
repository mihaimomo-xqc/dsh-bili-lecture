/** Model selection and the two-stage summarization that feeds the Word file. */

import { chunkText, throwIfAborted } from './util.js'

const KINDS = ['讲义', '摘要', 'SOP', '操作流程']

const KIND_GUIDE = {
  讲义: `按「课程讲义」组织：8–12 节，每节先给 1 段导语说明这一节解决什么，再展开。
每节要把定义、公式、推导、例子、易错点讲清楚；关键数字、术语原文、老师的判断标准必须保留；
可用 table 做概念对比，用 callout 标注容易混淆的点，用 quote 引用老师原话（简短）。
每节 300–600 字，总字数不少于 3000 字。`,
  摘要: `按「快速摘要」组织：结论先行，4–6 节，总字数 800–1200 字。
只保留骨架：核心结论、关键数字、方法步骤、结论的适用条件；
不要客套话，不要重复转录原句，用短句和要点。`,
  SOP: `按「标准作业程序（SOP）」组织，必须可照着执行：
1. 适用范围与目标；2. 角色与权限；3. 前置准备（账号、工具、数据、检查项）；
4. 操作步骤（用 table，列：步骤 | 操作 | 预期结果 | 注意事项），步骤要能直接照做；
5. 校验清单（bullets，可勾选）；6. 常见异常与处理（table，列：现象 | 原因 | 处理）；
7. 回滚 / 恢复方式。视频没讲的环节用「（视频未提及）」标注，不要编造。`,
  操作流程: `按「端到端操作流程」组织：
1. 触发条件与目标；2. 流程步骤（用 steps，按时间顺序，每步一个动作和一个产出）；
3. 分支与判断（table，列：判断条件 | 走向 | 说明）；4. 每一步的输入与产出；
5. 检查点（bullets）；6. 失败处理与重试；7. 流程结束后的收尾动作。
视频没讲的环节用「（视频未提及）」标注，不要编造。`,
}

const SHAPE = `输出单个 JSON 对象，字段如下（不要 Markdown 代码块，不要注释）：
{
  "title": "文档标题，不超过 24 字，不要书名号，不要照抄视频标题，不要再加「讲义 / 摘要 / SOP」等类型后缀",
  "subtitle": "一句话副标题，说明文档类型与对象",
  "what": "这条视频是什么：2–4 句，写清课程/项目、讲者身份、主题范围",
  "purpose": "用来干什么：1–3 句，观众用它能完成什么",
  "problems": ["能解决什么问题：3–5 条，每条一句话，具体"],
  "audience": "适合谁看：1 句",
  "prerequisites": ["前置知识或准备：0–3 条"],
  "sections": [
    {
      "heading": "章节标题，带中文序号，如「一、什么是大数据」",
      "blocks": [
        {"type": "p", "text": "正文段落，可用 **加粗** 和 \`行内代码\`"},
        {"type": "bullets", "items": ["要点"]},
        {"type": "steps", "items": ["步骤"]},
        {"type": "table", "headers": ["列1", "列2"], "rows": [["值1", "值2"]]},
        {"type": "quote", "text": "引述或要点强调"},
        {"type": "callout", "text": "注意事项"},
        {"type": "code", "text": "命令或伪代码"},
        {"type": "h3", "text": "小节标题"}
      ]
    }
  ],
  "takeaways": ["要点回顾：3–6 条"],
  "nextSteps": ["下一步可以做什么：2–4 条"]
}`

/** System prompt shared by every generation call. */
const SYSTEM = `你是一位严谨的中文课程编辑，擅长把视频转录整理成可以直接发出去的文档。
规则：
1. 只依据给定的视频元数据与转录内容，不编造未出现的事实、数字或结论。
2. 转录是机器识别的，可能有错字；遇到明显同音错误按上下文改正，无法判断时标注「（转录不清）」。
3. 关键术语、数字、公式、老师给出的判断标准必须原样保留。
4. 需要指回视频位置时用 [mm:ss] 标注，只在确实对应时使用。
5. 中文表达具体、干净、句子短；不要空话和套话。
6. 只输出一个 JSON 对象，不要 Markdown 代码块，不要任何解释文字。`

/**
 * Resolve which provider/model route to use.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string | undefined} explicit `provider/model`, `provider:model` or a bare model id.
 * @returns {Promise<{provider: string, model: string, reasoningEffort?: string}>}
 */
export async function resolveSelection(ctx, explicit) {
  const llm = ctx.get('llm')
  if (!llm) throw new Error('当前 DSH 没有可用的模型服务（llm）')
  const preferred = ctx.get('agentDefaultModel')?.currentSelection?.()
  const text = String(explicit ?? '').trim()
  if (text) {
    const split = text.match(/^([^/:]+)[/:](.+)$/)
    if (split) return { provider: split[1], model: split[2] }
    if (preferred?.provider) return { provider: preferred.provider, model: text }
    return { provider: (await firstProvider(llm)), model: text }
  }
  if (preferred?.provider && preferred?.model) {
    return {
      provider: preferred.provider,
      model: preferred.model,
      ...(preferred.reasoningEffort ? { reasoningEffort: preferred.reasoningEffort } : {}),
    }
  }
  const provider = await firstProvider(llm)
  const models = await llm.listModels(provider)
  const model = models?.[0]?.id
  if (!model) throw new Error(`模型服务 ${provider} 没有可用模型`)
  return { provider, model }
}

async function firstProvider(llm) {
  const providers = llm.listProviders?.() ?? []
  const provider = providers[0]?.id
  if (!provider) throw new Error('当前没有任何已配置的模型提供方')
  return provider
}

/**
 * Stream one completion and return its text.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<typeof resolveSelection> extends Promise<infer T> ? T : never} selection
 * @param {{system?: string, prompt: string, maxTokens?: number, temperature?: number, signal?: AbortSignal}} request
 * @returns {Promise<string>}
 */
export async function complete(ctx, selection, request) {
  const llm = ctx.get('llm')
  if (!llm) throw new Error('当前 DSH 没有可用的模型服务（llm）')
  const { system = SYSTEM, prompt, maxTokens = 8000, temperature = 0.3, signal } = request
  let text = ''
  const stream = llm.stream({
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    maxTokens,
    temperature,
    signal,
  })
  for await (const chunk of stream) {
    throwIfAborted(signal)
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
      throw new Error(`模型调用失败：${chunk.reason.failure?.message ?? '未知错误'}`)
    } else if (chunk.type === 'finish' && chunk.reason?.kind === 'aborted') {
      throw new Error('模型调用已取消')
    }
  }
  const trimmed = text.trim()
  if (!trimmed) throw new Error('模型返回了空内容')
  return trimmed
}

/**
 * Reduce a long transcript to at most `limit` characters with map-style notes.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {any} selection
 * @param {string} text
 * @param {{limit?: number, signal?: AbortSignal, label?: string}} [options]
 */
async function condense(ctx, selection, text, options = {}) {
  const { limit = 24_000, signal, label = '转录' } = options
  let current = text
  for (let pass = 0; pass < 3 && current.length > limit; pass++) {
    const chunks = chunkText(current, 11_000)
    const notes = []
    for (const [index, chunk] of chunks.entries()) {
      throwIfAborted(signal)
      const prompt = `下面是「${label}」的第 ${index + 1}/${chunks.length} 段。请提炼事实笔记：
- 保留定义、步骤、数字、公式、例子、老师强调的判断标准；
- 保留能定位原视频的时间戳 [mm:ss]；
- 只写内容，不写评价，每段不超过 500 字，用短横线分条。`
      notes.push(await complete(ctx, selection, {
        prompt: `${prompt}\n\n===== 转录片段 =====\n${chunk}`,
        maxTokens: 2000,
        temperature: 0.2,
        signal,
      }))
    }
    current = notes.map((note, index) => `【第 ${index + 1} 段笔记】\n${note}`).join('\n\n')
  }
  return current
}

/**
 * Build the handout document model from a transcript.
 * @param {{
 *   ctx: any,
 *   selection: {provider: string, model: string, reasoningEffort?: string},
 *   kind: string,
 *   video: {title: string, owner: string, url: string, desc: string},
 *   parts: Array<{index: number, title: string, duration: number}>,
 *   transcript: string,
 *   signal?: AbortSignal,
 * }} request
 * @returns {Promise<{doc: object | null, degraded: boolean, notes?: string, usage?: object}>}
 */
export async function buildHandout(request) {
  const { ctx, selection, kind, video, parts, transcript, signal } = request
  if (!KINDS.includes(kind)) throw new Error(`不支持的文档类型：${kind}`)
  const material = await condense(ctx, selection, transcript, { signal, label: '视频转录' })

  const partsText = parts.length > 1
    ? parts.map(part => `P${part.index} ${part.title}（${Math.round(part.duration / 60)} 分钟）`).join('；')
    : `${parts[0]?.title ?? ''}（${Math.round((parts[0]?.duration ?? 0) / 60)} 分钟）`

  const prompt = `请把下面的视频转录整理成中文「${kind}」，并严格按指定 JSON 结构输出。

【视频元数据】
标题：${video.title}
上传者：${video.owner}
链接：${video.url}
简介：${video.desc || '（无）'}
分 P：${partsText}

【文档类型要求】
${KIND_GUIDE[kind]}

【结构要求】
${SHAPE}

【硬性要求】
- 所有字符串必须写在同一行，不能出现真正的换行符；需要分段时用「；」连接。
- 字符串内不要使用英文双引号 "，需要引用时一律用「」。
- what / purpose / problems 必须具体到这条视频，不能写成通用模板；problems 至少 3 条。
- sections 至少 4 节，每节 heading 带中文序号。
- 所有内容必须来自转录；没讲到的不要补。
- 只输出 JSON。

===== 视频转录（时间戳为 [mm:ss]）=====
${material}`

  let raw
  try {
    raw = await complete(ctx, selection, { prompt, maxTokens: 12_000, signal })
    return { doc: normalize(parseJson(raw), kind), degraded: false }
  } catch (error) {
    if (signal?.aborted) throw error
    // One stricter retry: models sometimes wrap JSON in prose.
    try {
      raw = await complete(ctx, selection, {
        prompt: `${prompt}\n\n上一次输出不是合法 JSON（${String(error.message).slice(0, 160)}）。请只输出 JSON 对象本身。`,
        maxTokens: 12_000,
        signal,
      })
      return { doc: normalize(parseJson(raw), kind), degraded: false }
    } catch (retryError) {
      if (signal?.aborted) throw retryError
      return {
        doc: null,
        degraded: true,
        notes: `${String(retryError.message).slice(0, 200)}｜原始输出：${String(raw ?? '').slice(0, 120)}`,
      }
    }
  }
}

/**
 * Extract the first JSON object from model output.
 *
 * Models writing long Chinese prose often leave English double quotes
 * unescaped and emit literal newlines inside strings. A straight `JSON.parse`
 * rejects both, so strings are walked once and repaired before parsing:
 * an inner quote followed by a non-delimiter is treated as literal text, and
 * control characters inside a string become escapes.
 * @param {string} text raw model output.
 * @returns {any} parsed value.
 */
export function parseJson(text) {
  let source = String(text ?? '').trim()
  source = source.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const start = source.indexOf('{')
  const end = source.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型输出里没有 JSON 对象')
  const body = source.slice(start, end + 1)
  const repaired = repairJsonStrings(body)
  try {
    return JSON.parse(repaired)
  } catch (error) {
    const fallback = repaired.replace(/,\s*([}\]])/g, '$1')
    try {
      return JSON.parse(fallback)
    } catch {
      throw new Error(`JSON 解析失败：${error.message}`)
    }
  }
}

/** Walk JSON text and make common model mistakes parseable. */
function repairJsonStrings(input) {
  const out = []
  let inString = false
  let escaped = false
  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    if (!inString) {
      out.push(char)
      if (char === '"') inString = true
      continue
    }
    if (escaped) {
      out.push(char)
      escaped = false
      continue
    }
    if (char === '\\') {
      out.push(char)
      escaped = true
      continue
    }
    if (char === '"') {
      // A closing quote is followed (after optional whitespace) by one of , } ] :
      let lookahead = index + 1
      while (lookahead < input.length && /\s/.test(input[lookahead])) lookahead++
      const next = input[lookahead]
      if (next === undefined || next === ',' || next === '}' || next === ']' || next === ':') {
        out.push('"')
        inString = false
      } else {
        out.push('\\"')
      }
      continue
    }
    if (char === '\n') { out.push('\\n'); continue }
    if (char === '\r') { continue }
    if (char === '\t') { out.push('\\t'); continue }
    if (char.charCodeAt(0) < 0x20) { out.push(' '); continue }
    out.push(char)
  }
  return out.join('')
}

function text(value, fallback = '') {
  const result = String(value ?? '').trim()
  return result.length > 0 ? result : fallback
}

function strings(value, max = 12) {
  if (!Array.isArray(value)) return []
  return value.map(item => text(item)).filter(Boolean).slice(0, max)
}

function normalizeBlocks(blocks) {
  if (!Array.isArray(blocks)) return []
  const output = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    const type = text(block.type, 'p')
    if (type === 'table') {
      const headers = strings(block.headers, 6)
      const rows = Array.isArray(block.rows)
        ? block.rows.slice(0, 30).map(row => (Array.isArray(row) ? row.map(cell => text(cell)) : [text(row)]))
        : []
      if (headers.length === 0 && rows.length === 0) continue
      output.push({ type: 'table', headers, rows })
      continue
    }
    if (type === 'bullets' || type === 'steps') {
      const items = strings(block.items, 20)
      if (items.length > 0) output.push({ type, items })
      continue
    }
    if (type === 'rule') { output.push({ type: 'rule' }); continue }
    if (['p', 'quote', 'callout', 'code', 'h3', 'h4'].includes(type)) {
      const value = text(block.text)
      if (value.length > 0) output.push({ type, text: value })
      continue
    }
    const fallback = text(block.text)
    if (fallback.length > 0) output.push({ type: 'p', text: fallback })
  }
  return output
}

/** Coerce model JSON into the shape the renderer expects. */
export function normalize(raw, kind) {
  const sections = Array.isArray(raw?.sections) ? raw.sections : []
  const normalizedSections = sections
    .map(section => ({
      heading: text(section?.heading),
      blocks: normalizeBlocks(section?.blocks),
    }))
    .filter(section => section.heading.length > 0 && section.blocks.length > 0)
  if (normalizedSections.length === 0) throw new Error('模型输出缺少 sections')
  return {
    title: text(raw?.title, '视频讲义'),
    subtitle: text(raw?.subtitle, kind === '摘要' ? '视频快速摘要' : `${kind} · 根据视频转录整理`),
    lead: {
      what: text(raw?.what, '（模型未给出）'),
      purpose: text(raw?.purpose, '（模型未给出）'),
      problems: strings(raw?.problems, 6),
      audience: text(raw?.audience),
      prerequisites: strings(raw?.prerequisites, 4),
    },
    sections: normalizedSections.slice(0, 20),
    takeaways: strings(raw?.takeaways, 8),
    nextSteps: strings(raw?.nextSteps, 6),
  }
}
