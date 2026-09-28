export type ErrorDiagnosis = {
  title: string
  description: string
  suggestion: string
  isRetryable: boolean
}

/**
 * 业务友好的人话错误转译器（Zero-Jargon Error Translator）
 * 将底层的技术异常码与堆栈信息转译为业务操作人员与测试人员能秒懂的诊断与排查建议。
 */
export function translateStepError(error?: { code?: string; safeMessage?: string }): ErrorDiagnosis {
  if (!error || !error.code) {
    return {
      title: '执行异常未明',
      description: error?.safeMessage || '步骤未能正常完成，底层未返回标准错误码。',
      suggestion: '请查看右侧【技术调试】标签下的原始日志，或点击下方按钮向识途助手诊断。',
      isRetryable: true,
    }
  }

  const code = error.code
  const message = error.safeMessage || ''

  switch (code) {
    case 'TARGET_NOT_FOUND':
    case 'ELEMENT_NOT_FOUND':
      return {
        title: '页面元素未找到',
        description: `在目标页面上未能匹配到指定的按钮、输入框或控件。${message ? `（详细信息：${message}）` : ''}`,
        suggestion: '目标系统可能发生了界面改版、处于加载中，或需要先执行前置操作让该元素出现。',
        isRetryable: true,
      }

    case 'TARGET_AMBIGUOUS':
      return {
        title: '页面匹配到多个相同元素',
        description: '定位条件匹配到了多个相似的控件，系统无法确定应该操作哪一个。',
        suggestion: '建议在编排器中增加更精确的选择器、文本限制或锚点。',
        isRetryable: false,
      }

    case 'ASSERT_FAILED':
      return {
        title: '业务核验与断言未通过',
        description: `页面上的实际内容与预期断言条件不符。${message ? `（差异：${message}）` : ''}`,
        suggestion: '请比对右侧【现场截图】和【成功条件】，确认业务数据是否符合本次运行期望。',
        isRetryable: true,
      }

    case 'ASSERT_TEMPLATE_INVALID':
    case 'SCENARIO_ASSERT_TEMPLATE_INVALID':
      return {
        title: '断言模板语法配置非法',
        description: '断言配置中的 Aria 快照或比对模板不合法，无法解析。',
        suggestion: '该错误属于配置问题，重试无法自愈。请进入场景编辑器修复断言语法。',
        isRetryable: false,
      }

    case 'DOWNLOAD_TIMEOUT':
    case 'ACTION_TIMEOUT':
    case 'STEP_TIMEOUT':
    case 'WAIT_TIMEOUT':
      return {
        title: '操作等待超时',
        description: `该步骤在规定时限内未完成或未等到预期响应。${message ? `（${message}）` : ''}`,
        suggestion: '目标系统当前响应可能较慢或网络卡顿，可尝试重新运行或适当增加步骤超时时间。',
        isRetryable: true,
      }

    case 'SURFACE_LOST':
    case 'PAGE_CRASHED':
      return {
        title: '受管页面失联或崩溃',
        description: '浏览器页面在执行过程中意外关闭或崩溃。',
        suggestion: '可能是目标页面内存占用过大或被目标系统主动重定向断开。',
        isRetryable: true,
      }

    case 'SESSION_LEASE_LOST':
      return {
        title: '会话租约失效',
        description: '与受管浏览器的连接通道中断或执行节点租约已到期释放。',
        suggestion: '系统已安全终止本次运行，请重新发起一次运行。',
        isRetryable: true,
      }

    case 'AUTH_RECOVERY_LIMIT':
    case 'AUTH_UNRECOVERABLE':
      return {
        title: '目标账号登录态已失效',
        description: '执行过程中登录状态丢失，且自动恢复或人工等待已达到上限。',
        suggestion: '请前往【目标系统】管理页检查并重新认证该账号，确认登录有效后再运行。',
        isRetryable: false,
      }

    case 'NAVIGATE_OUT_OF_SCOPE':
      return {
        title: '页面跳转超出安全范围',
        description: '步骤尝试访问非该目标系统白名单内的外部域名。',
        suggestion: '请检查场景中配置的 URL 是否正确，或在目标系统设置中补充允许的域名。',
        isRetryable: false,
      }

    case 'UPLOAD_NO_FILE_INPUT':
    case 'UPLOAD_TARGET_NOT_FILE_INPUT':
    case 'UPLOAD_PRECONDITION_FAILED':
      return {
        title: '文件上传目标无效',
        description: '页面上未找到用于接收文件的上传输入框。',
        suggestion: '请确认是否需要先点击“浏览”或“上传”按钮以呼出文件选择控件。',
        isRetryable: false,
      }

    default:
      return {
        title: `执行异常 [${code}]`,
        description: message || '该步骤执行未达预期。',
        suggestion: '请先核对这一步的错误证据和步骤数据；如有截图也请查看。识途助手可整理已记录事实，具体根因仍需核查。',
        isRetryable: true,
      }
  }
}
