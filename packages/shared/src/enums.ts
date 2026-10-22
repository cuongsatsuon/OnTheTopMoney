// Enum dùng chung giữa server và web (Consistency Conventions › Enum).
// Mỗi enum: mảng `as const` (nguồn duy nhất) + zod schema + kiểu suy ra.
// DB lưu `text` + check constraint sinh từ các mảng này.
import { z } from 'zod'

export const PLATFORMS = ['facebook', 'instagram', 'threads'] as const
export const Platform = z.enum(PLATFORMS)
export type Platform = z.infer<typeof Platform>

export const CONNECTION_STATUSES = ['active', 'expiring', 'disconnected'] as const
export const ConnectionStatus = z.enum(CONNECTION_STATUSES)
export type ConnectionStatus = z.infer<typeof ConnectionStatus>

export const CONVERSATION_STATES = ['triage', 'ai', 'handoff', 'human', 'done'] as const
export const ConversationState = z.enum(CONVERSATION_STATES)
export type ConversationState = z.infer<typeof ConversationState>

export const CONVERSATION_CHANNELS = ['dm', 'comment'] as const
export const ConversationChannel = z.enum(CONVERSATION_CHANNELS)
export type ConversationChannel = z.infer<typeof ConversationChannel>

export const MESSAGE_ORIGINS = [
  'customer',
  'app_human',
  'app_ai',
  'app_unmatched',
  'external_human',
  'system',
] as const
export const MessageOrigin = z.enum(MESSAGE_ORIGINS)
export type MessageOrigin = z.infer<typeof MessageOrigin>

export const MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const
export const MessageDirection = z.enum(MESSAGE_DIRECTIONS)
export type MessageDirection = z.infer<typeof MessageDirection>

export const MESSAGE_STATUSES = ['pending', 'sending', 'sent', 'delivered', 'read', 'failed'] as const
export const MessageStatus = z.enum(MESSAGE_STATUSES)
export type MessageStatus = z.infer<typeof MessageStatus>

export const MESSAGE_DELIVERIES = ['dm', 'public_reply', 'private_reply'] as const
export const MessageDelivery = z.enum(MESSAGE_DELIVERIES)
export type MessageDelivery = z.infer<typeof MessageDelivery>

export const HANDOFF_KINDS = ['transient', 'sticky'] as const
export const HandoffKind = z.enum(HANDOFF_KINDS)
export type HandoffKind = z.infer<typeof HandoffKind>

// AD-9: ba loại — không áp dụng / tạm đóng (transient) / chủ ý (sticky).
export const HANDOFF_REASONS = [
  'AI_OFF',
  'CHANNEL_OFF',
  'CONFIG_MISSING',
  'OUTSIDE_HOURS',
  'OPENAI_KEY_UNAVAILABLE',
  'AI_BUDGET_EXCEEDED',
  'AI_PROVIDER_ERROR',
  'KEYWORD',
  'CUSTOMER_ASKED_HUMAN',
  'AI_UNCERTAIN',
  'AI_POLICY_BLOCKED',
  'NON_TEXT_MESSAGE',
  'OUTSIDE_24H',
] as const
export const HandoffReason = z.enum(HANDOFF_REASONS)
export type HandoffReason = z.infer<typeof HandoffReason>

export const STATE_CHANGE_REASONS = [
  ...HANDOFF_REASONS,
  'HUMAN_REPLIED',
  'TAKEOVER',
  'AI_REENABLED',
  'MARKED_DONE',
  'GATE_OPEN',
] as const
export const StateChangeReason = z.enum(STATE_CHANGE_REASONS)
export type StateChangeReason = z.infer<typeof StateChangeReason>

// FE hiển thị: Mới, Đang tư vấn, Chốt đơn, Khách quen, Khiếu nại.
export const CONTACT_STAGES = ['new', 'consulting', 'ordered', 'loyal', 'complaint'] as const
export const ContactStage = z.enum(CONTACT_STAGES)
export type ContactStage = z.infer<typeof ContactStage>

