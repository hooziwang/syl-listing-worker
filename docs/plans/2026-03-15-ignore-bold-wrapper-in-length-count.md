# Ignore Bold Wrapper In Length Count Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 worker 的长度校验与候选评分在计算字符数时忽略 markdown 加粗包裹符 `**`。

**Architecture:** 在 `generation-service.ts` 提供统一的长度计数字符串函数，保留原始文本用于输出和关键词匹配，但把所有长度判断、长度报错和评分偏差统一切到“去掉 `**` 后”的可计数字符串。这样 bullets、title、description 等 section 共用同一规则口径。

**Tech Stack:** TypeScript, Node test runner

---

### Task 1: 失败测试

**Files:**
- Modify: `src/services/generation-service-format.test.ts`

1. 为 bullets 单条长度增加失败测试，验证 `**keyword**` 中的 4 个星号不计入长度。
2. 为 title 总长度增加失败测试，验证总长度判断忽略 `**`。
3. 为长度报错文案增加失败测试，验证报错里的“当前长度”也是忽略 `**` 后的值。
4. 运行 `npm run test:unit -- src/services/generation-service-format.test.ts`，确认先失败。

### Task 2: 最小实现

**Files:**
- Modify: `src/services/generation-service.ts`

1. 增加统一长度计数函数，只忽略 markdown 加粗包裹符 `**`，不改正文内容。
2. 将 section 总长度、每行长度、评分目标偏差、长度报错全部改为使用该函数。
3. 不改关键词顺序匹配、最终输出和 repair 指令生成逻辑。

### Task 3: 验证与联调

**Files:**
- Verify only

1. 运行 `npm test`。
2. 部署：`/Users/wxy/go/bin/syl-listing-pro-x worker deploy --server syl-server`。
3. 版本核对：`/Users/wxy/go/bin/syl-listing-pro-x worker check-remote-version --base-url https://worker.aelus.tech`。
4. 真实 e2e：在 `syl-listing-pro-x` 执行针对可用样例的真实验收，确保无非预期错误。
