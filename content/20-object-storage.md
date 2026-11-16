---
title: Object storage and large files
part: Scale
summary: Where user files really live, how bytes get in and out without passing through your server, and how to move files measured in gigabytes.
---

Sooner or later a user wants to attach something: a PDF, a profile photo, a two-hour video. Files don't fit the tools you have so far. They are too big for a database row, too valuable for a container's disk, and too heavy to push through your API. Object storage (S3 and everything that speaks its API) is where they go, and the way bytes move in and out of it shapes your whole upload and download design.

## The first principle

Start with the design everyone writes first. The client sends the file to your API, your API writes it to disk, and the database stores the path:

```
browser ──file──▶ API ──write──▶ /var/app/uploads/9f2c.pdf
                   └──INSERT──▶ attachments(path = '/var/app/uploads/9f2c.pdf')
```

It works on your laptop. In production it breaks in six places:

1. **Size and memory.** Many upload handlers read the whole body into memory before writing it. A 4 GB video means 4 GB of RAM for one request. Ten users at once and the process is killed.
2. **The disk is ephemeral.** Containers get a fresh filesystem on every deploy, restart or reschedule. The uploads directory vanishes with the old container.
3. **More than one instance.** Lesson 18 put three stateless instances behind a load balancer. The file lands on instance A; the next `GET` goes to instance B, which has never heard of it. Your app is no longer stateless.
4. **Capacity.** Disks fill. Growing one means resizing volumes and moving data, usually at a bad time.
5. **Durability.** One disk is one failure away from losing every file. Backups of a disk are something you now own.
6. **Bandwidth.** Every download streams through your API process. A popular file turns your app servers into slow, expensive file servers, and those bytes compete with real API requests.

Each of these has the same answer: **move the bytes out of your servers into a separate service that is built to hold them**, keep only a small reference (a key) in your database, and let clients talk to that service directly whenever possible. That service is object storage.

> Your database stores *facts about* the file: who owns it, its name, size, type and status. Object storage stores *the file*. Never put the bytes in Postgres and never put the facts only in the bucket.

## Core ideas

### Three kinds of storage: block, file, object

Storage comes in three shapes. The difference is the interface: what you can ask it to do.

| | Block | File | Object |
|---|---|---|---|
| Unit | numbered fixed-size blocks | files in a directory tree | whole objects, by key |
| Interface | read/write block *n* (NVMe, iSCSI) | POSIX: open, seek, write, rename, lock | HTTP: PUT, GET, HEAD, DELETE, LIST |
| Examples | local SSD, AWS EBS | NFS, AWS EFS, SMB shares | S3, Google Cloud Storage, Azure Blob, Cloudflare R2, MinIO |
| Who can use it | usually one machine | many machines on a network | anything with credentials and HTTP |
| Change a byte in the middle | yes | yes | no: replace the whole object |
| Good for | databases, OS disks | shared app files, legacy software | uploads, media, backups, logs, data lakes |

Postgres wants block storage: it rewrites 8 KB pages in place, thousands of times a second. User uploads want object storage: written once, read many times, never edited.

### The object storage interface, and its trade-offs

The whole API fits on one line: `PUT key`, `GET key`, `HEAD key`, `DELETE key`, `LIST prefix`. That small interface is the point. By giving up the things a filesystem does, object storage can do other things a filesystem can't.

What you give up:

- **No partial updates.** You cannot append to an object or change byte 500. You write a new object that replaces the old one.
- **No real rename.** "Moving" an object is copy plus delete.
- **Higher latency.** Time to first byte is tens of milliseconds, not microseconds. Listing is paginated, 1,000 keys per page.

What you get back:

- **Effectively unlimited capacity.** No volume to resize. One object can be up to 50 TB on S3 (the limit was 5 TB until December 2025).
- **Durability** designed for eleven nines (below), with no backup scripts to write.
- **Access from anywhere over HTTP**, including directly from browsers through signed URLs.
- **Pay per use**: per GB stored, per request, per GB sent out.
- **Strong consistency.** Since December 2020, S3 gives read-after-write consistency for every PUT, DELETE and LIST. A `GET` right after a successful `PUT` returns the new data.

### What an object actually is

An object has three parts:

```
key:       users/42/attachments/0b9e7c1a.pdf
value:     <bytes, 0 B to 50 TB>
metadata:  system:  Content-Length: 482113
                    Content-Type: application/pdf
                    ETag: "5d41402abc4b2a76b9719d911017c592"
                    Last-Modified: Mon, 16 Nov 2026 09:12:44 GMT
           user:    x-amz-meta-original-name: Q3 report.pdf
```

- The **key** is the object's full name, a string up to 1,024 bytes. It is the only way to find the object.
- The **value** is opaque bytes. The store never looks inside.
- **System metadata** is set and managed by the store: size, ETag, last-modified, storage class. A few, such as `Content-Type`, `Content-Disposition` and `Cache-Control`, you set at upload and the store sends back as headers on every `GET`.
- **User metadata** is your own key-value pairs, sent as `x-amz-meta-*` headers. It is limited to 2 KB per object on S3, and you cannot query it. Anything you want to search or filter belongs in your database.

