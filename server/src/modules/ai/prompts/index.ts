// Mẫu prompt dùng chung của module `ai` (AD-7). Export qua `ai/index.ts`.
export {
  CAPTION_MAX_OUTPUT_TOKENS,
  EMOJI_GUIDE,
  buildCaptionPrompt,
  captionInput,
  captionInstructions,
  formalityGuide,
  type CaptionBrand,
} from './caption.ts'
export {
  REPLY_MAX_OUTPUT_TOKENS,
  buildReplyPrompt,
  replyInput,
  replyInstructions,
  type ReplyBrand,
  type ReplyContext,
  type ReplyTurn,
} from './reply.ts'
