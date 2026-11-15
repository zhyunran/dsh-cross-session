# dsh-cross-session

**让一个 DSH 会话里的 AI 直接和另一个真实 DSH 会话对话：发消息、发文件、翻它的历史、读它自己的最终答复。是对等会话（peer session），不是子 agent。**

[English](README.md)

---

## 为什么需要它

子 agent 的好处是随叫随到，坏处是共享你的回合、你的上下文窗口和你的失败模式。而一个**真实会话**——能在侧边栏点开、有独立模型、独立工具、独立长期历史——在很多任务里是更好的执行者。但在此之前，一个 agent 没有任何办法够到它。

`dsh-cross-session` 给 agent 六个工具，把其他顶层 DSH 会话当成对等体：

| 工具 | 作用 |
|---|---|
| `cross_session_list` | 列出其他会话，给出准确的 id / 标题 / 工作目录 / 状态。支持按名字找「B 会话」「C、D、E 那三个」。 |
| `cross_session_create` | **新建一个空白顶层会话**，可选工作目录、标题和 agent preset。返回 session id；它不是子代理。 |
| `cross_session_send` | 向一个或多个会话发送消息和**真正的文件附件**。目标会话会像收到用户任务一样醒来执行。 |
| `cross_session_read` | 读对方的**原始对话记录**：用户消息、assistant 回复，可选工具调用/结果。冷会话也能读。 |
| `cross_session_search` | 在对方整个对话里按字面词搜索（多个词需出现在同一条消息里）。 |
| `cross_session_wait` | 等待一个或多个对等会话彻底空闲，然后返回各自最后一条 assistant 消息（从日志里读）。 |

最后两个是关键：**验收方式是读对方自己的对话原文**，而不是相信一个回传信封。这才是「跨会话开发」和「派出去碰运气」的区别。

## 新建顶层会话

`cross_session_create` 是 0.2.0 新增的写操作，默认在代码层关闭；本仓库的 `cordis.patch.yml` 明确启用。

```text
cross_session_create({ cwd: "C:\\work\\project-b", title: "B 工作区", agent_preset: "talk" })
→ { sessionId: "session-...", created: true, cwd: "...", title: "..." }
```

- 新会话是**普通的空白顶层会话**：有自己的 transcript、模型、工具和工作区，不是子代理，也不是 Team 成员。
- 创建后默认不会自动给它任务；用 `cross_session_send` 把第一条任务发给返回的 id。
- 新会话在首轮之前是 `blank`；`cross_session_list` 默认隐藏 blank，需要加 `include_blanks: true` 才能看到。
- 子代理不能调用；部署可以用 `allowCreate`、`createRoots`、`maxCreatePerMinute` 收紧。

## 用起来是什么样

**沿用另一个会话的开发要求**

> 用户：完成打包任务，要求和 B 会话的打包要求一致。
>
> AI：`cross_session_search({ session: "ManageBac 打包要求", query: "版本号 changelog" })` → 读到准确规则 → 照做。

**指挥一个小舰队**

> 用户：C、D、E 都做了一点，他们懂得更多，命令他们完成各自那部分。
>
> AI：`cross_session_send({ to: ["C","D","E"], message: "...", expect: "transcript" })` → 三个对等会话各自开工。
>
> 过一段时间：`cross_session_wait({ sessions: ["C","D","E"] })` → `cross_session_read` 逐个读原文 → 验收。

**向对等会话提问**

> `cross_session_send({ to: "session-B", message: "安装包那件事我们最后怎么定的？", expect: "reply" })`
>
> 对方会用 `cross_session_send` 回给你；或者你 `cross_session_wait` 之后读它的对话。

## 安装

需要 **DSH 0.2.x**（桌面版或 `dsh web`）。它就是一个普通 DSH bundle，不需要构建，除了宿主自带的 `@deepseek-ai/dsh-tools` 之外没有运行时依赖。

### 方式 A —— DSH 插件管理器（推荐）

1. 下载包：
   - GitHub Release / 仓库 `dist/` 里的 `dsh-cross-session-0.2.0.tgz`，**或** 克隆本仓库；
2. 打开 **DSH → 设置 → 插件**，从以下任一来源安装：
   - 本地 tarball 绝对路径；
   - 含 `package.json` 的本地目录；
   - 如果你的 DSH 支持，也可以填 GitHub 地址。
