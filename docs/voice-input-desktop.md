# 桌面端语音输入（Voice Input）· 验收文档

- 状态：已实施，待验收（2026-10-25）
- 范围：StepCode Desktop（`apps/desktop` + `apps/web`）输入框语音听写
- 本文档用途：产品验收 + PR 说明；技术实现只作索引，细节由前后端同学 review 时把关

---

## 1. 一句话

对着输入框说话，转写文字落进输入框光标处，改一改再发——和手打完全同一链路。

## 2. 背景与目标

终端已有语音插件 StepFun-Voice（服务终端用户，不动它）。桌面端缺「边说边改」的输入方式：本功能把语音听写做进 composer，目标是——

1. 输入框旁一个麦克风按钮，一键开始/结束；
2. 转写文字插入光标处，复用既有发送链路（Enter / Cmd+Enter / turn 运行中排队）；
3. 凭证自动配置：优先复用用户已有的 Step 凭证，不额外填 Key；
4. 不新增运行时依赖（Node 自带 WebSocket，已验证支持自定义鉴权头）。

非目标：不做「说完自动提交」（保持人工确认）；不做客户端 VAD（停顿判定用服务端 VAD）。

## 3. 产品交互（验收重点）

### 3.1 入口与外显规则

- 位置：输入框右侧控制区，模型选择器与发送按钮之间。
- **外显规则**：仅当检测到可用凭证（环境变量 Key / 登录态 / MP 自定义通道三级解析，host 侧 `/api/v1/voice` 一次性判定）时按钮才渲染；**不可用时按钮不外显**（承修的建议——不留灰色禁用态，避免无谓困惑）。凭证查询未返回前同样不渲染，无闪烁。
- 按钮态：空闲（麦克风图标）→ 点击后连接中（转圈）→ 录音中（红色、放大、轻脉冲）。

### 3.2 录音条（录音中）

点麦克风后按钮上方浮出录音条（不挤压 composer 布局）：

- **波形条 ×5**：随真实说话音量实时起伏（采集端每 100ms 算一次音量推上来，非假动画）；
- **计时**：mm:ss；
- **✕ 取消**：丢弃本次录音，不转写、不插入，立即 idle；
- **✓ 完成**：停止收音并转写插入。

### 3.3 转写等待态

点「完成」后录音条变为「识别中…」直到文字落进输入框——服务端需约 0.5s 静音封口 + 转写耗时，这一两秒空窗有明确反馈，不会误以为卡死。

### 3.4 文字落点与发送

- 文字插入光标处，与前文自动隔一个空格；发送按钮状态同步（和手打一致）。
- turn 运行中听写：文字照常进输入框，走排队，与手打语义相同。
- 本协议**只有最终稿、没有逐字流式**（核对过终端插件源码），故不做流式上屏；说完停顿约半秒文字出现，与手机听写习惯一致。

### 3.5 快捷键与边界

- **Esc**：取消并丢弃本次录音（不插入）。
- 说完立即点完成：尾句可能丢（服务端 VAD 未封口，server_vad 模式下拒绝手动 commit）——说完停半秒再点最佳。
- 错误场景（断网 / 服务不可达 / 模型不可用 / 麦克风被拒 / 采集失败）：toast 明确提示原因与下一步，按钮回空闲可重试。

## 4. 验收清单

- [ ] 有凭证：按钮外显；点麦克风 → 系统授权弹窗（首次）→ 录音条（波形/计时/取消/完成）→ 说话 → 停半秒或点完成 → 文字进输入框 → Enter 发送成功
- [ ] 无凭证（未登录且无 Key）：按钮不外显，composer 无残留占位
- [ ] 录音中点 ✕：立即丢弃，无文字、无 toast，可立即重录
- [ ] 录音中按 Esc：同上
- [ ] turn 运行中听写：文字进输入框并排队，不抢占、不报错
- [ ] 断网点麦克风：清晰错误 toast，按钮回空闲
- [ ] 转写等待态可见（「识别中…」），最终文字落框

## 5. 已知边界

- **司内 MP 是否支持 realtime 模型未经真实验证**：凭证通道已按 Step Plan 优先、平台通道不支持时报错并引导换 Key 处理；若 MP 侧确认不支持，仅影响默认模型选择，架构不变（host 一处常量）。
- 仅桌面端目标环境（Electron/Chromium 内核）；Safari 非目标宿主。
- 采集为 24kHz 单声道 PCM16，与服务端约定一致。

## 6. 实现概览（技术索引，供 review 把关）

| 层 | 位置 | 内容 |
|---|---|---|
| host | `apps/web/src/voice.ts`（新） | 语音中继：出站 realtime 连接、转写事件归一化去重（final 按 item_id+content_index 去重）、单会话、分片/时长/大小上限、凭证三级解析；停止时补发静音封口等 final |
| host | `apps/web/src/voice-routes.ts`（新） | 5 端点：status / start / audio / stop / events(SSE)；`server.ts` 接线 + 关机清理 |
| host | `apps/web/test/voice.test.ts`（新） | 22 单测：握手（等 session.updated）、转发、去重、回退、限额、SSE、flush |
| 客户端 | `apps/web/client/src/features/voice/`（新） | MicButton + 录音条 UI；VoiceRecorder（getUserMedia→AudioWorklet 100ms 分片→POST、EventSource、取消/完成语义）；`client/public/voice-capture-worklet.js` 采集 + 音量 |
| 客户端 | composer / ShellEffects / i18n / IconSprite / types | 挂载按钮、Escape 取消链、双语文案、麦克风图标、wire 类型 |
| 桌面端 | `apps/desktop/src/window.ts` | 放行麦克风权限（media） |
| 协议 | `apps/web/openapi.yaml` | 5 端点 + VoiceStatus schema |
| e2e | `apps/web/test/e2e/web.e2e.mjs` | 新增 1 用例：按钮在 composer 内、可用态、status 不泄漏 Key |

**关键协议事实**（联调实测，2026-10-25）：`session.update` 必须带 `turn_detection`（server_vad，缺失则服务端不收尾、永远无转写）；start 等 `session.updated` 确认后才推音频；server_vad 下手动 commit 被拒，回合靠静音关闭。已用真实凭证 + 合成/人声语音直连真服务跑通全链路（speech_started → committed → transcription.completed）。

## 7. 验证记录

- host 单测 22/22；web 全量单测无回归；desktop 单测通过；三端 typecheck + biome 通过。
- 真实 host 全链路（本地假 realtime，零外网）：start → 分片原样转发 → SSE partial/final（重放 final 只到一次）→ 重复 start 409 → stop。
- 真实浏览器（CDP 驱动 Electron + 真实麦克风）：录音条全要素、波形实时跳动、计时、转写态、文字落框，均实测通过。
- 已知环境备忘：AudioWorklet 全局无 `btoa`（采集用手写 base64 + 异常上报，防静默死亡）；本机 pnpm 曾冲掉 electron 真二进制（已从缓存恢复，与功能无关）。

## 8. 关联

- 终端语音插件 StepFun-Voice（`github.com/Zgh332358/StepFun-Voice`）继续服务终端用户，本功能不改动它。
