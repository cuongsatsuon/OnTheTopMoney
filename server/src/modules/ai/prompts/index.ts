// Mẫu prompt dùng chung của module `ai` (AD-7). Export qua `ai/index.ts`.
export {
  CAPTION_MAX_OUTPUT_TOKENS,
  EMOJI_GUIDE,
  brandFactLines,
  buildCaptionPrompt,
  captionGuardLines,
  captionInput,
  captionInstructions,
  formalityGuide,
  type CaptionBrand,
} from './caption.ts'
export { COMPOSE_MAX_OUTPUT_TOKENS, buildComposePrompt, composeInput, composeInstructions, type ComposeContext } from './compose.ts'
export {
  REPLY_MAX_OUTPUT_TOKENS,
  buildReplyPrompt,
  replyInput,
  replyInstructions,
  retryNote,
  type ReplyBrand,
  type ReplyContext,
  type ReplyTurn,
} from './reply.ts'
export {
  CONTACT_SUMMARY_MAX_OUTPUT_TOKENS,
  buildContactSummaryPrompt,
  contactSummaryInput,
  contactSummaryInstructions,
  type ContactSummaryTurn,
} from './contact-summary.ts'
export {
  AUTOREPLY_DUAL_MAX_OUTPUT_TOKENS,
  AUTOREPLY_MAX_OUTPUT_TOKENS,
  AUTOREPLY_MODEL_REASONS,
  autoreplyInput,
  autoreplyInstructions,
  autoreplyOutputSchema,
  buildAutoreplyPrompt,
  isDualReply,
  type AutoreplyKnowledgeEntry,
  type AutoreplyModelReason,
  type AutoreplyPromptContext,
} from './autoreply.ts'
export {
  IMAGE_DESCRIPTION_MAX_OUTPUT_TOKENS,
  IMAGE_NO_FAKE_UI,
  buildImageDescriptionPrompt,
  buildImagePrompt,
  buildReferenceImagePrompt,
  cleanImageDescription,
  imageBriefCaption,
  imageDescriptionInput,
  imageDescriptionInstructions,
  type ImageDescriptionContext,
  type ImagePromptInput,
  type ReferenceImagePromptInput,
} from './image.ts'
