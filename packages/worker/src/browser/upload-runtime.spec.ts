import { describe, expect, it } from 'vitest'
import { uploadToLocator } from './runtime.js'
import { withTestOccupancy } from './test-occupancy.js'

describe('uploadToLocator Runtime Behavior', () => {
  it('injects files directly when locator is an HTMLInputElement type=file', async () => {
    let setInputFilesCalledWith: any = null
    const mockLocator: any = {
      evaluate: async (fn: any) => {
        return fn({ tagName: 'INPUT', type: 'file', hasAttribute: (attr: string) => attr === 'multiple' })
      },
      setInputFiles: async (payloads: any) => {
        setInputFilesCalledWith = payloads
      },
    }

    const files = [
      { name: 'a.txt', mimeType: 'text/plain', bufferBase64: Buffer.from('hello').toString('base64'), byteSize: 5, sha256: 'sha1' },
      { name: 'b.txt', mimeType: 'text/plain', bufferBase64: Buffer.from('world').toString('base64'), byteSize: 5, sha256: 'sha2' },
    ]

    const result = await withTestOccupancy(() => uploadToLocator({} as any, mockLocator, files))
    expect(result).toEqual({ method: 'dom_direct', count: 2 })
    expect(setInputFilesCalledWith).toHaveLength(2)
  })

  it('rejects multiple files when target input does not have multiple attribute', async () => {
    let evalCount = 0
    const mockLocator: any = {
      evaluate: async (fn: any) => {
        evalCount++
        if (evalCount === 1) return true // isDirect
        return false // isMultiple
      },
    }

    const files = [
      { name: 'a.txt', mimeType: 'text/plain', byteSize: 5, sha256: 'sha1' },
      { name: 'b.txt', mimeType: 'text/plain', byteSize: 5, sha256: 'sha2' },
    ]

    await expect(withTestOccupancy(() => uploadToLocator({} as any, mockLocator, files))).rejects.toThrow(
      'UPLOAD_TARGET_SINGLE_ONLY',
    )
  })

  it('injects files via nested input[type=file]', async () => {
    let setInputFilesCalledWith: any = null
    const nestedInput: any = {
      count: async () => 1,
      evaluate: async () => true, // isMultiple
      setInputFiles: async (payloads: any) => {
        setInputFilesCalledWith = payloads
      },
    }
    const mockLocator: any = {
      evaluate: async () => false, // not direct
      locator: (sel: string) => {
        if (sel === 'input[type="file"]') {
          return {
            first: () => nestedInput,
          }
        }
        return { count: async () => 0 }
      },
    }

    const files = [{ name: 'a.txt', mimeType: 'text/plain', byteSize: 5, sha256: 'sha1' }]
    const result = await withTestOccupancy(() => uploadToLocator({} as any, mockLocator, files))
    expect(result).toEqual({ method: 'dom_direct', count: 1 })
    expect(setInputFilesCalledWith).toHaveLength(1)
  })

  it('falls back to filechooser when no input is found in DOM', async () => {
    let chooserFilesSet: any = null
    let clicked = false

    const mockFileChooser = {
      isMultiple: () => true,
      setFiles: async (payloads: any) => {
        chooserFilesSet = payloads
      },
    }

    const mockPage: any = {
      waitForEvent: async (event: string) => {
        if (event === 'filechooser') return mockFileChooser
        throw new Error('unknown event')
      },
    }

    const mockLocator: any = {
      evaluate: async () => false,
      locator: () => ({
        first: () => ({ count: async () => 0 }),
        // uploadToLocator 新增了「父级是否已是 FORM/BODY/HTML 顶层容器」判定，
        // 会对 parentCandidate 调 evaluate；mock 补上，默认答「不是顶层容器」，
        // 与实现里 .catch(() => false) 的兜底值一致，走到下面按 0 个候选处理。
        evaluate: async () => false,
        locator: () => ({ first: () => ({ count: async () => 0 }) }),
        count: async () => 0,
      }),
      click: async () => {
        clicked = true
      },
    }

    const files = [{ name: 'a.txt', mimeType: 'text/plain', byteSize: 5, sha256: 'sha1' }]
    const result = await withTestOccupancy(() => uploadToLocator(mockPage, mockLocator, files))
    expect(result).toEqual({ method: 'file_chooser', count: 1 })
    expect(clicked).toBe(true)
    expect(chooserFilesSet).toHaveLength(1)
  })

  it('rejects upload when button is disabled', async () => {
    const mockLocator: any = {
      evaluate: async (fn: any) => {
        // First eval: isDirect -> false. Second eval: isDisabled -> true
        return fn({ disabled: true, getAttribute: () => null })
      },
      locator: () => ({
        first: () => ({ count: async () => 0 }),
        // uploadToLocator 新增了「父级是否已是 FORM/BODY/HTML 顶层容器」判定，
        // 会对 parentCandidate 调 evaluate；mock 补上，默认答「不是顶层容器」，
        // 与实现里 .catch(() => false) 的兜底值一致，走到下面按 0 个候选处理。
        evaluate: async () => false,
        locator: () => ({ first: () => ({ count: async () => 0 }) }),
        count: async () => 0,
      }),
    }

    const files = [{ name: 'a.txt', mimeType: 'text/plain', byteSize: 5, sha256: 'sha1' }]
    await expect(withTestOccupancy(() => uploadToLocator({} as any, mockLocator, files))).rejects.toThrow(
      'UPLOAD_PRECONDITION_FAILED',
    )
  })

  it('throws UPLOAD_NO_FILE_INPUT if filechooser does not open', async () => {
    const mockPage: any = {
      waitForEvent: async () => {
        throw new Error('Timeout 3000ms exceeded while waiting for event "filechooser"')
      },
    }

    const mockLocator: any = {
      evaluate: async () => false,
      locator: () => ({
        first: () => ({ count: async () => 0 }),
        // uploadToLocator 新增了「父级是否已是 FORM/BODY/HTML 顶层容器」判定，
        // 会对 parentCandidate 调 evaluate；mock 补上，默认答「不是顶层容器」，
        // 与实现里 .catch(() => false) 的兜底值一致，走到下面按 0 个候选处理。
        evaluate: async () => false,
        locator: () => ({ first: () => ({ count: async () => 0 }) }),
        count: async () => 0,
      }),
      click: async () => {},
    }

    const files = [{ name: 'a.txt', mimeType: 'text/plain', byteSize: 5, sha256: 'sha1' }]
    // 等 filechooser 超时后，实现把这类失败统一归并进 UPLOAD_NO_FILE_INPUT
    // （没找到文件输入元素、点击目标也没能唤起文件选择），不再单独区分超时错码。
    await expect(withTestOccupancy(() => uploadToLocator(mockPage, mockLocator, files))).rejects.toThrow(
      'UPLOAD_NO_FILE_INPUT',
    )
  })
})
