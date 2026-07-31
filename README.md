# AIOS Core

> Project Agent Runtime — 让 AI Agent 长期稳定地开发一个项目。

AIOS Core 是一个**单 Agent 软件工程执行内核**，用项目状态驱动 Agent 的开发行为。

不是操作系统。不是平台。不是多 Agent 编排器。

## 核心思想

```
先规划。后审批。再执行。最后验证，落库。
```

- **项目状态驱动** — Agent 由项目事实和决策驱动，不是上下文
- **单 Agent** — 任何时刻只有一个执行主体
- **可回滚** — 任何写操作配套 rollback 路径
- **项目记忆是核心** — 持久化项目事实和决策；不存聊天、模型思考、向量

## 架构

```
aios-core/
├── kernel/       # 执行内核: planner + executor + verifier + reconciler + runtime + schema
├── memory/       # 项目记忆: current/ tasks/ decisions/ architecture/ incidents/ staging/
├── governor/     # 治理护栏: scope + approval + rollback + audit
├── cli/          # 入口: aios run | plan | status | context | replay
└── tests/        # 244 个测试 (25 文件) + shadow/ 真实 I/O E2E
```

### 状态机

```
IDLE → PLAN → EXECUTE → VERIFY → COMMIT → DONE
                                     │
                                     │ 失败
                                     ▼
                                 ROLLBACK → DONE
```

### 核心模块

| 模块 | 职责 |
|------|------|
| `kernel/runtime.ts` | 状态机唯一驱动器 (SSOT) |
| `kernel/planner.ts` | 任务理解 + 方案生成 |
| `kernel/executor.ts` | 改代码、跑命令、生成 diff |
| `kernel/verifier.ts` | 验证执行结果 |
| `kernel/reconciler.ts` | 纯函数决策出口（禁止调模型、禁止 IO） |
| `kernel/invariant.ts` | 状态不变量检查 |
| `kernel/failure.ts` | 失败分类（transient/deterministic/permission/corruption/resource） |
| `kernel/statehash.ts` | 执行指纹 + 哈希链（可验证确定性） |
| `governor/scope.ts` | 路径/命令/文件类型白黑名单 |
| `governor/approval.ts` | AUTO/MANUAL 两级审批 |
| `governor/rollback.ts` | git restore / git revert / snapshot 回滚 |
| `governor/audit.ts` | append-only 审计日志 |
| `governor/limits.ts` | 终止条件（maxTurns, maxContext, maxRetries） |
| `memory/index.ts` | 项目记忆存储（append-only + current 可覆盖） |
| `memory/context.ts` | 上下文窗口管理 |

## 安装

```bash
git clone https://github.com/jamesoldman/aios-core.git
cd aios-core
npm install
```

## 用法

```bash
# 完整流水线
aios run "fix login bug" --project myapp

# 分步执行（仅 plan/run 已实现；execute/verify/commit 尚未实现）
aios plan "fix login bug" --project myapp

# 查看状态
aios status

# 回放
aios replay --last
aios replay --task task_042
```

## 测试

```bash
npm test          # 244 个测试（25 文件）
npm run typecheck # TypeScript 类型检查
```

## 项目记忆

只有 COMMIT 能写正式 memory：

| 目录 | 可变性 | 写时机 |
|------|--------|--------|
| `current/` | **唯一可覆盖** | 状态推进 |
| `decisions/` | append-only | 决策落地 |
| `tasks/` | append-only | 任务完成 |
| `incidents/` | append-only | 失败复盘 |

## 设计约束

- Reconciler 是**唯一**决策出口，纯函数，禁止调模型、禁止 IO
- Governor 是护栏不是引擎 — 拦住不该做的，但不驱动该做的
- staging/snapshot 隔离执行中状态，COMMIT 才 promote 到正式 memory
- 50-task shadow 测试验证确定性：相同输入 → 相同输出

## 不做什么

❌ 多 Agent / Mesh / 工作流编排
❌ 向量库 / 知识图谱 / 人格记忆
❌ 预算 / 成本追踪 / 经济系统
❌ 自动演化 / 云调度

只做：项目记忆、执行、治理、恢复。

## License

MIT