### Folders are an illusion

Object storage has a **flat namespace**: one bucket, one big sorted list of keys. There are no directories. `users/42/attachments/0b9e.pdf` is a single key that happens to contain slashes.

Folders appear because `LIST` takes a `Prefix` and a `Delimiter`:

```
ListObjectsV2(Prefix="users/42/", Delimiter="/")
  Contents:       users/42/avatar.png
  CommonPrefixes: users/42/attachments/
                  users/42/exports/
```

The store groups every key that has another `/` after the prefix into a "common prefix", and consoles draw those as folders. The consequences are real:

- **Empty folders don't exist.** Some tools fake them with a zero-byte object whose key ends in `/`.
- **Renaming a folder** means copying and deleting every object under the prefix, one request each. A million objects is a million copies.
- **Listing is a scan of sorted keys.** Fast for "everything under this prefix", useless for "every PDF bigger than 5 MB". That query belongs in Postgres.

### Designing the key

The key is the only index the store has, so design it the way you design a primary key.

- **Generate it on the server.** Use an id you control: `users/{userId}/attachments/{attachmentId}`. Never build keys from the user's filename. Names collide, contain `../`, emoji and spaces, and leak information. Store the original name in your database and send it back in `Content-Disposition` at download time.
- **Lead with the thing you list or delete by.** If you delete everything a user owns when they close their account, put the user id early so a single prefix covers it. If a lifecycle rule should expire temporary exports, give them their own prefix (`tmp/exports/...`) so the rule can target it.
- **Make keys immutable.** A new version of a file gets a new key. Old URLs then keep pointing at old bytes, which makes caching safe (below).
- **Don't worry about random prefixes.** Old advice said to hash the start of keys to spread load. Since 2018 S3 scales automatically: each prefix supports at least 3,500 writes and 5,500 reads per second, and it splits busy prefixes on its own.

### Behind the interface: the two planes

Inside, an object store is two systems:

```
            PUT users/42/a.pdf
                    │
        ┌───────────┴────────────┐
        ▼                        ▼
  DATA PLANE                METADATA PLANE
  bytes, split into         key → { size, ETag, version,
  chunks and spread           where every chunk lives }
  over many disks,          a sorted, strongly consistent
  servers and zones         key-value index
```

The **data plane** stores bytes. It cuts an object into chunks, protects them (replication or erasure coding) and spreads them across many disks in different buildings. It is built for throughput.

The **metadata plane** is an index from key to "where the pieces are". It is a distributed, strongly consistent, sorted key-value store. It answers `HEAD` and `LIST`, and it decides when an object exists.

A `PUT` writes and protects all the data first, then commits one metadata record. Until that commit, readers see the old object (or nothing). After it, they see the whole new one. This is why you never read half an object, and why "the key is a pointer to immutable chunks" is a useful mental model.

### Durability: replication, erasure coding and eleven nines

Disks fail every day in a large fleet. The store must lose no data anyway. Two ways to survive failures:

**Replication** keeps full copies. Three copies on three machines survives two failures, at 200% extra storage.

**Erasure coding** cuts the data into *k* data shards, computes *m* parity shards (with Reed-Solomon codes, for example) and stores all *k + m* on different disks. Any *k* shards rebuild the original.

| Scheme | Storage used | Failures survived |
|---|---|---|
| 3× replication | 3.0× | any 2 copies |
| Erasure coding 10 + 4 | 1.4× | any 4 shards |
| Erasure coding 8 + 4 | 1.5× | any 4 shards |

Erasure coding survives more failures with far less storage. The cost is CPU and extra network reads when a shard is missing, which is a good trade for data that is written once and read often. Large stores use it for most data. MinIO uses erasure coding across its drives.

S3 Standard is **designed for 99.999999999% (eleven nines) annual durability**. AWS's own way to say it: store 10 million objects and you can expect to lose one every 10,000 years. Two things the number does not mean:

- **It is not availability.** S3 Standard is designed for 99.99% availability. Your file can be perfectly safe and briefly unreachable.
- **It does not protect you from yourself.** A buggy cleanup job that deletes the wrong prefix is "durably" deleted. Turn on **versioning** for important buckets, consider **object lock** for backups, and replicate critical data to a second account or region.

### Conditional writes: If-None-Match and If-Match

Two requests write the same key at the same moment. Plain `PUT` is last-writer-wins: one of them silently vanishes. For user uploads with unique keys that's fine. For anything shared, such as a manifest, a lock file or an export that two workers might both produce, it's a lost update (lesson 19).

Object storage now borrows HTTP's conditional request headers to fix this:

| Header on PUT | Means | If the condition fails |
|---|---|---|
| `If-None-Match: *` | create only: fail if the key already exists | `412 Precondition Failed` |
| `If-Match: "<etag>"` | replace only if the current ETag is still this one (compare-and-swap) | `412 Precondition Failed` |

