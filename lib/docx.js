/**
 * Dependency-free Word (.docx) writer.
 *
 * Produces a small but valid OOXML package: document, styles, footer with page
 * numbers, and core properties. Supports Chinese typography, headings, bullet
 * and numbered lists, tables, quotes, callouts, code blocks and page breaks.
 */

import { deflateRawSync } from 'node:zlib'

/* ------------------------------------------------------------------ */
/* ZIP                                                                 */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (let index = 0; index < buffer.length; index++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[index]) & 0xff]
  }
  return (crc ^ -1) >>> 0
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

/**
 * Build a ZIP archive from named entries.
 * @param {Array<{name: string, data: Buffer}>} entries
 * @returns {Buffer}
 */
function zip(entries) {
  const { time, date } = dosDateTime()
  const chunks = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = entry.data
    const deflated = deflateRawSync(data, { level: 9 })
    const checksum = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(deflated.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, name, deflated)

    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50, 0)
    directory.writeUInt16LE(20, 4)
    directory.writeUInt16LE(20, 6)
    directory.writeUInt16LE(0x0800, 8)
    directory.writeUInt16LE(8, 10)
    directory.writeUInt16LE(time, 12)
    directory.writeUInt16LE(date, 14)
    directory.writeUInt32LE(checksum, 16)
    directory.writeUInt32LE(deflated.length, 20)
    directory.writeUInt32LE(data.length, 24)
    directory.writeUInt16LE(name.length, 28)
    directory.writeUInt16LE(0, 30)
    directory.writeUInt16LE(0, 32)
    directory.writeUInt16LE(0, 34)
    directory.writeUInt16LE(0, 36)
    directory.writeUInt32LE(0, 38)
    directory.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([directory, name]))
    offset += local.length + name.length + deflated.length
  }
  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...chunks, centralBuffer, end])
}

/* ------------------------------------------------------------------ */
/* XML helpers                                                         */
/* ------------------------------------------------------------------ */

const BODY_FONT = 'PingFang SC'
const MONO_FONT = 'Menlo'
const ACCENT = '1F4E79'
const MUTED = '666666'

