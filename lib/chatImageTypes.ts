/** Durable references; image bytes stay out of session polling payloads. */
export interface ChatImage { id: string; name: string }
export const MAX_CHAT_IMAGES = 4;
export const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;
export const chatImageUrl = (image: ChatImage): string => `/api/pilot/chat/image?id=${encodeURIComponent(image.id)}`;
