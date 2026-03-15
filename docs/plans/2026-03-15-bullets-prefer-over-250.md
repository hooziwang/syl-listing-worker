# Bullets Prefer Over 250 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 bullets 的生成与候选评分都明确偏向“略高于 250 字符”的更稳妥长度，而不是继续贴着 240-250 下边缘。

**Architecture:** 同时改 rules 文案、worker 提示词指导和候选评分目标。rules 与 system prompt 统一强调 bullets 的硬约束仍是 `>=240` 且 `<=300`，但最佳落点改为 `255-265`；评分逻辑也切到同一偏好，避免系统继续偏爱 245 左右的短文案。

**Tech Stack:** TypeScript, YAML rules, Node test runner

---

### Task 1: 写失败测试

**Files:**
- Modify: `src/services/section-guidance.test.ts`
- Modify: `src/services/generation-service-prompts.test.ts`
- Modify: `src/services/generation-service-format.test.ts`

1. 把 bullets guidance 测试改成期望“最佳落点 255-265，略高于 250 更稳妥”。
2. 增加 prompt 测试，要求 bullets 的 constraints summary 对外显示的容差下限仍是 `240`，不能错误显示成 `190`。
3. 增加评分测试，验证两个都合法的 bullets 候选中，`255-265` 这一档得分优于 `245` 左右。
4. 运行这些测试，先看到失败。

### Task 2: 最小实现

**Files:**
- Modify: `src/services/section-guidance.ts`
- Modify: `src/services/generation-service.ts`
- Modify: `../rules/tenants/syl/rules/sections/bullets.yaml`

1. 在 `bullets.yaml` 中把自检文案改成“最佳长度优先控制在 255-265”，并补充 `preferred_min_chars_per_line` / `preferred_max_chars_per_line`。
2. 在 section guidance 中读取 preferred range，把执行指导、修复指导、建议长度都切到 preferred range。
3. 在 generation service 的 constraints summary 中：
   - bullets 显示真实硬下限 `240`
   - 额外显示推荐范围 `255-265`
4. 在候选评分中，bullets 改用 preferred range 的 midpoint 作为目标，而不是 `(240+250)/2`。

### Task 3: 验证与联调

**Files:**
- Verify only

1. 运行相关测试文件。
2. 运行 `npm test`。
3. 部署 worker：`/Users/wxy/go/bin/syl-listing-pro-x worker deploy --server syl-server`。
4. 发布 rules 到 `https://worker.aelus.tech`。
5. 真实 e2e：`/Users/wxy/go/bin/syl-listing-pro /Users/wxy/Downloads/test/12个装10寸开学季灯笼.md --verbose`。
6. 确认日志中 bullets 的失败/成功轨迹已不再明显贴着 `240` 下边缘。