S3 added `If-None-Match` in August 2024 and `If-Match` in November 2024. Both work on `PutObject`, `CompleteMultipartUpload` and `CopyObject`. When two conditional writes race, the first to finish wins and the other gets `412`. You can also get `409 Conflict` if a concurrent delete lands first. Retry a `PutObject`; a multipart upload has to start again from `CreateMultipartUpload`. A bucket policy can require these headers, so no client can overwrite an object by leaving them out.

`If-Match` is the same optimistic concurrency as a version column in Postgres (lesson 19): read the object and its ETag, compute the new content, write with `If-Match`, and on `412` read again and retry.

```js
import { PutObjectCommand } from "@aws-sdk/client-s3";

try {
  await s3.send(new PutObjectCommand({ Bucket, Key: "locks/nightly-export", Body: instanceId, IfNoneMatch: "*" }));
  // we hold the lock; do the work
} catch (err) {
  if (err.$metadata?.httpStatusCode === 412) return; // another worker got there first
  throw err;
}
```

Before 2024 you needed a separate database for this. Now the bucket can do it alone.

### Getting the file in: proxy or direct

There are two architectures for uploads.

**Through your server.** The client sends the file to your API, and the API forwards it to the bucket. The trap is **buffering**: reading the whole body into memory (`await file.toBuffer()`, `multer.memoryStorage()`) and then uploading the buffer. Memory use equals file size times concurrent uploads.

The fix is **streaming**: pipe the request body into the upload as it arrives, so memory stays flat at a few chunks. `@aws-sdk/lib-storage`'s `Upload` class takes a stream and handles the chunking for you.

Streaming fixes memory, but there is a ceiling you can't stream past. Every byte still crosses your server twice (in from the client, out to the bucket). Each upload holds a connection and a slice of your bandwidth for minutes. Body size limits, proxy timeouts and deploys that kill in-flight requests (lesson 16) all start to bite. You are paying to be a slow pipe.

**Direct to storage.** The client uploads straight to the bucket, and your API only *authorizes* it. The API never touches the bytes. The tool that makes this safe is the pre-signed URL.

### Pre-signed URLs

The bucket is private. The browser has no AWS credentials, and you must never give it any. A **pre-signed URL** is a normal S3 request URL with a signature in the query string:

```
https://bucket.s3.amazonaws.com/users/42/attachments/0b9e.pdf
  ?X-Amz-Algorithm=AWS4-HMAC-SHA256
  &X-Amz-Credential=AKIA.../20261116/us-east-1/s3/aws4_request
  &X-Amz-Date=20261116T091200Z
  &X-Amz-Expires=300
  &X-Amz-SignedHeaders=content-type;host
  &X-Amz-Signature=3f1c...
```

Your server computes the signature with an HMAC over the method, bucket, key, expiry and any signed headers, using your secret key. S3 recomputes it on arrival. Change anything signed (the key, the method, the `Content-Type`) and the signature no longer matches. Signing is pure local computation: no network call, microseconds of CPU.

```js
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const url = await getSignedUrl(
  s3,
  new PutObjectCommand({ Bucket, Key: key, ContentType: "application/pdf" }),
  { expiresIn: 300, signableHeaders: new Set(["content-type"]) },
);
```

Two details matter. By default the presigner signs only `host`, so the client could send any `Content-Type`; `signableHeaders` pins it. And a pre-signed URL is a **bearer token**: anyone who has it can use it until it expires. Keep upload URLs short-lived (minutes), don't log them, and remember that SigV4 URLs can't live longer than seven days. If you sign with temporary credentials (an IAM role), the URL also dies when those credentials expire.

### The hole in a signed URL: POST policies

A pre-signed `PUT` pins the method, the key, the expiry and the signed headers. It does **not** pin the size. The URL you signed for a 2 MB avatar will happily accept 5 GB.

A **POST policy** closes the hole. Instead of a URL, the server signs a JSON policy listing conditions, and the browser uploads with an HTML form (`multipart/form-data`) to the bucket:

```js
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";

const { url, fields } = await createPresignedPost(s3, {
  Bucket,
  Key: key,
  Conditions: [
    ["content-length-range", 1, 10 * 1024 * 1024], // 1 byte to 10 MB
    ["eq", "$Content-Type", "application/pdf"],
  ],
  Fields: { "Content-Type": "application/pdf" },
  Expires: 300,
});
// The client POSTs every field in `fields`, then the file as the last field.
```

The store rejects anything outside the policy before it is written. Use POST policies whenever size matters, which for user uploads is nearly always. If you use plain pre-signed `PUT`s, check the size afterwards (next section) and delete anything too big.

### The two-phase flow: telling your database

With direct uploads, your API is not in the path when the bytes arrive. So how does the database find out? With a two-phase flow:

```
1. client ──POST /attachments {name, type, size}──▶ API
            API validates, INSERTs row (status = 'pending', key),
            returns a pre-signed URL or POST policy
2. client ──PUT bytes──────────────────────────────▶ bucket
3. client ──POST /attachments/:id/confirm─────────▶ API
            API HEADs the object: exists? size and type as promised?
            UPDATE status = 'confirmed'
```

- Phase one reserves the key and records intent. Your validation (type allowlist, size limit, quota, ownership) happens here.
- Phase three trusts nothing the client says. It asks the bucket (`HeadObject`) what actually arrived.
- Only `confirmed` attachments are ever shown or served.

