import { createHash } from 'node:crypto'
import {
  canonicalJson,
  type ModuleContent,
  type ModuleContract,
  type ModuleImplementation,
} from '@cairn/shared'

export function sha256Hex(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function computeContractDigest(contract: ModuleContract): string {
  return sha256Hex(contract)
}

export function computeImplementationDigest(implementations: ModuleImplementation[]): string {
  return sha256Hex(implementations)
}

export function computeSingleImplementationDigest(implementation: ModuleImplementation): string {
  return sha256Hex(implementation)
}

export function computeContentDigest(content: ModuleContent): string {
  return sha256Hex(content)
}
