export const COVER_UPLOAD_FIELD = 'file';
export const MAX_COVER_SIZE_MIB = 5;
export const COVER_MULTIPART_LIMITS = {
  fileSize: MAX_COVER_SIZE_MIB * 1024 * 1024,
  files: 1,
  fields: 0,
} as const;
export const APPROVED_COVER_MIME_TYPE = 'image/webp';
