import sharp from 'sharp';
import { COVER_MULTIPART_LIMITS, MAX_COVER_SIZE_MIB } from '@eventflow/event-contracts';
import { ApiError } from '@eventflow/service-runtime';

const inputMimeTypes = new Map([
  ['jpeg', 'image/jpeg'],
  ['png', 'image/png'],
  ['webp', 'image/webp'],
]);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const maxInputPixels = 16_000_000;
const maxOutputDimension = 1600;
const webpQuality = 85;
const decodeTimeoutSeconds = 5;

export async function approveImage(buffer: Buffer, contentType: string) {
  if (buffer.length > COVER_MULTIPART_LIMITS.fileSize)
    throw new ApiError(
      413,
      'IMAGE_TOO_LARGE',
      `Афиша должна быть не больше ${MAX_COVER_SIZE_MIB} MiB.`,
    );
  const detected = buffer.subarray(0, pngSignature.length).equals(pngSignature)
    ? 'image/png'
    : buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255
      ? 'image/jpeg'
      : buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
          buffer.subarray(8, 12).toString('ascii') === 'WEBP'
        ? 'image/webp'
        : null;
  if (!detected || detected !== contentType)
    throw new ApiError(
      415,
      'INVALID_IMAGE',
      'Фактический формат файла не соответствует JPEG, PNG или WebP.',
    );
  try {
    const image = sharp(buffer, {
      limitInputPixels: maxInputPixels,
      failOn: 'warning',
      animated: true,
    });
    const metadata = await image.metadata();
    if (inputMimeTypes.get(metadata.format) !== contentType || (metadata.pages ?? 1) !== 1)
      throw new ApiError(
        415,
        'INVALID_IMAGE',
        'Загрузите статичную афишу JPEG, PNG или WebP с правильным типом файла.',
      );
    // Re-encoding forces pixel decoding and removes metadata and trailing untrusted content.
    const result = await image
      .rotate()
      .resize({
        width: maxOutputDimension,
        height: maxOutputDimension,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: webpQuality })
      .timeout({ seconds: decodeTimeoutSeconds })
      .toBuffer({ resolveWithObject: true });
    return { body: result.data, width: result.info.width, height: result.info.height };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      422,
      'IMAGE_DECODE_FAILED',
      'Файл повреждён, имеет слишком большое разрешение или не является допустимой афишей.',
    );
  }
}
