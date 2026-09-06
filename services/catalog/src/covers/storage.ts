import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ApiError } from '@eventflow/service-runtime';

export type CoverStorageConfig = {
  S3_ENDPOINT: string;
  S3_ACCESS_KEY: string;
  S3_SECRET_KEY: string;
  S3_COVERS_BUCKET: string;
};
export class CoverStorage {
  readonly client: S3Client;
  private initialized = false;
  constructor(readonly config: CoverStorageConfig) {
    this.client = new S3Client({
      endpoint: config.S3_ENDPOINT,
      region: 'us-east-1',
      forcePathStyle: true,
      maxAttempts: 2,
      credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
    });
  }
  private async ensureBucket() {
    if (this.initialized) return;
    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.config.S3_COVERS_BUCKET }), {
        abortSignal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'BucketAlreadyOwnedByYou') throw error;
    }
    this.initialized = true;
  }
  async put(key: string, body: Buffer, contentType: string) {
    try {
      await this.ensureBucket();
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.S3_COVERS_BUCKET,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
    } catch {
      throw new ApiError(
        503,
        'STORAGE_UNAVAILABLE',
        'Хранилище афиш временно недоступно. Повторите позже.',
      );
    }
  }
  async get(key: string) {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.S3_COVERS_BUCKET, Key: key }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
      if (!result.Body) throw new Error('Image body missing');
      return Buffer.from(await result.Body.transformToByteArray());
    } catch {
      throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Афиша временно недоступна.');
    }
  }
  async remove(key: string) {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.S3_COVERS_BUCKET, Key: key }),
      { abortSignal: AbortSignal.timeout(5000) },
    );
  }
  onModuleDestroy() {
    this.client.destroy();
  }
}