Instead of a confirm call from the client, you can have the bucket tell you: S3 event notifications (to SQS or Lambda) and MinIO bucket notifications fire on every new object. That is more reliable, because a client that crashes after uploading never sends the confirm, but it is more infrastructure. Many apps do both.

### Cleanup: the uploads that never finish

Some uploads never complete. The tab closes, the network drops, a bug skips the confirm. Left alone you collect two kinds of junk:

- **Pending rows** with no object, or an object no one will ever confirm.
- **Orphan objects** with no row at all, for example when a delete removed the row but the object delete failed.

Fix both with a scheduled job (lesson 11): find `pending` rows older than a day, delete their objects (deleting a missing key is not an error), then delete the rows. For orphans, list a prefix now and then and compare against the database. For temporary prefixes, let a **lifecycle rule** expire objects automatically.

### CORS for browser uploads

Your page runs on `https://app.linkbox.dev`; the bucket is on another origin. A browser `PUT` with `Content-Type: application/pdf` is not a "simple" request, so the browser first sends a **preflight** `OPTIONS` to the bucket and only proceeds if the bucket's CORS rules allow it. `curl` ignores CORS completely, which is why uploads work in your terminal and fail in the browser.

```js
import { PutBucketCorsCommand } from "@aws-sdk/client-s3";

await s3.send(new PutBucketCorsCommand({
  Bucket,
  CORSConfiguration: {
    CORSRules: [{
      AllowedOrigins: ["https://app.linkbox.dev"], // exact origins, not "*"
      AllowedMethods: ["PUT", "POST", "GET"],
      AllowedHeaders: ["content-type"],
      ExposeHeaders: ["ETag"],                     // multipart needs it, see below
      MaxAgeSeconds: 3000,
    }],
  },
}));
```

MinIO allows every origin by default (the `MINIO_API_CORS_ALLOW_ORIGIN` setting), so in local development CORS rarely bites. In production on S3, a missing rule is the first thing to check when browser uploads fail.

### Large files: why a single PUT stops working

A single `PUT` has four problems as files grow:

1. **A hard limit.** S3 accepts at most 5 GB in one `PUT`.
2. **All or nothing.** The connection drops at 97% and you start again from zero.
3. **One stream.** A single TCP connection rarely fills a fast link, especially over long distances.
4. **No real progress or resume.** You can show bytes sent, but you cannot pick up where you left off.

AWS recommends considering multipart once objects reach about 100 MB.

### Multipart upload: the three calls (and a fourth)

Multipart upload splits one object into numbered **parts** that are uploaded separately and stitched together at the end:

```
CreateMultipartUpload(key)            → UploadId
UploadPart(UploadId, PartNumber=1, …) → ETag₁   ┐
UploadPart(UploadId, PartNumber=2, …) → ETag₂   ├ in parallel, any order,
...                                             │ each retried on its own
UploadPart(UploadId, PartNumber=N, …) → ETagₙ   ┘
CompleteMultipartUpload(UploadId, [(1,ETag₁)…(N,ETagₙ)]) → the object exists
AbortMultipartUpload(UploadId)        → parts deleted (on cancel or failure)
```

Until `Complete` succeeds, there is no object: nothing appears in `LIST`, and a `GET` returns 404. `Complete` is atomic, like a normal `PUT` commit. A failed part costs you one part's worth of re-upload, not the whole file. And parts can go up over several connections at once.

### Choosing the part size, and the 10,000 part cap

The rules on S3 (MinIO uses the same):

| Limit | Value |
|---|---|
| Part size | 5 MiB to 5 GiB (the last part may be smaller) |
| Parts per upload | 1 to 10,000 |
| Largest object | 10,000 × 5 GiB ≈ 48.8 TiB (S3 rounds this to "50 TB") |

The cap is on the **count** of parts, so the part size must grow with the file:

```js
const MiB = 1024 * 1024;
// Smallest part size that fits in 10,000 parts, rounded up to whole MiB, never under our preferred size.
const partSize = (size, preferred = 16 * MiB) =>
  Math.max(preferred, Math.ceil(size / 10_000 / MiB) * MiB);
```

| File | Smallest legal part | A sensible choice | Parts |
|---|---|---|---|
| 2 GB | 5 MiB (the minimum) | 16 MB | 125 |
| 100 GiB | 10.24 MiB | 16 MiB | 6,400 |
| 1 TiB | 104.86 MiB | 128 MiB | 8,192 |

The classic bug is a fixed 5 MiB part size. That caps you at 10,000 × 5 MiB ≈ 48.8 GiB, and the upload of a 50 GiB file fails at part 10,001, *after* sending 48.8 GiB. Compute the size from the file.

Between "legal" and "good": bigger parts mean fewer requests (cheaper, less overhead) but costlier retries and more memory per part in flight. 8 to 64 MiB is a good default for most uploads.

### The ETag trap on multipart objects

For a simple, unencrypted single `PUT`, the ETag is the MD5 of the bytes, and people start treating it as a content hash. For a multipart object it is something else: the MD5 of the concatenated binary MD5s of every part, followed by `-` and the part count:

