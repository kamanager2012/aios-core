# AIOS Core

> Agent Reliability Kernel — 面向 Coding Agent 的任务契约、证据门、确定性验证、回放与回滚内核。

AIOS Core 正在从原来的三层 **Agent Governance Stack** 收敛成一个 canonical reliability 项目。目标不是再造一个 Agent Loop、Sandbox 或模型路由器，而是回答一个更实际的问题：**Agent 声称任务完成以后，我们能不能用结构化证据证明它真的完成了，并且在 Agent/模型版本升级后量化回归。**

项目总览：[Kama Projects](https://kamanager2012.github.io/)。

## 核心思想

```text
Task Contract
    ↓
PLAN → EXECUTE → VERIFY
                  ↓
             Evidence Gate
              ↙        ↘
          COMMIT      ROLLBACK
              ↓
        Replay / Regression
```

模型越强，不代表不需要验证；只是验证重点从“限制模型每一步”转向“证明最终执行结果成立”。AIOS 因此聚焦**任务结果证据**，不和上游 Agent Runtime 重复建设底层安全能力。

## Task Contract

任务契约定义一个任务被接受前必须具备的最低证据：

```ts
const contract = {
  version: 1,
  requiredEvidence: ["test", "build", "diff"],
  acceptance: {
    minTestsPassed: 20,
  },
};
```

Verifier 当前会产生 build、test、lint、E2E、diff 的结构化证据。Reliability Gate 输出三种结果：

- `PASS` — 所有必需证据存在且满足契约。
- `FAIL` — 必需证据存在，但验证失败或不满足接受条件。
- `INCOMPLETE` — 必需证据缺失，不能把任务当成已完成。

没有 Task Contract 的旧任务继续保持原有 verify-pass 行为，避免为重构破坏现有调用。

## 架构

```text
aios-core/
├── kernel/
│   ├── runtime.ts       # 状态机唯一驱动器（SSOT）
│   ├── planner.ts       # Task → 冻结 Plan
│   ├── executor.ts      # 执行适配边界
│   ├── verifier.ts      # 结构化验证证据
│   ├── reliability.ts   # Evidence Gate + 回归比较（纯函数）
│   ├── reconciler.ts    # 唯一确定性 COMMIT/ROLLBACK 决策出口
│   ├── replay.ts        # 确定性审计回放
│   ├── invariant.ts     # 状态不变量
│   ├── failure.ts       # 失败分类
│   └── statehash.ts     # 执行指纹 + 哈希链
├── governor/            # scope / approval / rollback / audit / limits
├── memory/              # 项目状态记忆与 staging
├── cli/
└── tests/
```

### 状态机保持冻结

```text
IDLE → PLAN → EXECUTE → VERIFY → COMMIT → DONE
                         │
                         └──────→ ROLLBACK → DONE
```

这次 reliability 重构**不增加任何状态**。Evidence Gate 位于现有 VERIFY → decision 边界内，不制造第二套执行状态机。

## Regression

`kernel/reliability.ts` 可以按 `taskId` 对两个 Agent/模型版本的 reliability run 进行比较，并输出：

- regression：`PASS → INCOMPLETE/FAIL`、`INCOMPLETE → FAIL`
- improvement：`FAIL/INCOMPLETE → PASS`、`FAIL → INCOMPLETE`
- 未变化任务
- candidate 缺失任务
- candidate 新增任务

目标不是再造一个通用 Benchmark 排行榜，而是形成面向真实项目的 **Agent CI**。

## 原三项目如何收敛

不会把三个仓库机械复制到一起。

| 原项目 | 应保留下来的资产 |
|---|---|
| `agent-constraint-system` | benchmark scenarios、known bypass/false positive、constraint taxonomy、adapter evidence |
| `governor-core` | canonical policy 语义、policy validation/normalization、audit 语义 |
| `aios-core` | 执行状态机、verification、invariant、failure recovery、replay、rollback、project-state memory |

Codex / Claude / Gemini 等 Agent Runtime 已经原生支持的 sandbox、permission、network policy 等能力，优先调用上游能力，而不是自己重做第二套。

## 安装

```bash
git clone https://github.com/kamanager2012/aios-core.git
cd aios-core
npm install
```

## 用法

```bash
# 完整流水线
aios run "fix login bug" --project myapp

# 规划
aios plan "fix login bug" --project myapp

# 状态
aios status

# 回放
aios replay --last
aios replay --task task_042
```

现有 CLI 保持兼容；Task Contract 当前先通过 kernel API 暴露，CLI 体验后续再收敛，避免第一阶段扩大范围。

## 验证

```bash
npm run check
```

`check` 会依次执行 architecture guard、TypeScript typecheck 和完整 Vitest 测试。

## 设计约束

- Runtime 是唯一状态机驱动器。
- Reconciler 是唯一决策出口，必须保持纯函数、禁止模型调用、禁止 IO。
- Task Contract 只能让验收更严格，不能绕过现有 build/test/lint/e2e 失败。
- 缺少必需证据绝不等于成功。
- 项目记忆只保存项目事实和决策，不保存聊天、模型思考或向量人格记忆。
- staging/snapshot 隔离执行中状态，只有 COMMIT 才能 promote。
- Audit / replay 必须保持确定性和可独立验证。

## 不做什么

AIOS Core 不做：

- 新的通用 Agent Loop
- Multi-Agent Mesh / 通用编排框架
- 第二套 Sandbox / 网络隔离层
- 模型 Router
- 向量记忆 / 人格系统
- 云调度 / 自动经济系统

目标收窄为：**为真实 Coding Agent 工作提供可靠的执行验收和回归证据。**

## License

MIT

---

[English](./README.md)
