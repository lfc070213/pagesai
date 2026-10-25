'use strict';
// Paper 模块自有错误码。
// 约定：
//  - 能力未配置一律 409，且 code 必须显式可判别（不得静默降级成「假结果」）；
//  - 提取失败一律 422，禁止返回空正文冒充成功；
//  - 其余通用错误复用 core/errors.js 的 codes（INVALID_INPUT/FORBIDDEN/NOT_FOUND/CONFLICT）。

const PAPER_CODES = Object.freeze({
  EXTRACT_FAILED: 'paper.extract_failed',
  UNSUPPORTED_FILE: 'paper.unsupported_file',
  NOT_READY: 'paper.not_ready',
  FILE_NOT_AVAILABLE: 'paper.file_not_available',
  TRANSLATE_NOT_CONFIGURED: 'paper.translate_not_configured',
  TRANSLATE_IN_PROGRESS: 'paper.translate_in_progress',
  TRANSLATE_FAILED: 'paper.translate_failed',
  TRANSLATE_STOPPED: 'paper.translate_stopped',
  QA_NOT_CONFIGURED: 'paper.qa_not_configured',
  QA_FAILED: 'paper.qa_failed'
});

module.exports = { PAPER_CODES };
