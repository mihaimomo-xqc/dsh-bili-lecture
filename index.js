/** Host half of bili-lecture: registers the `bili_lecture` tool. */

import { createBiliLectureTool } from './lib/tool.js'

export const name = 'bili-lecture'

export const inject = ['tools']

/**
 * Register the tool for as long as this plugin is mounted.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, any>} config
 */
export function apply(ctx, config) {
  ctx.effect(
    () => ctx.tools.register(createBiliLectureTool(ctx, config)),
    'bili-lecture.tool',
  )
}
