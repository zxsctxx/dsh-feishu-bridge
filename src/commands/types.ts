/**
 * 飞书斜杠命令的执行上下文（dsh 版）。
 *
 * 插件的可变状态（client / config / streaming 等）在 index.ts 里是闭包变量，
 * 这里通过 getter 暴露，保证命令永远读到当前值而不是注册时的快照。
 */

import type { FeishuClient } from "../feishu-client.js";
import type { BridgeConfig } from "../config.js";
import type { StreamingCardManager } from "../streaming/card-manager.js";
import type { ClarifyManager } from "../clarify/manager.js";
import type { MetricsCollector } from "../monitoring/metrics.js";
import type { ConfigReloadCoordinator } from "../monitoring/reload.js";
import type { MessageQueueManager } from "../queue.js";
import type { DshSessionManager } from "../dsh/session-manager.js";

export interface CommandContext {
  /** 命令来源的飞书会话 */
  readonly chatId: string;
  /** 触发命令的消息 id，用于回复 */
  readonly msgId: string;
  /** 命令名后的参数原文（已去掉首尾空白） */
  readonly args: string;

  /** DSH 会话管理器（共享 agent 生命周期） */
  readonly manager: DshSessionManager;
  readonly client: FeishuClient | null;
  readonly config: BridgeConfig;
  readonly streaming: StreamingCardManager | null;
  readonly clarify: ClarifyManager | null;
  readonly metrics: MetricsCollector;
  readonly configReload: ConfigReloadCoordinator;
  readonly queues: MessageQueueManager;

  /** 为 /new /resume 做前置清理：中断流式、清空队列、取消 Agent */
  prepareSessionControl(): Promise<void>;
  /** 重新加载配置并重启客户端 */
  reloadConfig(): Promise<void>;
  /** 短暂在状态栏闪一条提示 */
  flashStatus(text: string): void;
  /** 取消当前任务的硬超时 */
  clearTaskTimeout(): void;
}

/**
 * 命令处理器。返回字符串时由路由统一回复，
 * 返回 void 表示已自行发送（如需要多条消息或自定义时序）。
 */
export interface CommandHandler {
  /** 命令名，含前导斜杠 */
  readonly name: string;
  /** 一行说明，用于 /help */
  readonly help: string;
  handle(ctx: CommandContext): Promise<string | void>;
}