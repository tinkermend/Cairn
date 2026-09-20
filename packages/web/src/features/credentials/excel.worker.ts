import { ExcelImportError, readExcel } from './excel'

self.onmessage = (event: MessageEvent<ArrayBuffer>) => {
  try {
    self.postMessage({ book: readExcel(new Uint8Array(event.data)) })
  } catch (error) {
    self.postMessage({
      error: error instanceof ExcelImportError ? error.message : '无法读取工作簿，请确认文件完整、未加密且为普通 .xlsx 格式',
    })
  }
}