```js
import { createHash } from "node:crypto";

function multipartETag(buf, partSize) {
  const partMd5s = [];
  for (let off = 0; off < buf.length; off += partSize)
    partMd5s.push(createHash("md5").update(buf.subarray(off, off + partSize)).digest());
  return `"${createHash("md5").update(Buffer.concat(partMd5s)).digest("hex")}-${partMd5s.length}"`;
}
```

Upload the same 12 MiB file with 5 MiB parts and you get an ETag ending in `-3`; with 6 MiB parts, a different ETag ending in `-2`; with a single `PUT`, the plain MD5. Same bytes, three ETags. So never use the ETag to deduplicate files or prove integrity across uploads. If you need a content hash, compute SHA-256 yourself and store it in your database, or use S3's own checksums, which are designed for this. Since December 2024 S3 stores a checksum with every new object (CRC-64/NVME unless the client chooses another algorithm), and for the CRC algorithms it can be a *full object* checksum that does not depend on how the file was split into parts.

### Abandoned uploads: storage you pay for and cannot see

A multipart upload that is never completed or aborted keeps its parts forever. They are billed as storage, and they do not show up in `ListObjects`, the console's object list or your size estimates. Only `ListMultipartUploads` (or S3 Storage Lens) reveals them. Teams discover terabytes of them years later.

The fix is a lifecycle rule on every bucket that takes multipart uploads:

```json
{
  "Rules": [{
    "ID": "abort-incomplete-multipart",
    "Status": "Enabled",
    "Filter": { "Prefix": "" },
    "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
  }]
}
```

MinIO cleans up stale multipart uploads on its own, 24 hours after they start by default (`api stale_uploads_expiry`). Also abort explicitly in your own code when a user cancels or an upload fails, and keep the `UploadId` in your database so the cleanup job can abort it.

### Pre-signed URLs and multipart: the full architecture

Combine the two ideas and the browser can upload a 50 GB file without a single byte touching your API:

```
1. client → API   POST /uploads {name, size, type}
                  API: validate, CreateMultipartUpload, INSERT row (pending, upload_id),
                  return {uploadId, partSize, partCount}
2. client → API   POST /uploads/:id/parts {partNumbers: [1..20]}
                  API: sign one UploadPart URL per part (15-minute expiry)
3. client → S3    PUT each slice of the file (file.slice(start, end)), 4–6 at a time
4. client → API   POST /uploads/:id/complete
                  API: ListParts, CompleteMultipartUpload, HeadObject, status = 'confirmed'
5. on cancel      API: AbortMultipartUpload, delete row
```

Four implementation notes:

1. **Sign parts in batches.** Don't sign 10,000 URLs up front with a long expiry. Sign 10 to 50 at a time, and re-sign when one expires.
2. **Let the server read the parts.** `ListParts` gives your API every part's number and ETag straight from the store (paginated, 1,000 per page). If you instead let the browser report ETags, it must read the `ETag` response header, which a cross-origin page can only see when CORS has `ExposeHeaders: ["ETag"]`.
3. **Limit concurrency and retry per part.** 4 to 6 parts in flight is plenty for a browser. Retry a failed part with backoff (lesson 13), not the whole upload.
4. **Resume.** Save the `uploadId` (keyed by file name, size and modified time) in the browser. After a crash, ask the API which parts exist (`ListParts`) and upload only the missing ones. For a standard resumable protocol with ready-made clients, look at tus.

### Downloads: never proxy them through your server

Everything said about uploads applies in reverse. Streaming downloads through your API spends your bandwidth, your connections and your memory on bytes you are not even looking at. Let clients fetch from storage directly, with one of two patterns.

**Pattern 1: public objects behind a CDN.** For files anyone may see (product images, public avatars), make that prefix readable, or better, keep the bucket private and put a CDN in front with origin access control, so only the CDN can read it. URLs are stable (`https://cdn.linkbox.dev/avatars/42-v3.png`), so the CDN and browsers cache them. Immutable keys plus `Cache-Control: public, max-age=31536000, immutable` give near-perfect hit rates.

**Pattern 2: pre-signed GET for private files.** Your API checks that the user may read this file (lesson 17), then answers with a `302` to a short-lived signed URL. Add `ResponseContentDisposition: attachment; filename="..."` so the browser downloads under the original name rather than rendering the file. Rendering user-uploaded HTML or SVG on a domain you trust is an XSS hole; serve user content from a separate domain.

The catch with pattern 2: every signature is different. `X-Amz-Date` and `X-Amz-Signature` change each time, so every signed URL is a brand-new cache key. A CDN in front of signed URLs has a hit rate near zero, and the browser re-downloads the same image on every page load. Fixes:

- **Round the signing time.** Sign with the start of the current hour and an expiry of two hours. Every request in that hour gets the identical URL, so caches work. The SDK supports this through the `signingDate` option of `getSignedUrl`.
- **Sign at the CDN instead.** CDN signed URLs or signed cookies (CloudFront has both) check access at the edge and cache the object under its plain path.

### Range requests: 206, Content-Range and 416