3. **重启一次 DSH**，让宿主加载新 bundle。

### 方式 B —— 命令行

```powershell
# 本地 tarball（必须绝对路径；相对路径会被插件管理器拒绝）
dsh plugin --profile desktop add C:\path\to\dsh-cross-session-0.2.0.tgz

# 或 GitHub tarball（不需要安装 git）
dsh plugin --profile desktop add https://codeload.github.com/<owner>/dsh-cross-session/tar.gz/<40位commit>

# 如果发布到 npm
dsh plugin --profile desktop add dsh-cross-session
```

然后重启 DSH。插件通过 `cordis.patch.yml` 自动插入，**不需要**手动改 profile。

### 验证

对 AI 说：

> 列出这个 DSH 里的其他会话。

它应该调用 `cross_session_list` 并列出真实会话标题。如果工具不存在，说明 bundle 没加载——去 **设置 → 插件** 检查并重启一次。

### 状态

- 49 个单元测试全部通过（假宿主，`node --test test/*.test.mjs`）。
- 工具声明用真实 `dsh-tools` schema 编译器编译通过。
- 原有五个工具在隔离的 **DSH 0.2.0-rc.2** web 实例上做过端到端验证；0.2.0 的创建路径由假宿主单元测试和宿主 `sessionController.create` 契约覆盖，本次发布不声称已在真实宿主端到端验证。

## 配置

默认策略刻意保持开箱即用：**本 profile 内任意顶层会话都可以访问任意其他顶层会话**。DSH 是本机单用户 harness，装上插件本身就是授权。想收紧的话，在你自己的 profile 层覆盖这个条目：