function xml(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function fonts(font = BODY_FONT) {
  return `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}" w:cs="${font}"/>`
}

/**
 * Build one run.
 * @param {string} text
 * @param {{bold?: boolean, italic?: boolean, code?: boolean, color?: string, size?: number}} [options]
 */
function run(text, options = {}) {
  const { bold, italic, code, color, size } = options
  const properties = [
    fonts(code ? MONO_FONT : BODY_FONT),
    bold ? '<w:b/><w:bCs/>' : '',
    italic ? '<w:i/><w:iCs/>' : '',
    color ? `<w:color w:val="${color}"/>` : '',
    size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : '',
  ].join('')
  const body = String(text).split('\n').map(part => `<w:t xml:space="preserve">${xml(part)}</w:t>`).join('<w:br/>')
  return `<w:r><w:rPr>${properties}</w:rPr>${body}</w:r>`
}

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g

/** Split one line into runs, honoring **bold**, `code` and *italic*. */
function inline(text, base = {}) {
  const source = String(text ?? '')
  const runs = []
  let cursor = 0
  for (const match of source.matchAll(INLINE)) {
    if (match.index > cursor) runs.push(run(source.slice(cursor, match.index), base))
    const token = match[0]
    if (token.startsWith('**')) runs.push(run(token.slice(2, -2), { ...base, bold: true }))
    else if (token.startsWith('`')) runs.push(run(token.slice(1, -1), { ...base, code: true, color: '8B1A1A' }))
    else runs.push(run(token.slice(1, -1), { ...base, italic: true }))
    cursor = match.index + token.length
  }
  if (cursor < source.length) runs.push(run(source.slice(cursor), base))
  return runs.join('') || run('', base)
}

/**
 * Build one paragraph with explicit formatting.
 * @param {string} content pre-built run XML.
 * @param {Record<string, any>} [options]
 */
function paragraph(content, options = {}) {
  const {
    align, spaceBefore = 60, spaceAfter = 60, line = 300, indentLeft, indentHanging,
    shading, borderLeft, keepNext, outlineLevel, style, pageBreakBefore,
  } = options
  const pPr = [
    style ? `<w:pStyle w:val="${style}"/>` : '',
    pageBreakBefore ? '<w:pageBreakBefore/>' : '',
    keepNext ? '<w:keepNext/>' : '',
    '<w:keepLines/>',
    borderLeft
      ? `<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="${borderLeft}"/></w:pBdr>`
      : '',
    shading ? `<w:shd w:val="clear" w:color="auto" w:fill="${shading}"/>` : '',
    `<w:spacing w:before="${spaceBefore}" w:after="${spaceAfter}" w:line="${line}" w:lineRule="auto"/>`,
    indentLeft !== undefined || indentHanging !== undefined
      ? `<w:ind${indentLeft !== undefined ? ` w:left="${indentLeft}"` : ''}${indentHanging !== undefined ? ` w:hanging="${indentHanging}"` : ''}/>`
      : '',
    align ? `<w:jc w:val="${align}"/>` : '',
    outlineLevel !== undefined ? `<w:outlineLvl w:val="${outlineLevel}"/>` : '',
  ].join('')
  return `<w:p><w:pPr>${pPr}</w:pPr>${content}</w:p>`
}

function heading(text, level, extra = {}) {
  const config = {
    1: { size: 32, before: 320, after: 140, color: ACCENT },
    2: { size: 26, before: 260, after: 120, color: ACCENT },
    3: { size: 23, before: 200, after: 100, color: '2E5E8C' },
    4: { size: 21, before: 160, after: 80, color: '333333' },
  }[level] ?? { size: 21, before: 160, after: 80, color: '333333' }
  const content = run(text, { bold: true, size: config.size, color: config.color })
  return paragraph(content, {
    style: `Heading${Math.min(level, 3)}`,
    outlineLevel: level - 1,
    spaceBefore: config.before,
    spaceAfter: config.after,
    keepNext: true,
    ...extra,
  })
}

function textParagraph(text) {
  return paragraph(inline(text), { line: 340, spaceBefore: 40, spaceAfter: 90 })
}

function bulletList(items) {
  return items.map(item => {
    // Checklist items already carry a box glyph; keep one box instead of "• ☐".
    const checklist = String(item).match(/^[□☐☑✓]\s*/)
    const marker = checklist
      ? run('☐', { color: '44546A', bold: true })
      : run('•', { color: ACCENT, bold: true })
    const body = inline(checklist ? String(item).slice(checklist[0].length) : item)
    return paragraph(`${marker}${run(' ')}${body}`, {
      indentLeft: 360,
      indentHanging: 180,
      spaceBefore: 20,
      spaceAfter: 40,
      line: 320,
    })
  }).join('')
}

function stepList(items) {
  return items.map((item, index) => {
    const marker = run(`${index + 1}.`, { color: ACCENT, bold: true })
    return paragraph(`${marker} ${inline(item)}`, {
      indentLeft: 420,
      indentHanging: 300,
      spaceBefore: 20,
      spaceAfter: 50,
      line: 320,
    })
  }).join('')
}

function table(block) {
  const headers = (block.headers ?? []).map(String)
  const rows = (block.rows ?? []).map(row => row.map(String))
  const columns = Math.max(headers.length, ...rows.map(row => row.length), 1)
  const totalWidth = 9412
  const width = Math.floor(totalWidth / columns)
  const grid = `<w:tblGrid>${Array.from({ length: columns }, () => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>`
  const border = 'single'
  const tblPr = `<w:tblPr><w:tblW w:w="${totalWidth}" w:type="dxa"/><w:tblBorders>`
    + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map(side => `<w:${side} w:val="${border}" w:sz="4" w:space="0" w:color="BFCBD9"/>`).join('')
    + `</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>`

  const cell = (text, header) => {
    const shading = header ? '<w:shd w:val="clear" w:color="auto" w:fill="E8EEF7"/>' : ''
    const p = `<w:p><w:pPr><w:spacing w:before="20" w:after="20" w:line="280" w:lineRule="auto"/></w:pPr>${inline(text, { bold: header, size: 19 })}</w:p>`
    return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${shading}<w:vAlign w:val="center"/></w:tcPr>${p}</w:tc>`
  }

  // cantSplit keeps one row on one page; a half row at a page top reads as a defect.
  const headerRow = headers.length > 0
    ? `<w:tr><w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>${Array.from({ length: columns }, (_, index) => cell(headers[index] ?? '', true)).join('')}</w:tr>`
    : ''
  const bodyRows = rows.map(row =>
    `<w:tr><w:trPr><w:cantSplit/></w:trPr>${Array.from({ length: columns }, (_, index) => cell(row[index] ?? '', false)).join('')}</w:tr>`,
  ).join('')
  return `<w:tbl>${tblPr}${grid}${headerRow}${bodyRows}</w:tbl><w:p><w:pPr><w:spacing w:before="0" w:after="60" w:line="120" w:lineRule="auto"/></w:pPr></w:p>`
}

function quote(text) {
  return paragraph(inline(text, { italic: true, color: MUTED }), {
    indentLeft: 400,
    borderLeft: 'BFCBD9',
    spaceBefore: 60,
    spaceAfter: 120,
    line: 320,
  })
}

function callout(text) {
  const content = run('提示  ', { bold: true, color: '9C6500' }) + inline(text, { size: 19 })
  return paragraph(content, {
    shading: 'FFF8E5',
    borderLeft: 'E6A23C',
    spaceBefore: 80,
    spaceAfter: 120,
    line: 320,
  })
}

function codeBlock(text) {
  const lines = String(text ?? '').replace(/\t/g, '    ').split('\n')
  const content = lines
    .map(line => `<w:r><w:rPr>${fonts(MONO_FONT)}<w:sz w:val="17"/><w:szCs w:val="17"/></w:rPr><w:t xml:space="preserve">${xml(line)}</w:t></w:r>`)
    .join('<w:br/>')
  return `<w:p><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F5F7FA"/><w:pBdr><w:left w:val="single" w:sz="12" w:space="6" w:color="9DB2C8"/></w:pBdr><w:spacing w:before="80" w:after="120" w:line="260" w:lineRule="auto"/><w:ind w:left="240"/></w:pPr>${content}</w:p>`
}

function horizontalRule() {
  return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFCBD9"/></w:pBdr><w:spacing w:before="40" w:after="140" w:line="120" w:lineRule="auto"/></w:pPr></w:p>'
}

/* ------------------------------------------------------------------ */
/* Document                                                            */
/* ------------------------------------------------------------------ */

function renderBlocks(blocks) {
  const output = []
  for (const block of blocks ?? []) {
    if (!block || typeof block !== 'object') continue
    switch (block.type) {
      case 'h3': output.push(heading(String(block.text ?? ''), 3)); break
      case 'h4': output.push(heading(String(block.text ?? ''), 4)); break
      case 'bullets': output.push(bulletList(block.items ?? [])); break
      case 'steps': output.push(stepList(block.items ?? [])); break
      case 'table': output.push(table(block)); break
      case 'quote': output.push(quote(String(block.text ?? ''))); break
      case 'callout': output.push(callout(String(block.text ?? ''))); break
      case 'code': output.push(codeBlock(String(block.text ?? ''))); break
      case 'rule': output.push(horizontalRule()); break
      case 'p':
      default: output.push(textParagraph(String(block.text ?? block.content ?? ''))); break
    }
  }
  return output.join('')
}

/**
 * Render one handout document.
 * @param {{
 *   title: string,
 *   subtitle?: string,
 *   meta?: string[],
 *   lead: {what: string, purpose: string, problems: string[], audience?: string, prerequisites?: string[]},
 *   sections: Array<{heading: string, blocks: Array<object>}>,
 *   takeaways?: string[],
 *   nextSteps?: string[],
 *   footer?: string,
 * }} model
 * @returns {Buffer}
 */
export function buildDocx(model) {
  const body = []
  body.push(paragraph(run(model.title, { bold: true, size: 44, color: ACCENT }), {
    spaceBefore: 200, spaceAfter: 120, line: 300,
  }))
  if (model.subtitle) {
    body.push(paragraph(run(model.subtitle, { size: 24, color: MUTED }), {
      spaceBefore: 0, spaceAfter: 160, line: 280,
    }))
  }
  if (Array.isArray(model.meta) && model.meta.length > 0) {
    body.push(paragraph(model.meta.map(line => run(line, { size: 18, color: MUTED })).join('<w:r><w:br/></w:r>'), {
      spaceBefore: 0, spaceAfter: 80, line: 260,
    }))
  }
  body.push(horizontalRule())

  body.push(heading('视频速览', 1))
  body.push(paragraph(
    run('这是什么　', { bold: true, size: 21, color: ACCENT }) + inline(model.lead.what, { size: 21 }),
    { spaceBefore: 60, spaceAfter: 100, line: 340 },
  ))
  body.push(paragraph(
    run('用来干什么　', { bold: true, size: 21, color: ACCENT }) + inline(model.lead.purpose, { size: 21 }),
    { spaceBefore: 20, spaceAfter: 100, line: 340 },
  ))
  const problems = Array.isArray(model.lead.problems) ? model.lead.problems.filter(Boolean) : []
  if (problems.length > 0) {
    body.push(paragraph(run('能解决什么问题', { bold: true, size: 21, color: ACCENT }), {
      spaceBefore: 40, spaceAfter: 40, line: 320,
    }))
    body.push(bulletList(problems))
  }
  if (model.lead.audience) {
    body.push(paragraph(
      run('适合谁看　', { bold: true, size: 21, color: ACCENT }) + inline(model.lead.audience, { size: 21 }),
      { spaceBefore: 20, spaceAfter: 100, line: 340 },
    ))
  }
  const prerequisites = Array.isArray(model.lead.prerequisites) ? model.lead.prerequisites.filter(Boolean) : []
  if (prerequisites.length > 0) {
    body.push(paragraph(run('前置知识', { bold: true, size: 21, color: ACCENT }), {
      spaceBefore: 20, spaceAfter: 40, line: 320,
    }))
    body.push(bulletList(prerequisites))
  }

  let firstSection = true
  for (const section of model.sections ?? []) {
    if (!section?.heading) continue
    body.push(heading(String(section.heading), 2, firstSection ? { pageBreakBefore: true } : {}))
    firstSection = false
    body.push(renderBlocks(section.blocks))
  }

  const takeaways = Array.isArray(model.takeaways) ? model.takeaways.filter(Boolean) : []
  if (takeaways.length > 0) {
    body.push(heading('要点回顾', 2))
    body.push(bulletList(takeaways))
  }
  const nextSteps = Array.isArray(model.nextSteps) ? model.nextSteps.filter(Boolean) : []
  if (nextSteps.length > 0) {
    body.push(heading('接下来可以做什么', 2))
    body.push(stepList(nextSteps))
  }

  if (model.footer) {
    body.push(horizontalRule())
    body.push(paragraph(run(model.footer, { size: 17, color: '999999' }), {
      spaceBefore: 40, spaceAfter: 0, line: 260,
    }))
  }

  const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<w:body>'
    + body.join('')
    + '<w:sectPr>'
    + '<w:footerReference w:type="default" r:id="rId2"/>'
    + '<w:pgSz w:w="11906" w:h="16838"/>'
    + '<w:pgMar w:top="1418" w:right="1247" w:bottom="1418" w:left="1247" w:header="851" w:footer="992" w:gutter="0"/>'
    + '<w:cols w:space="425"/>'
    + '<w:docGrid w:linePitch="312"/>'
    + '</w:sectPr>'
    + '</w:body></w:document>'

  const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:docDefaults><w:rPrDefault><w:rPr>'
    + `<w:rFonts w:ascii="${BODY_FONT}" w:hAnsi="${BODY_FONT}" w:eastAsia="${BODY_FONT}" w:cs="${BODY_FONT}"/>`
    + `<w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/>`
    + '</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>'
    + '<w:spacing w:after="80" w:line="300" w:lineRule="auto"/>'
    + '</w:pPr></w:pPrDefault></w:docDefaults>'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
    + `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="${ACCENT}"/><w:sz w:val="32"/></w:rPr></w:style>`
    + '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="1F4E79"/><w:sz w:val="26"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:color w:val="2E5E8C"/><w:sz w:val="23"/></w:rPr></w:style>'
    + '</w:styles>'

  const footer = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="0"/></w:pPr>'
    + `<w:r><w:rPr>${fonts(BODY_FONT)}<w:color w:val="999999"/><w:sz w:val="17"/></w:rPr><w:t xml:space="preserve">第 </w:t></w:r>`
    + '<w:fldSimple w:instr=" PAGE "><w:r><w:rPr><w:color w:val="999999"/><w:sz w:val="17"/></w:rPr><w:t>1</w:t></w:r></w:fldSimple>'
    + `<w:r><w:rPr>${fonts(BODY_FONT)}<w:color w:val="999999"/><w:sz w:val="17"/></w:rPr><w:t xml:space="preserve"> / </w:t></w:r>`
    + '<w:fldSimple w:instr=" NUMPAGES "><w:r><w:rPr><w:color w:val="999999"/><w:sz w:val="17"/></w:rPr><w:t>1</w:t></w:r></w:fldSimple>'
    + `<w:r><w:rPr>${fonts(BODY_FONT)}<w:color w:val="999999"/><w:sz w:val="17"/></w:rPr><w:t xml:space="preserve"> 页 · bili-lecture</w:t></w:r>`
    + '</w:p></w:ftr>'

  const settings = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:zoom w:percent="100"/><w:defaultTabStop w:val="420"/>'
    + '<w:characterSpacingControl w:val="compressPunctuation"/>'
    + '</w:settings>'

  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>'
    + '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>'
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
    + '</Types>'

  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
    + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
    + '</Relationships>'

  const documentRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>'
    + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>'
    + '</Relationships>'

  const created = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const core = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
    + 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
    + 'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + `<dc:title>${xml(model.title)}</dc:title>`
    + '<dc:creator>bili-lecture</dc:creator>'
    + '<cp:lastModifiedBy>bili-lecture</cp:lastModifiedBy>'
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>`
    + `<dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified>`
    + '</cp:coreProperties>'

  const app = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
    + 'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
    + '<Application>bili-lecture</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>'
    + '</Properties>'

  return zip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(document, 'utf8') },
    { name: 'word/styles.xml', data: Buffer.from(styles, 'utf8') },
    { name: 'word/settings.xml', data: Buffer.from(settings, 'utf8') },
    { name: 'word/footer1.xml', data: Buffer.from(footer, 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(documentRels, 'utf8') },
    { name: 'docProps/core.xml', data: Buffer.from(core, 'utf8') },
    { name: 'docProps/app.xml', data: Buffer.from(app, 'utf8') },
  ])
}
