/**
 * Conversation feature slots, mounted by App.tsx at their legacy DOM positions:
 * `#taskBanner`, `#stream` and `#feedbackModal`. See client/MIGRATION_MAP.md.
 *
 * CSS order follows legacy styles.css: the second message-action block
 * (973-988) overrides the first (709-720).
 */

import "./stream.css";
import "./stream-nav.css";
import "./feedback.css";
import "./message-actions.css";
import "./task-banner.css";
import "./child-agent.css";

export { ChildAgentView } from "./ChildAgentView";
export { ConversationStream } from "./ConversationStream";
export { FeedbackModal } from "./FeedbackModal";
export { StreamNav } from "./StreamNav";
export { TaskBanner } from "./TaskBanner";
