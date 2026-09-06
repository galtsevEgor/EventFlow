import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import sharp from 'sharp';
import {
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { catalogFixture } from './fixture.mjs';

const bucket = `eventflow-cover-test-${randomUUID()}`;
let fixture, token, organizationId, client, jpeg, png;
before(async () => {
  fixture = await catalogFixture({
    S3_ENDPOINT: process.env.S3_ENDPOINT,
    S3_ACCESS_KEY: process.env.S3_ACCESS_KEY,
    S3_SECRET_KEY: process.env.S3_SECRET_KEY,
    S3_COVERS_BUCKET: bucket,
  });
  token = await fixture.token();
  organizationId = (
    await fixture.request('/api/v1/organizations', token, 'POST', { name: 'Команда афиш' })
  ).body.id;
  client = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY,
    },
  });
  jpeg = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#336644' } })
    .jpeg()
    .withMetadata({ exif: { IFD0: { ImageDescription: 'private camera metadata' } } })
    .toBuffer();
  png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#336644' } })
    .png()
    .toBuffer();
});
after(async () => {
  await fixture?.close();
  if (client) {
    const objects = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
    for (const item of objects.Contents ?? [])
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: item.Key }));
    await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    client.destroy();
  }
});
async function event() {
  const result = await fixture.request(
    `/api/v1/organizations/${organizationId}/events`,
    token,
    'POST',
    { title: 'Событие с афишей' },
  );
  assert.equal(result.status, 201);
  return result.body.id;
}
async function upload(id, bytes, type, actor = token) {
  const body = new FormData();
  body.set('file', new Blob([bytes], { type }), 'poster');
  return fetch(`${fixture.origin}/api/v1/organizations/${organizationId}/events/${id}/cover`, {
    method: 'POST',
    headers: { authorization: `Bearer ${actor}` },
    body,
  });
}
test('cover is decoded, re-encoded without metadata and kept private until publication', async () => {
  const id = await event();
  const response = await upload(id, jpeg, 'image/jpeg');
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.ok(result.coverId);
  assert.equal(result.revision, 1);
  const asset = await fixture.db.coverAsset.findUniqueOrThrow({ where: { id: result.coverId } });
  assert.equal(asset.isPublic, false);
  const preview = await fetch(
    `${fixture.origin}/api/v1/organizations/${organizationId}/events/${id}/cover`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get('cache-control'), /private, no-store/);
  const metadata = await sharp(Buffer.from(await preview.arrayBuffer())).metadata();
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.width, 640);
  assert.equal(metadata.exif, undefined);
  assert.equal((await fetch(`${fixture.origin}/api/v1/covers/${asset.id}`)).status, 404);
  assert.equal(
    (await fetch(`${process.env.S3_ENDPOINT}/${bucket}/${asset.objectKey}`)).status,
    403,
  );
  const objects = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
  assert.ok(objects.Contents.every((item) => !item.Key.startsWith('private/')));
});
test('bad MIME, SVG, HTML, truncated pixels, excessive resolution and size never replace a valid cover', async () => {
  const id = await event();
  const valid = await upload(id, png, 'image/png');
  const original = await valid.json();
  const hugeResolution = await sharp({
    create: { width: 4100, height: 4100, channels: 3, background: '#000000' },
  })
    .png()
    .toBuffer();
  const cases = [
    [png, 'image/jpeg', 415],
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml', 415],
    [Buffer.from('<script>alert(1)</script>'), 'image/png', 415],
    [png.subarray(0, 20), 'image/png', 422],
    [hugeResolution, 'image/png', 422],
    [Buffer.alloc(5 * 1024 * 1024 + 1), 'image/png', 413],
  ];
  for (const [bytes, type, status] of cases) {
    const response = await upload(id, bytes, type);
    assert.equal(response.status, status);
    const body = await response.json();
    assert.ok(body.requestId);
    assert.ok(!('stack' in body));
  }
  const unchanged = await fixture.db.eventDraft.findUniqueOrThrow({ where: { id } });
  assert.equal(unchanged.coverId, original.coverId);
  assert.equal(unchanged.revision, 1);
  assert.equal(await fixture.db.coverAsset.count({ where: { eventId: id } }), 1);
});
test('only members with edit permission can upload or preview another event cover', async () => {
  const id = await event();
  const outsider = await fixture.token({ sub: 'cover-outsider' });
  assert.equal((await upload(id, png, 'image/png', outsider)).status, 404);
  await fixture.db.membership.create({
    data: {
      organizationId,
      userSubject: 'cover-staff',
      email: 'staff@eventflow.test',
      role: 'STAFF',
    },
  });
  const staff = await fixture.token({ sub: 'cover-staff' });
  assert.equal((await upload(id, png, 'image/png', staff)).status, 403);
  assert.equal(
    (
      await fetch(`${fixture.origin}/api/v1/organizations/${organizationId}/events/${id}/cover`, {
        headers: { authorization: `Bearer ${outsider}` },
      })
    ).status,
    404,
  );
});