```yaml
# <DSH_HOME>/profiles/<profile>/cordis.patch.yml
- id: dsh-cross-session
  config:
    access: workspace          # all | workspace | allowlist
    allowlist: []              # 会话 id、精确标题，或 "cwd:<绝对路径>"
    denylist: []               # 永远不列出、不读、不写
    allowSend: true
    allowRead: true
    allowCreate: false          # 默认关闭；本仓库 patch 打开
    createRoots: []             # 只允许在这些绝对目录下建会话；空=不限制
    maxCreatePerMinute: 5
    includeHeader: true
    messageSource: agent-message   # agent-message | user
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `access` | `all` | `all`=所有顶层会话；`workspace`=仅 `cwd` 相同；`allowlist`=仅 `allowlist` 内条目。 |
| `allowlist` | `[]` | `access: allowlist` 时生效。接受会话 id、精确标题、`cwd:<路径>`；`*` 匹配全部。 |
| `denylist` | `[]` | 任何模式下都拒绝；词法同 `allowlist`。 |
| `allowSend` / `allowRead` | `true` | 可分别禁用写/读。 |
| `allowCreate` | `false` | 代码默认禁止 `cross_session_create`；仓库自带 patch 显式设为 `true`。 |
| `createRoots` | `[]` | 非空时，新会话的 `cwd` 必须位于这些绝对目录之一。 |
| `maxCreatePerMinute` | `5` | 每个进程每分钟最多成功创建几个顶层会话。 |
| `includeHeader` | `true` | 消息前加一段头：发送方 id、说明这是对等会话消息、给出回复工具。 |
| `messageSource` | `agent-message` | `agent-message` 保留真实归属（`senderSessionId`），在对方 UI 显示为「收到任务消息」；`user` 则看起来像真人输入。 |
| `maxFileBytes` | 25 MiB | 单个附件大小上限（字节原样存入 append-only 附件库）。 |
| `maxFiles` | 8 | 单条消息附件数上限。 |
| `maxMessageChars` | 100000 | 消息文本上限。 |
| `maxTranscriptChars` | 60000 | 单次 read/wait 返回文本上限。 |
| `maxEvents` | 20000 | read/search 的事件扫描安全上限。 |
| `defaultReadLimit` | 20 | `cross_session_read` 默认返回条数。 |
| `defaultSearchLimit` | 10 | `cross_session_search` 默认命中数。 |
| `defaultWaitSeconds` | 120 | 默认等待预算。 |
| `maxWaitSeconds` | 600 | 等待硬上限。 |

配置写错**不会**变成放开权限：插件会记录错误并退化为「全部拒绝」，同时不会阻止 DSH 启动。

## 工具参考

### `cross_session_list`

```jsonc
{
  "query": "ManageBac",      // 可选：标题 / id / cwd 子串
  "include_self": false,
  "include_subagents": false,
  "include_blanks": false,
  "limit": 20                 // 上限 50
}
```

返回 `{ total, matched, hidden, sessions[] }`，每行含 `id`、`title`、`cwd`、`updatedAt`、`running`、`live`、`blank`、`self`。

### `cross_session_send`

```jsonc
{
  "to": "ManageBac 打包要求",        // id 或唯一标题；字符串或字符串数组
  "message": "……",
  "files": ["C:\\\\work\\\\spec.md"],  // 绝对路径，或相对本会话 cwd
  "mode": "followup",               // followup=下一回合 | steer=当前回合下一步
  "expect": "auto",                 // auto | reply | transcript
  "wait": false,                    // true=阻塞到对方空闲并返回最终文本
  "timeout_seconds": 120
}
```

- `to` 支持单个目标或数组（一次发给多个会话）。数组发送的是**同一条**消息；要给每个会话不同指令就分别调用。
- `files` 的字节会原样复制进 DSH 的持久附件库，在对方对话里以真正的 `file` 块出现——对方的模型能读，对方的用户能看到。
- `mode: "followup"` 排到下一回合并唤醒目标；`mode: "steer"` 若目标正在跑，则插入它下一步。
- `expect` 只控制写进消息里的指引：
  - `transcript`：在你自己会话里干完即可，发送方会读你的对话原文（最适合「读原文验收」）；
  - `reply`：完成后用 `cross_session_send` 把结果发回来；
  - `auto`：有用就回，发送方也可能直接读。
- 成功返回前会走 `ctx.sessions.flush` 落盘；**冷会话**会经 Session controller 用它自己的 preset/模型选择恢复成真实会话。
- 返回里有 `baselineSeq`；以后把它作为 `after_seq` 传给 `cross_session_read` 就能只看新增内容。

### `cross_session_read`

```jsonc
{
  "session": "session-…",
  "limit": 20,                    // 最近 N 条，上限 200
  "after_seq": 1234,              // 只取 seq >= 此值（增量轮询）
  "include_tools": false,         // 是否包含工具调用/结果
  "max_chars_per_message": 2000
}
```

通过 `Session.inspect` 读持久日志，活会话和冷会话都能读，且不会激活 Agent。条目形如 `{ seq, time, role, source?, tools?, text }`。

### `cross_session_search`

```jsonc
{
  "session": "session-…",
  "query": "版本号 changelog",     // 空格分词，所有词必须出现在同一条消息
  "limit": 10,
  "context_chars": 160,
  "include_tools": false,
  "case_sensitive": false,
  "after_seq": 0
}
```

返回带 `seq` / `time` / `role` 的片段；要看上下文就用 `cross_session_read({ after_seq: hit.seq - 50 })`。

### `cross_session_wait`

```jsonc
{
  "sessions": ["C", "D", "E"],
  "timeout_seconds": 120,   // 所有目标共享的总预算
  "after_seq": 1234         // 只报告 seq >= 此值的 assistant 消息
}
```

每个目标一行：`{ live, wasRunning, started, idle, timedOut, elapsedMs, lastAssistant?, error? }`。超时是**报告**而不是抛错，部分进度不会丢。

## 工作原理

```
 A 的 agent 回合
   │  cross_session_send
   ▼
 按 id/标题解析目标 ──► ctx.sessionController.resolveAgent(target)
   │                      ├─ 已活？直接用
   │                      └─ 冷？用它自己的 preset + 模型选择恢复
   ├─ 文件 → ctx.attachments.saveFile(bytes) → FileAttachmentRef
   ├─ createUserMessage(content, { kind:'agent-message', form:'relay', senderSessionId:A })
   ├─ agent.followup(message)（或 agent.steer）
   └─ ctx.sessions.flush(agent.session)   ← 持久化屏障
        │
        ▼
 B 自己的 agent loop：inbox → user/message → 模型回合 → assistant/message → turn/end
        │
        ▼
 A 之后：cross_session_read / _search / _wait → 读 B 的持久日志
