# Bold Wrapper Prompt Guidance Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 worker 在生成与修复提示中明确告诉 LLM：关键词外层连续两个星号 `**` 不计入字符长度。

**Architecture:** 保持现有长度校验实现不变，只补强 prompt 层。把这条规则同时写进 section system prompt、repair system prompt，以及 bullets 的执行/修复指导，确保 writer、reviewer、repairer 共用同一口径。

**Tech Stack:** TypeScript, Node test runner

---

### Task 1: 提示词失败测试

**Files:**
- Modify: `src/services/section-guidance.test.ts`
- Create: `src/services/generation-service-prompts.test.ts`

1. 为 bullets 执行指导增加断言，要求出现“连续两个星号 `**` 不计入字符数”。
2. 为 bullets 修复指导增加断言，要求出现同样说明。
3. 新增 generation service prompt 测试，要求 system prompt 与 whole repair prompt 也出现同样说明。
4. 运行相关测试，先看到失败。

### Task 2: 最小实现

**Files:**
- Modify: `src/services/section-guidance.ts`
- Modify: `src/services/generation-service.ts`

1. 在 bullets 执行指导里补充长度统计说明：空格和标点计入，但连续两个星号 `**` 不计入。
2. 在 bullets 修复指导里补充同样说明。
3. 在 `constraintsSummary()` 中补充统一说明，让 system prompt 与 repair system prompt 都带上这条规则。

### Task 3: 验证与联调

**Files:**
- Verify only

1. 运行新增测试文件与 `section-guidance.test.ts`。
2. 运行 `npm test`。
3. 部署：`/Users/wxy/go/bin/syl-listing-pro-x worker deploy --server syl-server`。
4. 真实 e2e：`/Users/wxy/go/bin/syl-listing-pro /Users/wxy/Downloads/test/12个装10寸开学季灯笼.md --verbose`。
5. 确认日志中规则版本正确，且后续失败/成功行为符合当前新提示词预期。
