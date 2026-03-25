import * as Minio from "minio";
import { HttpError } from "wasp/server";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v?.trim()) {
    throw new HttpError(
      503,
      `Storage is not configured: set ${name} in .env.server (see .env.server.example).`,
    );
  }
  return v;
}

function parseS3CompatibleEndpoint(raw: string): {
  endPoint: string;
  port: number;
  useSSL: boolean;
} {
  try {
    const url = new URL(raw);
    const port = url.port
      ? Number(url.port)
      : url.protocol === "https:"
        ? 443
        : 80;
    return {
      endPoint: url.hostname,
      port,
      useSSL: url.protocol === "https:",
    };
  } catch {
    throw new HttpError(
      503,
      `Invalid AWS_S3_ENDPOINT: "${raw}". Use e.g. http://127.0.0.1:9000 for local MinIO.`,
    );
  }
}

let client: Minio.Client | null = null;

/**
 * MinIO client using S3-compatible env vars (works with AWS S3 when endpoint is omitted / default).
 */
export function getObjectStorageClient(): Minio.Client {
  if (client) {
    return client;
  }

  const accessKey = requireEnv("AWS_S3_IAM_ACCESS_KEY");
  const secretKey = requireEnv("AWS_S3_IAM_SECRET_KEY");
  const endpointUrl =
    process.env.AWS_S3_ENDPOINT ?? "http://127.0.0.1:9000";

  const { endPoint, port, useSSL } = parseS3CompatibleEndpoint(endpointUrl);

  client = new Minio.Client({
    endPoint,
    port,
    useSSL,
    accessKey,
    secretKey,
    region: process.env.AWS_S3_REGION ?? "us-east-1",
  });

  return client;
}

export function getDocumentsBucket(): string {
  return requireEnv("AWS_S3_FILES_BUCKET");
}

export type UploadFileParams = {
  objectKey: string;
  data: Buffer;
  contentType: string;
};

/**
 * Upload bytes to the configured bucket. Returns the object key (same as {@link UploadFileParams.objectKey}).
 */
export async function uploadFile(params: UploadFileParams): Promise<string> {
  const region = process.env.AWS_S3_REGION ?? "us-east-1";
  const minio = getObjectStorageClient();
  const bucket = getDocumentsBucket();

  try {
    const exists = await minio.bucketExists(bucket);
    if (!exists) {
      await minio.makeBucket(bucket, region);
    }
    await minio.putObject(
      bucket,
      params.objectKey,
      params.data,
      params.data.length,
      {
        "Content-Type": params.contentType,
      },
    );
  } catch (err) {
    console.error("[objectStorage] upload failed:", err);
    const detail = err instanceof Error ? err.message : String(err);
    throw new HttpError(
      503,
      `Could not upload to storage (${detail}). For local dev: run ./setup-minio.sh, set AWS_S3_ENDPOINT=http://127.0.0.1:9000, AWS_S3_FILES_BUCKET=documents, and the same access key/secret as MinIO.`,
    );
  }
  return params.objectKey;
}

/**
 * Presigned GET URL for an object (for downloads / previews).
 */
export async function getPresignedUrl(
  objectKey: string,
  expiresInSeconds = 3600,
): Promise<string> {
  try {
    const minio = getObjectStorageClient();
    const bucket = getDocumentsBucket();
    return await minio.presignedGetObject(
      bucket,
      objectKey,
      expiresInSeconds,
    );
  } catch (err) {
    console.error("[objectStorage] presign failed:", err);
    const detail = err instanceof Error ? err.message : String(err);
    throw new HttpError(
      503,
      `Could not generate file URL (${detail}). Check MinIO / AWS_S3_* configuration.`,
    );
  }
}