HTTP lets a client ask for part of a resource. Object stores support it on every `GET`:

```
GET /videos/42.mp4             HTTP/1.1
Range: bytes=0-1048575

HTTP/1.1 206 Partial Content
Accept-Ranges: bytes
Content-Range: bytes 0-1048575/734003200
Content-Length: 1048576
```

- `Range: bytes=start-end` is inclusive on both ends. `bytes=1000-` means "from byte 1000 to the end"; `bytes=-500` means "the last 500 bytes".
- `206 Partial Content` says "here is the slice"; `Content-Range` says which slice and the total size.
- A range that starts past the end gets `416 Range Not Satisfiable` with `Content-Range: bytes */734003200`, telling the client the real size.
- A server that ignores ranges answers `200` with the whole body. Clients must check the status.
- `If-Range: "<etag>"` says "give me the range only if the file hasn't changed; otherwise send it all". Without it, a resumed download can stitch two different versions together.

S3 accepts one range per request (no multi-range `multipart/byteranges` responses).

### What ranges unlock

- **Seeking in media.** A `<video>` element fetches the start, reads the index, then jumps with `Range` when you drag the slider. No range support, no seeking.
- **Resumable downloads.** After a dropped connection, ask for `bytes=<received>-` with `If-Range`. `curl -C -` does exactly this.
- **Parallel downloads.** Split a big object into ranges and fetch several at once: multipart upload in reverse. AWS recommends range fetches of 8 to 16 MB for throughput. For an S3 object over 5 TB it is the only way, because a single `GET` returns at most 5 TB.
- **Reading just the part you need.** A ZIP's directory and a Parquet file's footer live at the end of the file. Fetch the last few KB instead of the whole thing.

### Segmented streaming: HLS and DASH

Range requests let a player seek inside one big MP4, but it can't change quality when the network slows down. Video platforms instead use **segmented streaming**:

1. A background job (lesson 11) transcodes the upload, usually with ffmpeg, into several **renditions** (1080p, 720p, 480p).
2. Each rendition is cut into short **segments**, a few seconds each.
3. A small **manifest** lists the renditions and their segments: an `.m3u8` playlist for HLS (RFC 8216), an `.mpd` file for MPEG-DASH.
4. The player downloads the manifest, then fetches segments one by one, choosing a rendition for each based on measured bandwidth. That's **adaptive bitrate**.

On the storage side nothing changes. Segments and manifests are ordinary objects (`videos/42/720p/seg_00017.m4s`), fetched with ordinary `GET`s, cached by an ordinary CDN. All the cleverness lives in the transcoder and the player.

### Cost: storage, requests and egress

Object storage bills three things. Rough S3 Standard list prices in us-east-1 at the time of writing (check the pricing page for your region):

| Item | Price | Notes |
|---|---|---|
| Storage | ~$0.023 per GB-month | 1 TB ≈ $23 a month |
| Writes (PUT, COPY, POST, LIST) | $0.005 per 1,000 | 12.5× the price of a read |
| Reads (GET, HEAD) | $0.0004 per 1,000 | |
| Data out to the internet | ~$0.09 per GB | first 100 GB a month free; data in is free |

The surprise is almost always **egress**. Storing 1 TB costs about $23 a month; serving that terabyte ten times costs about $900. A CDN in front (cheaper per GB, and cache hits never reach the bucket) and long cache lifetimes are the main levers. Some providers, such as Cloudflare R2, charge nothing for egress. Lifecycle rules can move cold data to cheaper storage classes, and tiny objects or tiny multipart parts multiply request charges.

## Try it

You need Docker and Node 22+. For years the usual local S3 server was MinIO. In October 2025 MinIO Inc. stopped publishing community builds and container images, in 2026 it archived the open-source repository, and its images are no longer on Docker Hub. The commands below use Silo (`pgsty/silo`), a community-maintained fork of the same server. Until August 2026 it was published as `pgsty/minio`. It keeps the `MINIO_*` settings and the web console, so everything this lesson says about MinIO applies to it.

Any S3-compatible server works, because the code below only speaks the S3 API. RustFS, SeaweedFS and Garage are other common choices. If you pick one of them, check that it supports conditional writes before you expect the `412` below.

```bash
docker run -d --name silo -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
  pgsty/silo:RELEASE.2026-11-12T00-00-00Z server /data --console-address ":9001"
mkdir s3lab && cd s3lab && npm init -y && npm pkg set type=module
npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

Save `s3.js`, the one client every script shares:

```js
import { S3Client } from "@aws-sdk/client-s3";