export const AUTOREPLY_CHANNELS = ['messenger', 'ig_direct', 'comment_public', 'comment_private'] as const
export const AutoreplyChannel = z.enum(AUTOREPLY_CHANNELS)
export type AutoreplyChannel = z.infer<typeof AutoreplyChannel>

export const POST_TARGET_STATUSES = [
  'planned',
  'draft',
  'pending_approval',
  'scheduled',
  'publishing',
  'published',
  'failed',
  'cancelled',
] as const
export const PostTargetStatus = z.enum(POST_TARGET_STATUSES)
export type PostTargetStatus = z.infer<typeof PostTargetStatus>

// Khởi điểm; story Lịch/Chiến dịch có thể bổ sung.
export const CANCEL_REASONS = [
  'USER_DELETED',
  'USER_REJECTED',
  'CAMPAIGN_DELETED',
  'MISSED_WHILE_PAUSED',
  'PAGE_REMOVED',
  'PAGE_LEFT_GROUP',
] as const
export const CancelReason = z.enum(CANCEL_REASONS)
export type CancelReason = z.infer<typeof CancelReason>

export const CAMPAIGN_STATUSES = ['draft', 'running', 'paused', 'done'] as const
export const CampaignStatus = z.enum(CAMPAIGN_STATUSES)
export type CampaignStatus = z.infer<typeof CampaignStatus>

export const CAMPAIGN_MODES = ['review', 'auto'] as const
export const CampaignMode = z.enum(CAMPAIGN_MODES)
export type CampaignMode = z.infer<typeof CampaignMode>

export const PAUSE_REASONS = [
  'PAGE_DISCONNECTED',
  'AI_BUDGET_EXCEEDED',
  'PUBLISH_FAILURES',
  'CONFIG_MISSING',
  'MANUAL',
] as const
export const PauseReason = z.enum(PAUSE_REASONS)
export type PauseReason = z.infer<typeof PauseReason>

export const AI_FEATURES = [
  'autoreply',
  'autoreply_test',
  'inbox_suggest',
  'compose_caption',
  'campaign_generate',
  'brand_sample',
  'image_generate',
  'contact_summary',
] as const
export const AiFeature = z.enum(AI_FEATURES)
export type AiFeature = z.infer<typeof AiFeature>

export const KNOWLEDGE_STATUSES = ['processing', 'ready', 'failed', 'too_large'] as const
export const KnowledgeStatus = z.enum(KNOWLEDGE_STATUSES)
export type KnowledgeStatus = z.infer<typeof KnowledgeStatus>

export const WEBHOOK_HEALTH_STATUSES = ['waiting_first', 'ok', 'stalled'] as const
export const WebhookHealthStatus = z.enum(WEBHOOK_HEALTH_STATUSES)
export type WebhookHealthStatus = z.infer<typeof WebhookHealthStatus>

// AD-4: sức khoẻ webhook tính riêng cho `meta` (FB/IG) và `threads`.
export const WEBHOOK_PRODUCTS = ['meta', 'threads'] as const
export const WebhookProduct = z.enum(WEBHOOK_PRODUCTS)
export type WebhookProduct = z.infer<typeof WebhookProduct>

export const WEBHOOK_EVENT_STATUSES = ['received', 'routed', 'ignored', 'failed'] as const
export const WebhookEventStatus = z.enum(WEBHOOK_EVENT_STATUSES)
export type WebhookEventStatus = z.infer<typeof WebhookEventStatus>

export const CONFIG_OWNER_TYPES = ['group', 'page'] as const
export const ConfigOwnerType = z.enum(CONFIG_OWNER_TYPES)
export type ConfigOwnerType = z.infer<typeof ConfigOwnerType>

export const DELETION_SCOPES = ['page', 'contact', 'all'] as const
export const DeletionScope = z.enum(DELETION_SCOPES)
export type DeletionScope = z.infer<typeof DeletionScope>

export const DELETION_STATUSES = ['pending', 'processing', 'completed'] as const
export const DeletionStatus = z.enum(DELETION_STATUSES)
export type DeletionStatus = z.infer<typeof DeletionStatus>