```

这与 DSH 内置 **Schedule** 功能的投递路径完全相同（`resolveAgent` → `followup` → `flush`）。不手改会话文件、不创建子 agent，目标会话仍然是拥有自己模型、工具、工作区和历史的一等对话。

## 显示与唤醒行为（请读这一段）

- **目标 agent 会立刻开工**，与它的对话窗口是否打开无关。
- **如果目标对话正在 DSH 客户端里打开**，消息和新回合会实时出现。
- **如果没打开**，消息已经持久化，但客户端要等你点开那个会话（侧边栏点一下）才会渲染出来。这是客户端 follow 的行为，不是投递失败——对方其实已经干完了。
- 安装/升级插件需要**重启一次 DSH** 让宿主加载新 bundle。之后每条消息都不需要重启。
- 用 `messageSource: agent-message` 时，对方 UI 会显示「收到任务消息」触发卡片；想要像真人输入，就设 `messageSource: user`。

## 安全与限制

- 只寻址**顶层**会话。子 agent 分支（以及 Agent Teams 成员分支）会被过滤并明确拒绝。
- 会话不能给自己发消息；子 agent 调用者会被拒绝（应向上报告给父会话）。
- `access` 与 `denylist` 在**每次调用**时评估（包括 list/read/search），改策略立即生效。
- `cross_session_send` 会校验目标；标题有歧义时返回候选列表，绝不瞎猜。
- 消息和文件都持久化；文件字节按内容寻址，天然去重。
- 等待受 `maxWaitSeconds` 约束；长任务请用 `after_seq` + `cross_session_read` 轮询，而不是无限阻塞。
- 不要互相等待（A 等 B，B 又等 A），它们会按设计超时。
- 读取超大会话受 `maxEvents` / `maxTranscriptChars` 限制，结果里会标注截断。

## 已知限制

- 只支持 DSH `0.2.x`；依赖 `ctx.sessionController.resolveAgent()`、`Agent.followup/steer` 和这一代的会话事件词汇。
- 不创建/删除会话：它只寻址已经存在的会话。需要新对等体时先在 UI 里新建一个对话。
- 一次调用不能给不同目标发**不同**消息；给每个目标分别调用。
- 工具输出是文本，还没有自定义 UI 卡片。
- `messageSource: user` 会让消息看起来像真人，但也可能让没有标题的对等会话用它来生成标题。

## 开发

```powershell
# 单元测试（不需要 DSH，使用假宿主）
node --test test/*.test.mjs

# 用真实 dsh-tools schema 编译器编译工具声明
# （schema-check/ 内有从本机 DSH 提取的副本；见 schema-check/check.mjs）
node ../schema-check/check.mjs

# 打包
npm pack
```

目录：

```
lib/index.js       插件入口（name / inject / apply）
lib/config.js      配置校验
lib/policy.js      谁能看/够到谁
lib/discovery.js   会话枚举、标题解析
lib/transcript.js  事件日志 → 可读条目 + 搜索
lib/transport.js   恢复、投递、落盘、等待
lib/create.js      创建顶层会话（校验/限额）
lib/tools.js       六个工具定义
lib/render.js      给模型看的文本
test/              假宿主单元测试
schema-check/      真实 defineTool 编译检查（不随包发布）
```

## 发布这个包

这个仓库本身就是一个可直接上传的包（无需构建）：

```powershell
git init
git add .
git commit -m "dsh-cross-session 0.2.0"
git branch -M main
git remote add origin https://github.com/<owner>/dsh-cross-session.git
git push -u origin main
```

然后在 GitHub 建一个 release `v0.2.0`，把 `dist/dsh-cross-session-0.2.0.tgz` 作为附件上传。别人有两条安装路径：

```powershell
# GitHub tarball（不需要 git）
dsh plugin --profile <profile> add https://codeload.github.com/<owner>/dsh-cross-session/tar.gz/<40位commit>

# 或下载 release 附件到本地
dsh plugin --profile <profile> add C:\path\to\dsh-cross-session-0.2.0.tgz
```

想发 npm 就 `npm publish --access public`（manifest 已带 `publishConfig`）。

## 许可

MIT，见 [LICENSE](LICENSE)。

---

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 而写。如果它让你少开了一个子 agent，它就值了。