export const Bucket = "linkbox";
export const s3 = new S3Client({
  region: "us-east-1",                  // MinIO ignores it, the SDK requires it
  endpoint: "http://localhost:9000",
  forcePathStyle: true,                 // http://host/bucket/key, not http://bucket.host/key
  credentials: { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" },
  requestChecksumCalculation: "WHEN_REQUIRED",  // see the note below
  responseChecksumValidation: "WHEN_REQUIRED",
});
```

Recent versions of the AWS SDK add CRC32 checksums to uploads by default. For a pre-signed URL that means signing the checksum of an *empty* body into the URL, so the real upload is rejected. `WHEN_REQUIRED` turns that off.

Save `sign.js`. It creates the bucket if needed and prints a signed PUT and GET for one key:

```js
import { CreateBucketCommand, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3, Bucket } from "./s3.js";

await s3.send(new CreateBucketCommand({ Bucket })).catch((e) => {
  if (!["BucketAlreadyOwnedByYou", "BucketAlreadyExists"].includes(e.name)) throw e;
});
const Key = process.argv[2] ?? "demo/hello.txt";
const put = await getSignedUrl(s3, new PutObjectCommand({ Bucket, Key, IfNoneMatch: "*" }), { expiresIn: 300 });
const get = await getSignedUrl(s3, new GetObjectCommand({ Bucket, Key }), { expiresIn: 300 });
console.log(`PUT='${put}'\nGET='${get}'`);
```

Now upload, read, read a range and try to overwrite:

```bash
eval "$(node sign.js demo/numbers.txt)"
seq 1 100000 > numbers.txt                         # about 590 KB
curl -i -X PUT -H "If-None-Match: *" -T numbers.txt "$PUT"     # 200, note the ETag
curl -s "$GET" | tail -n 2                         # 99999, 100000
curl -s -D - -o /dev/null -r 0-99 "$GET"           # 206 and Content-Range: bytes 0-99/...
curl -s -D - -o /dev/null -r 9999999- "$GET"       # 416 and Content-Range: bytes */...
curl -i -X PUT -H "If-None-Match: *" -T numbers.txt "$PUT"     # 412: the key exists
```

The `If-None-Match` header is part of the signature (look for `if-none-match` in `X-Amz-SignedHeaders`), so the client must send it, and it cannot quietly drop it to overwrite the file.

Then a multipart upload, five parts in flight. Save `multipart.js`:

```js
import { open, stat } from "node:fs/promises";
import {
  CreateMultipartUploadCommand, UploadPartCommand,
  CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { s3, Bucket } from "./s3.js";

const MiB = 1024 * 1024;
const file = process.argv[2];
const Key = `demo/${Date.now()}.bin`;
const { size } = await stat(file);
const partSize = Math.max(16 * MiB, Math.ceil(size / 10_000 / MiB) * MiB);
const count = Math.ceil(size / partSize);

const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key }));
const fh = await open(file);
const parts = [];
let next = 1;

async function worker() {
  while (next <= count) {
    const n = next++;                                // safe: JS runs one line at a time
    const start = (n - 1) * partSize;
    const buf = Buffer.alloc(Math.min(partSize, size - start));
    await fh.read(buf, 0, buf.length, start);
    const { ETag } = await s3.send(new UploadPartCommand({ Bucket, Key, UploadId, PartNumber: n, Body: buf }));
    parts[n - 1] = { PartNumber: n, ETag };
    console.log(`part ${n}/${count}`);
  }
}

try {
  await Promise.all(Array.from({ length: 5 }, worker));
  const done = await s3.send(new CompleteMultipartUploadCommand({
    Bucket, Key, UploadId, MultipartUpload: { Parts: parts },
  }));
  console.log("done", Key, done.ETag);               // note the "-N" suffix
} catch (err) {
  await s3.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }));
  throw err;
} finally {
  await fh.close();
}
```

```bash
head -c 200000000 /dev/urandom > big.bin   # 200 MB
node multipart.js big.bin                  # 11 parts of 16 MiB + a smaller 12th
```

Open the console at `http://localhost:9001` and look at the objects. Notice the "folders" under `demo/`.

Break it on purpose:

1. Change `16 * MiB` to `1 * MiB` and run `multipart.js` again. Which call fails, and with what error? (Parts below 5 MiB are rejected at `Complete`, not when you upload them.)
2. Kill `multipart.js` with Ctrl+C halfway through. The object doesn't appear in the console. Write a short script with `ListMultipartUploadsCommand` and find the upload that is still there, holding storage.
3. Generate a URL with `node sign.js`, wait more than five minutes, and use it. Read the error body.
4. Remove `requestChecksumCalculation` from `s3.js`, generate a new PUT URL and look for `x-amz-checksum-crc32` in it. Try the upload.

## Common mistakes

- **Buffering uploads in memory.** One large file, or many medium ones at once, takes the process down. Upload directly with pre-signed URLs, or at least stream.
- **Trusting the client after a direct upload.** The client says "I uploaded a 2 MB PDF". Check with `HeadObject` before marking it confirmed, and use a POST policy if size matters.
- **No lifecycle rule for incomplete multipart uploads.** Invisible parts pile up and are billed every month. Add `AbortIncompleteMultipartUpload` on day one.
- **Using the user's filename as the key.** Collisions, path tricks and leaked names. Generate the key from ids; keep the name in the database and in `Content-Disposition`.
- **Proxying downloads, or signing a fresh URL on every page view.** Proxying burns your bandwidth; fresh signatures defeat every cache. Redirect to signed URLs with a rounded signing time, or sign at the CDN.
- **Treating the ETag as an MD5.** Multipart and encrypted objects have ETags that are not the MD5 of the content. Store your own SHA-256 if you need a hash.

