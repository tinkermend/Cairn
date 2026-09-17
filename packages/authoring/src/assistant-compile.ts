import type { ScenarioDocument } from '@cairn/shared'
import { compileScenarioDocument } from './compiler.js'

export function compileForAssistant(document: ScenarioDocument) {
  return compileScenarioDocument(document, { mode: 'release' })
}