## Build: Linkbox, step 20

Give bookmarks file attachments, stored in S3-compatible storage, with no file bytes passing through the API.

1. Add the storage server from *Try it* to your `docker compose` setup and the S3 settings (endpoint, bucket, keys) to your config module (lesson 14). Create the bucket at startup if it doesn't exist.
2. Add a migration for `attachments`: `id`, `bookmark_id`, `user_id`, `key` (unique), `filename`, `content_type`, `size_bytes`, `upload_id` (nullable), `status` (`pending` or `confirmed`, with a `CHECK`), `created_at`, `confirmed_at`.
3. `POST /api/v1/bookmarks/:id/attachments` with `{ filename, contentType, size }`: check the user owns the bookmark, allow only a short list of types, reject anything over 25 MB here (bigger files go to step 6), insert a `pending` row with key `users/{userId}/attachments/{attachmentId}`, and return a pre-signed `PUT` (5-minute expiry, `Content-Type` signed) or a POST policy.
4. `POST /api/v1/attachments/:id/confirm`: `HeadObject` the key, check that size and type match the row, then set `status = 'confirmed'`. Return `409` if the object isn't there yet.
5. `GET /api/v1/attachments/:id`: owner check, then `302` to a pre-signed `GET` with `ResponseContentDisposition` carrying the original filename. Only `confirmed` attachments are served.
6. Large files: `POST /api/v1/bookmarks/:id/attachments/multipart` creates the upload and returns `uploadId`, `partSize` and `partCount`; `POST .../parts` signs a batch of part URLs; `POST .../complete` calls `ListParts` and `CompleteMultipartUpload` and confirms; `DELETE` aborts.
7. Cleanup: a scheduled BullMQ job (lesson 11) every hour deletes `pending` rows older than 24 hours, deleting the object or aborting the multipart upload first. Deleting a bookmark deletes its attachments' objects.

**Done when** you can upload a small file with `curl` through the signed URL and confirm it, download it through the `302` with its original filename, upload a 200 MB file in parts, and watch the cleanup job remove a `pending` attachment you never uploaded.

## Check yourself

<details markdown="1">
<summary>Why does saving uploads to the local disk break when you run three instances?</summary>

The file exists only on the instance that received it. The load balancer sends the next request to any instance, so two out of three reads fail. The disk is also wiped when the container is replaced. Object storage gives every instance the same shared, durable place to read from.
</details>

<details markdown="1">
<summary>Erasure coding 10 + 4 uses 1.4× storage. How many shards can be lost, and why is that better than 3× replication?</summary>

Any 4 of the 14 shards can be lost, because any 10 rebuild the data. 3× replication survives only 2 losses and uses 3× storage. The price of erasure coding is CPU and extra reads when rebuilding.
</details>

<details markdown="1">
<summary>A pre-signed PUT URL was signed for a 1 MB avatar. What stops a user from uploading 5 GB with it?</summary>

Nothing in the URL itself: a pre-signed PUT doesn't limit size. Use a POST policy with `content-length-range`, or check the size with `HeadObject` after upload and delete the object if it is too big.
</details>

<details markdown="1">
<summary>Your uploader always uses 5 MiB parts. What is the largest file it can upload, and how should it pick the part size?</summary>

10,000 × 5 MiB ≈ 48.8 GiB. It should use at least `ceil(size / 10,000)`, rounded up, and in practice something like 16 MiB or more for big files.
</details>

<details markdown="1">
<summary>Two uploads of the same file have different ETags. Is the file corrupted?</summary>

Probably not. A multipart ETag is the MD5 of the part MD5s plus a part count, so it depends on how the file was split. Compare a SHA-256 you computed yourself, or S3's checksums, instead.
</details>

<details markdown="1">
<summary>Why does a CDN in front of pre-signed GET URLs barely help, and what can you do?</summary>

Each signature includes a timestamp and differs per request, so every URL is a new cache key. Round the signing time to a fixed window (the SDK's `signingDate`) so URLs repeat, or have the CDN check access with its own signed URLs or cookies and cache by plain path.
</details>

## Go deeper

- [Amazon S3: Uploading and copying objects using multipart upload](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html): the full multipart flow, limits, and how checksums and aborts work.
- [Amazon S3: Conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html): `If-None-Match`, `If-Match`, and exactly when you get 412, 409 or 404.
- [Amazon S3: Download and upload objects with presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html): who can sign, how long URLs last, and how expiry interacts with temporary credentials.
- [Andy Warfield: Building and operating a pretty big storage system called S3](https://www.allthingsdistributed.com/2023/07/building-and-operating-a-pretty-big-storage-system.html): an S3 engineer on hard drives, erasure coding and durability at scale.
- [RFC 9110, section 14: Range requests](https://www.rfc-editor.org/rfc/rfc9110#name-range-requests): the source for `Range`, `206`, `Content-Range`, `If-Range` and `416`.
- [RFC 8216: HTTP Live Streaming](https://datatracker.ietf.org/doc/html/rfc8216): how HLS playlists and segments are defined.
